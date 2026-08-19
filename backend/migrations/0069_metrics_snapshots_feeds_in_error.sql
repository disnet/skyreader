-- `feeds_with_errors` loses its NOT NULL, because its source changed.
--
-- It used to be `SELECT COUNT(*) FROM feed_metadata WHERE error_count > 0` — a
-- local count that always had an answer. 0068 drops `feed_metadata`: the new
-- `feeds` table carries ingest metadata only (`last_ingest_at`), and per-feed
-- fetch errors now live where the fetching happens, in the crawler. The hourly
-- snapshot therefore reads the same number the live tile does, the proxy's
-- `feedsInError`, out of the `proxy_stats` row the cron writes every 5 minutes.
--
-- That number can genuinely be unknown — an unreachable proxy leaves the row
-- stale and the snapshot has nothing to record. Storing 0 there would draw a
-- healthy flat line through exactly the outage the column exists to show, so
-- the column joins `firehose_lag_ms` and `proxy_fresh_pct` in being nullable.
--
-- SQLite can't drop a NOT NULL in place, hence the rebuild. `captured_at` stays
-- the INTEGER PRIMARY KEY (= rowid), so range scans by time stay index-free.
CREATE TABLE metrics_snapshots_new (
  captured_at INTEGER PRIMARY KEY,
  users INTEGER NOT NULL,
  feeds INTEGER NOT NULL,
  feed_items INTEGER NOT NULL,
  subscriptions INTEGER NOT NULL,
  saved_articles INTEGER NOT NULL,
  feeds_with_errors INTEGER,
  active_sessions INTEGER NOT NULL,
  firehose_lag_ms INTEGER,
  proxy_fresh_pct REAL
);

INSERT INTO metrics_snapshots_new
  (captured_at, users, feeds, feed_items, subscriptions, saved_articles,
   feeds_with_errors, active_sessions, firehose_lag_ms, proxy_fresh_pct)
SELECT captured_at, users, feeds, feed_items, subscriptions, saved_articles,
       feeds_with_errors, active_sessions, firehose_lag_ms, proxy_fresh_pct
  FROM metrics_snapshots;

DROP TABLE metrics_snapshots;

ALTER TABLE metrics_snapshots_new RENAME TO metrics_snapshots;
