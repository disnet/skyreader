-- The crawl cycle, hour by hour: how long one pass over the healthy crawl set
-- took (the proxy's `warm.cycleSeconds`, via the `proxy_stats` row). It replaces
-- `proxy_fresh_pct` as the crawl-freshness trend and SLO, because the warm loop
-- is sized to an ~8-minute cycle against a 5-minute TTL and the percentage can't
-- clear its bar by design. `proxy_fresh_pct` keeps being written so its history
-- stays comparable; nothing reads it.
--
-- Nullable like the other proxy-derived columns: an hour whose proxy row was
-- missing or stale has no cycle to record, and 0 would read as "instant".
ALTER TABLE metrics_snapshots ADD COLUMN crawl_cycle_s INTEGER;
