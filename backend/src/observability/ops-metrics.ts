import type { Env } from '../types';
import { log, serializeError } from '../utils/logger';
import { reportError, reportMessage } from './sentry';

// The cron's second job: leave behind what it learned.
//
// Every minute the cron already talks to the JetstreamPoller DO. That call knows
// the firehose lag, the last poll's error counts and whether the alarm is armed —
// and until now it threw all of it away. Here it lands in D1, where the admin
// (already a read-only reader of this database) can render it without a new API,
// a new token, or an integration that only works against production.
//
// Two shapes, deliberately different:
//   - `system_status` — the current board. One row per key, overwritten each run.
//     Reading it answers "is it healthy *now*".
//   - `metrics_snapshots` — one row per hour, pruned at 90 days. Reading it
//     answers "which way is it trending", the question point-in-time counts can't.
//
// Nothing here may fail the cron. A recording failure is a loss of visibility,
// not of service; callers log it and move on (see the note at the cron site).

export type SystemStatusKey = 'cron_last_run' | 'poller_status' | 'proxy_stats';

/** Lag past this and the firehose is not "catching up", it's stuck. */
export const FIREHOSE_LAG_ALERT_MS = 15 * 60 * 1000;

/**
 * The cron re-checks lag every minute; without this, a stuck firehose would send
 * an event a minute for as long as it stayed stuck. One event, then a reminder
 * every half hour while the condition persists.
 */
export const FIREHOSE_LAG_REALERT_MS = 30 * 60 * 1000;

/** The proxy is a different host on a different cloud; fail fast, don't hang. */
const PROXY_STATS_TIMEOUT_MS = 3000;

const HOUR_MS = 60 * 60 * 1000;
export const SNAPSHOT_RETENTION_MS = 90 * 24 * HOUR_MS;

/**
 * How stale a `system_status` row may be before a snapshot records null instead
 * of its value. Poller status is written every minute and proxy stats every five,
 * so anything older than this is a value nobody refreshed — carrying it into an
 * hourly point would draw a flat line through an outage.
 */
const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

export interface StatusRow<T> {
  value: T;
  updatedAt: number;
}

export interface PollerStatusValue {
  /** How far behind the firehose is — see `streamLagMs` in the poller. */
  lagMs: number | null;
  lastPollAt: number | null;
  lastPollDurationMs: number | null;
  processed: number;
  errors: number;
  alarmScheduled: boolean;
  /** When the lag alert last fired. Dedupe state, not a display value. */
  lagAlertAt: number | null;
}

export interface CronLastRunValue {
  at: number;
  cron: string;
  healthy: boolean;
  durationMs: number;
  version: string;
}

export interface ProxyStatsValue {
  total: number;
  fresh: number;
  stale: number;
  freshPct: number | null;
  inFlight: number;
  feedsInError: number;
  feedsInBackoff: number;
  feedsPermanentlyFailed: number;
  cacheTtlSeconds: number | null;
}

export async function writeSystemStatus(
  env: Env,
  key: SystemStatusKey,
  value: unknown,
  now = Date.now()
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_status (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, JSON.stringify(value), now)
    .run();
}

export async function readSystemStatus<T>(
  env: Env,
  key: SystemStatusKey
): Promise<StatusRow<T> | null> {
  const row = await env.DB.prepare('SELECT value, updated_at FROM system_status WHERE key = ?')
    .bind(key)
    .first<{ value: string; updated_at: number }>();
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as T, updatedAt: row.updated_at };
  } catch {
    // A row we can't parse is a row we can't trust; treat it as absent rather
    // than throwing inside a cron phase.
    return null;
  }
}

interface PollerStatusResponse {
  lag?: { subscriptionsMs?: number | null };
  lastStats?: {
    subscriptions?: { processed?: number; errors?: number };
    duration?: number;
    lastPollAt?: number;
  };
  nextPoll?: number | null;
  isRunning?: boolean;
}

export interface LagAlertDecision {
  /** Send an event now. */
  alert: boolean;
  /** Lag was high last time we looked and no longer is. */
  recovered: boolean;
  /** The dedupe stamp to persist. */
  lagAlertAt: number | null;
}

/**
 * Pure so the "alerts once, reminds at the re-alert interval, resets on recovery"
 * behaviour can be tested without a clock or a database.
 */
export function decideLagAlert(
  lagMs: number | null,
  previousAlertAt: number | null,
  now: number
): LagAlertDecision {
  // Unknown lag (no cursor yet) is not high lag. A DO that has never polled
  // should not page; the cron heartbeat and deep health cover "poller is dead".
  if (lagMs === null || lagMs <= FIREHOSE_LAG_ALERT_MS) {
    return { alert: false, recovered: previousAlertAt !== null, lagAlertAt: null };
  }
  if (previousAlertAt === null || now - previousAlertAt >= FIREHOSE_LAG_REALERT_MS) {
    return { alert: true, recovered: false, lagAlertAt: now };
  }
  return { alert: false, recovered: false, lagAlertAt: previousAlertAt };
}

/**
 * Read the poller's own status, store it, and push an alert when the firehose has
 * fallen far enough behind that waiting for someone to open the admin isn't good
 * enough.
 */
export async function recordPollerStatus(env: Env, now = Date.now()): Promise<PollerStatusValue> {
  const pollerId = env.JETSTREAM_POLLER.idFromName('main-v2');
  const poller = env.JETSTREAM_POLLER.get(pollerId);
  const response = await poller.fetch('http://internal/status');
  if (!response.ok) {
    throw new Error(`JetstreamPoller /status returned ${response.status}`);
  }
  const status = (await response.json()) as PollerStatusResponse;

  const lagMs = status.lag?.subscriptionsMs ?? null;

  const previous = await readSystemStatus<PollerStatusValue>(env, 'poller_status');
  const decision = decideLagAlert(lagMs, previous?.value.lagAlertAt ?? null, now);

  const value: PollerStatusValue = {
    lagMs,
    lastPollAt: status.lastStats?.lastPollAt ?? null,
    lastPollDurationMs: status.lastStats?.duration ?? null,
    processed: status.lastStats?.subscriptions?.processed ?? 0,
    errors: status.lastStats?.subscriptions?.errors ?? 0,
    alarmScheduled: Boolean(status.isRunning),
    lagAlertAt: decision.lagAlertAt,
  };

  await writeSystemStatus(env, 'poller_status', value, now);

  if (decision.alert) {
    log.error('firehose_lag_high', {
      lagMs,
      thresholdMs: FIREHOSE_LAG_ALERT_MS,
      lastPollAt: value.lastPollAt,
    });
    reportMessage(`Firehose lag above ${Math.round(FIREHOSE_LAG_ALERT_MS / 60000)}m`, {
      level: 'error',
      // One issue for the condition, not one per occurrence.
      fingerprint: ['firehose-lag-high'],
      tags: { source: 'cron', check: 'firehose-lag' },
      extra: { lagMs, lastPollAt: value.lastPollAt },
    });
  } else if (decision.recovered) {
    log.info('firehose_lag_recovered', { lagMs, thresholdMs: FIREHOSE_LAG_ALERT_MS });
  }

  return value;
}

interface ProxyStatsResponse {
  total?: number;
  fresh?: number;
  stale?: number;
  inFlight?: number;
  cacheTtlSeconds?: number;
  errors?: { total?: number; inBackoff?: number; permanent?: number };
}

/**
 * Pull the proxy's cache stats across. Runs on its own cadence rather than every
 * minute — it's a cross-cloud fetch, and the cron's minute is not infinite (see
 * the cron-budget risk in the plan).
 */
export async function recordProxyStats(env: Env, now = Date.now()): Promise<ProxyStatsValue> {
  if (!env.FEED_PROXY_URL) {
    throw new Error('FEED_PROXY_URL is not set');
  }
  const headers: Record<string, string> = {};
  if (env.FEED_PROXY_SECRET) headers['X-Proxy-Secret'] = env.FEED_PROXY_SECRET;

  const response = await fetch(`${env.FEED_PROXY_URL}/stats`, {
    headers,
    signal: AbortSignal.timeout(PROXY_STATS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`feed proxy /stats returned ${response.status}`);
  }
  const stats = (await response.json()) as ProxyStatsResponse;

  const total = stats.total ?? 0;
  const fresh = stats.fresh ?? 0;
  const value: ProxyStatsValue = {
    total,
    fresh,
    stale: stats.stale ?? 0,
    // Percentage of a zero-feed cache is undefined, not 0% and not 100%.
    freshPct: total > 0 ? Math.round((fresh / total) * 1000) / 10 : null,
    inFlight: stats.inFlight ?? 0,
    feedsInError: stats.errors?.total ?? 0,
    feedsInBackoff: stats.errors?.inBackoff ?? 0,
    feedsPermanentlyFailed: stats.errors?.permanent ?? 0,
    cacheTtlSeconds: stats.cacheTtlSeconds ?? null,
  };

  await writeSystemStatus(env, 'proxy_stats', value, now);
  return value;
}

export async function recordCronRun(
  env: Env,
  run: { cron: string; healthy: boolean; durationMs: number },
  now = Date.now()
): Promise<void> {
  const value: CronLastRunValue = {
    at: now,
    cron: run.cron,
    healthy: run.healthy,
    durationMs: run.durationMs,
    version: env.GIT_COMMIT_SHA || 'dev',
  };
  await writeSystemStatus(env, 'cron_last_run', value, now);
}

/**
 * One row per hour: the counts the admin shows as tiles, plus the three health
 * numbers that only exist in `system_status` (firehose lag, proxy cache
 * freshness, feeds the crawler has in error). Same job prunes the tail, so the
 * table can't grow without an owner.
 */
export async function writeMetricsSnapshot(env: Env, now = Date.now()): Promise<void> {
  // Bucket to the top of the hour so a cron that fires twice in one hour replaces
  // its point instead of drawing two.
  const capturedAt = Math.floor(now / HOUR_MS) * HOUR_MS;
  const sessionCutoff = Math.floor(now / 1000);

  const counts = await env.DB.batch<{ count: number }>([
    env.DB.prepare('SELECT COUNT(*) AS count FROM users'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM feeds'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM feed_items'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM subscriptions_cache'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM saved_articles'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?').bind(
      sessionCutoff
    ),
  ]);
  const at = (index: number) => counts[index]?.results?.[0]?.count ?? 0;

  const [poller, proxy] = await Promise.all([
    readSystemStatus<PollerStatusValue>(env, 'poller_status'),
    readSystemStatus<ProxyStatsValue>(env, 'proxy_stats'),
  ]);
  const usable = <T>(row: StatusRow<T> | null): T | null =>
    row && now - row.updatedAt <= SNAPSHOT_MAX_AGE_MS ? row.value : null;

  // Per-feed fetch errors live in the crawler, not in D1: `feeds` carries ingest
  // metadata only. So the trend point reads the same number the live tile does,
  // and is null — not 0 — when the proxy row is missing or stale (see 0069).
  const feedsWithErrors = usable(proxy)?.feedsInError ?? null;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO metrics_snapshots
       (captured_at, users, feeds, feed_items, subscriptions, saved_articles,
        feeds_with_errors, active_sessions, firehose_lag_ms, proxy_fresh_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      capturedAt,
      at(0),
      at(1),
      at(2),
      at(3),
      at(4),
      feedsWithErrors,
      at(5),
      usable(poller)?.lagMs ?? null,
      usable(proxy)?.freshPct ?? null
    )
    .run();

  const pruned = await env.DB.prepare('DELETE FROM metrics_snapshots WHERE captured_at < ?')
    .bind(capturedAt - SNAPSHOT_RETENTION_MS)
    .run();

  log.info('metrics_snapshot', {
    capturedAt,
    users: at(0),
    feeds: at(1),
    feedsWithErrors,
    prunedRows: pruned.meta?.changes ?? 0,
  });
}

/**
 * Run one recording step. Visibility work never decides whether the cron was
 * healthy: a failed D1 write here loses a data point, and paging for that would
 * be the alert fatigue the plan warns about. The error still reaches Sentry and
 * the logs, and a D1 outage broad enough to matter fails the cleanup phases,
 * which *do* withhold the heartbeat.
 */
export async function runRecordingStep(name: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    log.error('ops_metrics_failed', { step: name, ...serializeError(error) });
    reportError(error, { tags: { source: 'cron', phase: `ops-metrics:${name}` } });
  }
}
