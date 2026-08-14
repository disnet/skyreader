/**
 * Shared client for constellation.microcosm.blue, with a circuit breaker.
 *
 * Mentions counts (mentions.ts), link-post social context (constellation.ts),
 * lane expansion (mention-lane.ts) and the linkblog registry
 * (linkblog-registry.ts) all query the same Constellation host, and all of them
 * are *adornments* that degrade to empty on failure. The risk isn't a single
 * failed call — it's that Constellation slowing down makes every call wait out
 * the full 10 s timeout, and with the warm loop pre-fetching mentions for up
 * to 25 items × 200 feeds per tick that fan-out ties up the single machine in
 * dead waits.
 *
 * Three mechanisms, in the order a request meets them:
 *
 * 1. **Circuit breaker** (module-level, one host, shared across all callers) so
 *    a Constellation outage backs every caller off together: after a run of
 *    timeouts / 5xx / network errors it opens, and calls short-circuit to `null`
 *    immediately for a cooldown instead of each eating a 10 s timeout. A clean
 *    4xx is a definitive "no data" answer (the service is healthy), so it does
 *    NOT count toward the breaker.
 * 2. **Concurrency cap**, because nothing else bounds our fan-out: the warm loop
 *    refreshes 8 feeds at once, each firing up to 25 mention enrichments, each of
 *    which issues up to 12 parallel per-source queries. Unbounded, that's
 *    hundreds of simultaneous sockets against a small community-run service,
 *    which sheds load by resetting connections — i.e. we cause the very errors we
 *    then have to absorb. Queue overflow returns `null` *without* counting a
 *    breaker failure: that's our own backpressure, not a Constellation health
 *    signal.
 * 3. **One retry on connection resets.** Constellation (or a proxy in front of
 *    it) idle-closes pooled keep-alive sockets; when Bun's fetch reuses one it
 *    fails with ECONNRESET / "socket connection was closed unexpectedly" before
 *    the request is served. These GETs are idempotent, so a single retry turns
 *    that into a success. Timeouts are NOT retried — the caller already waited
 *    10 s, and the breaker is the right tool for a slow service.
 *
 * Breaker, semaphore and counters are per-process module state. That's exactly
 * right on today's single Fly machine; a multi-machine deploy would get one
 * breaker *per machine*, not global coordination.
 */

import { OverloadError, Semaphore } from './semaphore';

const CONSTELLATION_BASE = 'https://constellation.microcosm.blue';
const HEADERS = { 'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)' };
const FETCH_TIMEOUT_MS = 10 * 1000;

// Consecutive tripping failures before the breaker opens, and how long it stays
// open before the next call is allowed through to probe recovery.
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30 * 1000;

// Concurrent requests allowed against the host, and how many callers may park
// waiting. The queue is generous because every caller is fire-and-forget or
// already tolerant of a 10 s wait; it exists to bound memory, not latency.
const DEFAULT_CONCURRENCY = parseInt(process.env.CONSTELLATION_CONCURRENCY || '6', 10);
const DEFAULT_QUEUE_MAX = parseInt(process.env.CONSTELLATION_QUEUE_MAX || '200', 10);

// Backoff before the single retry, jittered so a burst of resets (the common
// case — a pool of pooled sockets goes stale together) doesn't re-collide.
const RETRY_DELAY_MS = 250;
const RETRY_JITTER_MS = 100;

// An outage otherwise logs one line per failed call; the warm loop makes that
// thousands. Log the first failure of a streak, then every Nth with a count.
const LOG_EVERY_N_FAILURES = 25;

let consecutiveFailures = 0;
let openUntil = 0;
let failureStreak = 0;
let semaphore = new Semaphore(DEFAULT_CONCURRENCY, DEFAULT_QUEUE_MAX);

const counters = {
  /** Logical calls that reached the network (breaker closed, permit acquired). */
  requests: 0,
  /** Connection resets seen (both attempts of a retried call count once each). */
  resets: 0,
  /** Retries attempted after a reset. */
  retries: 0,
  /** Retries that then succeeded — the errors this hardening absorbs. */
  retriesRecovered: 0,
  /** Logical calls that counted a breaker failure. */
  failures: 0,
  /** Calls dropped by our own backpressure (queue full). */
  shed: 0,
  /** Times the breaker transitioned to open. */
  breakerOpens: 0,
  /** Calls short-circuited because the breaker was open. */
  shortCircuited: 0,
};

/** True while the breaker is open (calls short-circuit to null). */
export function isConstellationBreakerOpen(now: number = Date.now()): boolean {
  return now < openUntil;
}

/** Test/ops hook: clear breaker state and counters. */
export function resetConstellationBreaker(): void {
  consecutiveFailures = 0;
  openUntil = 0;
  failureStreak = 0;
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
}

/**
 * Test hook: resize the concurrency gate. Production sets it once from env at
 * module load — this exists so tests can exercise the cap and the shed path
 * without firing hundreds of calls. Only safe with nothing in flight.
 */
export function setConstellationLimits(
  concurrency: number = DEFAULT_CONCURRENCY,
  maxQueue: number = DEFAULT_QUEUE_MAX
): void {
  semaphore = new Semaphore(concurrency, maxQueue);
}

/** Snapshot for /stats: what the breaker, the gate and the retry path are doing. */
export function getConstellationStats(): {
  breakerOpen: boolean;
  consecutiveFailures: number;
  inUse: number;
  queued: number;
} & typeof counters {
  return {
    breakerOpen: isConstellationBreakerOpen(),
    consecutiveFailures,
    inUse: semaphore.inUse,
    queued: semaphore.queued,
    ...counters,
  };
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  openUntil = 0;
  failureStreak = 0;
}

function recordFailure(now: number): void {
  counters.failures++;
  consecutiveFailures++;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    openUntil = now + BREAKER_COOLDOWN_MS;
    counters.breakerOpens++;
    // Reset the counter so the cooldown is the gate; the first failure after it
    // expires re-opens the breaker rather than tripping instantly.
    consecutiveFailures = 0;
    console.warn(
      `[constellation] circuit breaker OPEN for ${BREAKER_COOLDOWN_MS / 1000}s ` +
        `after ${BREAKER_THRESHOLD} consecutive failures`
    );
  }
}

/** First failure of a streak logs in full; the rest are summarised periodically. */
function logFailure(path: string, error: unknown): void {
  failureStreak++;
  if (failureStreak === 1) {
    console.error(`[constellation] ${path} error:`, error);
  } else if (failureStreak % LOG_EVERY_N_FAILURES === 0) {
    console.error(`[constellation] ${failureStreak} consecutive failures (latest ${path}):`, error);
  }
}

/**
 * Is this a mid-flight connection reset — the stale-keep-alive shape that a
 * retry fixes? Deliberately defensive about Bun's error shapes: it surfaces
 * these as `code: 'ECONNRESET'` on some paths and as a bare message on others,
 * and the wording has moved between releases. A shape we don't recognise simply
 * doesn't retry (today's behavior), never crashes.
 *
 * Timeouts (`TimeoutError` from AbortSignal.timeout) and caller aborts are
 * excluded on purpose: waiting another 10 s helps nobody.
 */
function isRetryableConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code, message } = error as { name?: string; code?: unknown; message?: unknown };
  if (name === 'TimeoutError' || name === 'AbortError') return false;
  if (typeof code === 'string' && ['ECONNRESET', 'EPIPE', 'ConnectionClosed'].includes(code)) {
    return true;
  }
  if (typeof message !== 'string') return false;
  const text = message.toLowerCase();
  return (
    text.includes('socket connection was closed') ||
    text.includes('connection closed') ||
    text.includes('connection reset') ||
    text.includes('econnreset') ||
    text.includes('epipe')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One network attempt. Returns the parsed body, or a verdict for the caller:
 * `retry` for a connection reset (worth one more go), `fail` for anything that
 * should count toward the breaker, `null-ok` for a definitive 4xx.
 */
type Attempt<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'null-ok' }
  | { kind: 'fail'; error?: unknown }
  | { kind: 'retry'; error: unknown };

async function attempt<T>(url: string): Promise<Attempt<T>> {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 5xx / 429 → the service itself is unhealthy; count toward the breaker.
      // Any other non-OK (e.g. 400/404) is a definitive answer from a healthy
      // service — return null without tripping the breaker.
      if (res.status >= 500 || res.status === 429) {
        return { kind: 'fail', error: `HTTP ${res.status}` };
      }
      return { kind: 'null-ok' };
    }
    return { kind: 'ok', data: (await res.json()) as T };
  } catch (error) {
    if (isRetryableConnectionError(error)) {
      counters.resets++;
      return { kind: 'retry', error };
    }
    return { kind: 'fail', error };
  }
}

/**
 * GET a Constellation endpoint and parse JSON, or return null. Never throws —
 * every failure (breaker open, overload, timeout, network, non-OK, parse)
 * degrades to null so callers stay best-effort.
 *
 * A reset-then-success sequence counts as one success; a reset-then-reset
 * sequence counts as exactly *one* breaker failure, so the threshold still
 * means "5 logical calls failed", not "5 sockets died".
 */
export async function constellationGet<T>(
  path: string,
  params: Record<string, string>
): Promise<T | null> {
  if (isConstellationBreakerOpen()) {
    counters.shortCircuited++;
    return null;
  }

  const qs = new URLSearchParams(params);
  const url = `${CONSTELLATION_BASE}${path}?${qs}`;

  try {
    await semaphore.acquire();
  } catch (error) {
    if (error instanceof OverloadError) {
      // Our own backpressure, not a Constellation health signal — no breaker
      // failure, and the count in /stats is the signal worth looking at.
      counters.shed++;
      if (counters.shed === 1 || counters.shed % LOG_EVERY_N_FAILURES === 0) {
        console.warn(`[constellation] shed ${counters.shed} request(s): queue full (${path})`);
      }
      return null;
    }
    throw error;
  }

  try {
    counters.requests++;
    let result = await attempt<T>(url);

    if (result.kind === 'retry') {
      counters.retries++;
      await sleep(RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MS);
      const first = result.error;
      result = await attempt<T>(url);
      if (result.kind === 'ok') {
        counters.retriesRecovered++;
        console.warn(`[constellation] ${path} connection reset, retry succeeded`);
      } else if (result.kind === 'retry') {
        // Two resets in a row: one logical failure, keeping the first error for
        // context (it's the one that names the socket that died first).
        result = { kind: 'fail', error: result.error ?? first };
      }
    }

    switch (result.kind) {
      case 'ok':
        recordSuccess();
        return result.data;
      case 'null-ok':
        recordSuccess();
        return null;
      default:
        recordFailure(Date.now());
        logFailure(path, result.error);
        return null;
    }
  } finally {
    semaphore.release();
  }
}
