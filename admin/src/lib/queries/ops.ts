// Reads of the two tables the backend cron writes (`system_status`,
// `metrics_snapshots`, migration 0067). The admin already reads this database
// read-only, so the ops view needs no API token and no production-only path — it
// works the moment the cron has run once, including in local dev.
//
// The shapes here mirror `backend/src/observability/ops-metrics.ts`. They are
// separate packages, so this is a copy by necessity; the values are JSON in a D1
// column and every field is treated as possibly absent, which is what keeps a
// backend that adds or drops a field from breaking the dashboard.

export interface PollerStatusValue {
  lagMs: number | null;
  lastPollAt: number | null;
  lastPollDurationMs: number | null;
  processed: number;
  errors: number;
  alarmScheduled: boolean;
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
  documentFirehoseHealthy?: boolean | null;
  documentFirehoseConnected?: boolean | null;
  documentAuthorsActive?: number;
  documentAuthorsFrozen?: number;
  documentAuthorsInBackoff?: number;
}

export interface StatusRow<T> {
  value: T;
  updatedAt: number;
}

export interface OpsStatus {
  cron: StatusRow<CronLastRunValue> | null;
  poller: StatusRow<PollerStatusValue> | null;
  proxy: StatusRow<ProxyStatsValue> | null;
}

function parse<T>(row: { value: string; updated_at: number } | undefined): StatusRow<T> | null {
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as T, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export async function getOpsStatus(db: D1Database): Promise<OpsStatus> {
  const result = await db
    .prepare('SELECT key, value, updated_at FROM system_status')
    .all<{ key: string; value: string; updated_at: number }>();

  const byKey = new Map(result.results.map((r) => [r.key, r]));
  return {
    cron: parse<CronLastRunValue>(byKey.get('cron_last_run')),
    poller: parse<PollerStatusValue>(byKey.get('poller_status')),
    proxy: parse<ProxyStatsValue>(byKey.get('proxy_stats')),
  };
}

export interface SnapshotRow {
  captured_at: number;
  users: number;
  feeds: number;
  feed_items: number;
  subscriptions: number;
  saved_articles: number;
  /** The proxy's `feedsInError` at that hour; null when the proxy row was stale. */
  feeds_with_errors: number | null;
  active_sessions: number;
  firehose_lag_ms: number | null;
  proxy_fresh_pct: number | null;
}

/**
 * Hourly points, oldest first. 30 days by default: enough to see a trend, few
 * enough points (~720) that the sparklines stay a cheap inline SVG.
 */
export async function getSnapshots(db: D1Database, days = 30): Promise<SnapshotRow[]> {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await db
    .prepare('SELECT * FROM metrics_snapshots WHERE captured_at >= ? ORDER BY captured_at ASC')
    .bind(since)
    .all<SnapshotRow>();
  return result.results;
}
