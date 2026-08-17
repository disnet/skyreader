-- Per-feed crawl health in the archive.
--
-- On the legacy batch path the client learned a feed was broken from the proxy's
-- own response (`status: 'error'`, errorCount, nextRetryAt). The timeline path
-- never touches the proxy, so that signal disappeared: a feed failing to crawl
-- simply delivered no items, which is indistinguishable from a quiet feed. The
-- crawler now reports health here (POST /api/internal/feed-health) and the
-- timeline hands it to the client alongside its items.
--
-- Units: unix SECONDS, like `last_ingest_at` and the rest of the backend. The
-- proxy stores these as milliseconds and converts on send; the timeline converts
-- back to milliseconds on the way out, because that is what the client's
-- FeedStatus contract has always used.

ALTER TABLE feeds ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feeds ADD COLUMN last_error TEXT;
ALTER TABLE feeds ADD COLUMN last_error_at INTEGER;
ALTER TABLE feeds ADD COLUMN next_retry_at INTEGER;
-- Last time the crawler successfully FETCHED the feed. Distinct from
-- `last_ingest_at`, which only moves when a fetch produced a new or edited item:
-- a healthy feed that hasn't published in a month still gets fetched hourly.
ALTER TABLE feeds ADD COLUMN last_fetch_at INTEGER;
-- The crawler has this feed in its crawl set but hasn't managed to fetch it in
-- hours — starved by a saturated warm loop rather than failing outright. Distinct
-- from `error_count`: nothing is erroring, the crawler simply never gets to it.
--
-- This is the difference between an alarm and noise. `last_ingest_at` only moves
-- when a fetch yields a NEW item, so "no ingest in an hour" describes every
-- weekly blog in the archive; the admin's old stale-feed metric was therefore
-- warning permanently and meant nothing. Being in the crawl set and un-fetched is
-- a genuine fault, and it is the one the current warm-loop capacity work needs.
ALTER TABLE feeds ADD COLUMN crawl_stale INTEGER NOT NULL DEFAULT 0;

-- The trouble set is a handful of rows out of the whole archive, so let the
-- per-user health lookup, the recovery sweep and the admin's counts start from it
-- rather than scanning `feeds`. Recovery is "currently flagged, and absent from
-- the latest report", which this index makes cheap to enumerate — the
-- alternative, a NOT IN list of every healthy feed, would blow the
-- bound-parameter limit at ~1,300.
CREATE INDEX idx_feeds_unhealthy ON feeds(feed_url) WHERE error_count > 0 OR crawl_stale = 1;

-- Bumped whenever a health report actually changes something. Clients echo the
-- revision they last saw and the timeline only re-sends the health payload when
-- it differs, so the steady-state poll stays at one query. Only `error_count`
-- feeds into it: `crawl_stale` is an operator signal, invisible to readers.
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('feed_health_rev', '0');
