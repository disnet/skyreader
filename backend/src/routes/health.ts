import type { Env } from '../types';
import { checkRateLimit } from '../services/rate-limit';
import { ALARM_ACTIVE_WINDOW_MS } from '../durable-objects/jetstream-poller';

// Two health endpoints with deliberately different jobs:
//
// - `/api/health` is shallow and unauthenticated. It touches nothing — no D1, no
//   DO, no proxy — so an uptime poller can hit it every 30s forever without
//   costing anything or becoming an amplification vector. It answers exactly one
//   question: is this Worker serving, and which build is it serving?
// - `/api/health/deep` does the real dependency checks and is therefore gated by
//   a shared secret and rate-limited.

const DEEP_HEALTH_PATH = '/api/health/deep';

// The poller's alarm re-arms every 60s. Anything past 5 minutes without a
// completed poll means it's wedged, not merely between cycles.
const POLLER_STALE_MS = 5 * 60 * 1000;

// Dependency checks are for a monitor with a timeout of its own; fail fast rather
// than hang.
const DEPENDENCY_TIMEOUT_MS = 3000;

export function getVersion(env: Env): string {
  return env.GIT_COMMIT_SHA || 'dev';
}

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Health answers are never cacheable — a cached 200 defeats the point.
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * Shallow liveness. Dependency-free by design — see the note above.
 */
export function handleHealth(env: Env): Response {
  return json({
    status: 'ok',
    version: getVersion(env),
    timestamp: Date.now(),
  });
}

// Constant-time compare so the secret can't be recovered by timing the response.
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

interface CheckResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

function failed(error: unknown): CheckResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function checkDatabase(env: Env): Promise<CheckResult> {
  const start = Date.now();
  try {
    await withTimeout(env.DB.prepare('SELECT 1').first(), DEPENDENCY_TIMEOUT_MS, 'D1');
    return { ok: true, durationMs: Date.now() - start };
  } catch (error) {
    return { ...failed(error), durationMs: Date.now() - start };
  }
}

// The DO has maintained this state all along behind an internal /status endpoint
// that nothing called. Reading it here is what turns firehose staleness into a
// signal instead of a surprise.
async function checkPoller(env: Env): Promise<CheckResult> {
  try {
    const pollerId = env.JETSTREAM_POLLER.idFromName('main-v2');
    const poller = env.JETSTREAM_POLLER.get(pollerId);
    const response = await withTimeout<Response>(
      poller.fetch('http://internal/status'),
      DEPENDENCY_TIMEOUT_MS,
      'JetstreamPoller /status'
    );
    if (!response.ok) {
      return { ok: false, error: `status endpoint returned ${response.status}` };
    }

    const status = (await response.json()) as {
      lastStats?: { lastPollAt?: number; duration?: number };
      nextPoll?: number | null;
      isRunning?: boolean;
      lastAlarmStart?: number | null;
    };

    const lastPollAt = status.lastStats?.lastPollAt;
    const lastPollAgeMs = typeof lastPollAt === 'number' ? Date.now() - lastPollAt : null;
    // A DO that has just been created has no completed poll yet; treat "scheduled
    // and not yet run" as healthy rather than paging on a cold start.
    const fresh = lastPollAgeMs === null || lastPollAgeMs < POLLER_STALE_MS;

    // `isRunning` is `!!getAlarm()`, which the DO reports as false for the whole
    // time the alarm handler is executing — 5–16s of every 60s cycle. Probing in
    // that window is likely, not exotic, so mirror the recency rule the DO's own
    // /start branch uses instead of paging on a healthy poller mid-poll. Staleness
    // is still caught: lastPollAgeMs is the signal that actually means "wedged".
    const alarmStart = typeof status.lastAlarmStart === 'number' ? status.lastAlarmStart : null;
    const recentlyActive = alarmStart !== null && Date.now() - alarmStart < ALARM_ACTIVE_WINDOW_MS;
    const running = Boolean(status.isRunning) || recentlyActive;

    return {
      ok: running && fresh,
      isRunning: running,
      alarmScheduled: Boolean(status.isRunning),
      lastAlarmAgeMs: alarmStart === null ? null : Date.now() - alarmStart,
      lastPollAgeMs,
      nextPoll: status.nextPoll ?? null,
    };
  } catch (error) {
    return failed(error);
  }
}

async function checkFeedProxy(env: Env): Promise<CheckResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${env.FEED_PROXY_URL}/health`, {
      signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `health returned ${response.status}`,
        durationMs: Date.now() - start,
      };
    }
    const body = (await response.json()) as { cachedFeeds?: number; version?: string };
    return {
      ok: true,
      durationMs: Date.now() - start,
      cachedFeeds: body.cachedFeeds ?? null,
      version: body.version ?? null,
    };
  } catch (error) {
    return { ...failed(error), durationMs: Date.now() - start };
  }
}

/**
 * Deep health: one URL that answers "is everything up". Returns 503 when any
 * dependency is unhealthy so an uptime monitor alerts on it directly.
 */
export async function handleDeepHealth(request: Request, env: Env): Promise<Response> {
  const expected = env.HEALTH_CHECK_SECRET;
  if (!expected) {
    // Fail closed. Without the secret this endpoint would be an unauthenticated
    // way to make the Worker fan out to D1, a DO, and the proxy on every request.
    return json({ status: 'unconfigured', error: 'HEALTH_CHECK_SECRET is not set' }, 503);
  }

  // Secret first, rate limit second: the secret check is pure CPU, so an
  // unauthenticated flood is rejected without a single D1 write. Rate limiting
  // then bounds how much real dependency work an authorized caller can trigger.
  const provided = request.headers.get('X-Health-Secret') ?? '';
  if (!secretsMatch(provided, expected)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimit = await checkRateLimit(env, `health:${ip}`, DEEP_HEALTH_PATH);
  if (!rateLimit.allowed) {
    return json({ error: 'Rate limit exceeded' }, 429, {
      'Retry-After': String(rateLimit.retryAfter || 60),
    });
  }

  const [database, poller, feedProxy] = await Promise.all([
    checkDatabase(env),
    checkPoller(env),
    checkFeedProxy(env),
  ]);

  const healthy = database.ok && poller.ok && feedProxy.ok;

  return json(
    {
      status: healthy ? 'ok' : 'degraded',
      version: getVersion(env),
      timestamp: Date.now(),
      checks: { database, poller, feedProxy },
    },
    healthy ? 200 : 503
  );
}
