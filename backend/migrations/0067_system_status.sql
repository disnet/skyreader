-- Observability phase 2. Two tables, two jobs.
--
-- `system_status` is the point-in-time board: one row per key, overwritten by the
-- every-minute cron. It exists so the admin — which already reads this database
-- read-only — can show cron liveness, firehose lag and proxy cache health with no
-- new API, no new token, and no behaviour that only works in production.
--
-- `metrics_snapshots` is the history behind it: one row per hour, pruned at 90
-- days by the same job that writes it. `captured_at` is the *start of the hour* in
-- unix ms and the INTEGER PRIMARY KEY (so it is the rowid — range scans by time
-- are free and need no second index), which makes an hourly write idempotent: a
-- cron that runs twice in one hour replaces its row instead of duplicating it.
-- Nullable columns are the values that can genuinely be unknown (no cursor yet,
-- proxy unreachable) — recording a null is honest, recording a 0 is a lie.
CREATE TABLE system_status (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE metrics_snapshots (
  captured_at INTEGER PRIMARY KEY,
  users INTEGER NOT NULL,
  feeds INTEGER NOT NULL,
  feed_items INTEGER NOT NULL,
  subscriptions INTEGER NOT NULL,
  saved_articles INTEGER NOT NULL,
  feeds_with_errors INTEGER NOT NULL,
  active_sessions INTEGER NOT NULL,
  firehose_lag_ms INTEGER,
  proxy_fresh_pct REAL
);
