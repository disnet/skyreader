-- Guest reading mode: mark the feeds an unauthenticated reader pulled into the
-- archive.
--
-- Every other write into `feeds` is anchored to an account: the crawler pulls
-- its demand set from `subscriptions_cache`, and the pull-through in
-- /api/v2/feeds/fetch only warms a feed its caller subscribes to. A guest has no
-- subscription rows anywhere, so /api/guest/feeds/warm is the one path that
-- creates a feed nobody owns. This column is what keeps that path bounded and
-- reversible:
--
--   * it is the per-feed limiter — a guest warm stamps it BEFORE fetching, so a
--     hot (or broken) URL is re-fetched at most once per freshness window, and
--     it survives the rate_limits cleanup that a long window would not;
--   * it is the daily ceiling — new guest-warmed feeds are counted through it;
--   * it is the reaper's handle — a guest-warmed feed with no subscriber and no
--     guest touch in 30 days is deleted by the hourly cron, items and all.
--
-- Unix seconds, like `last_ingest_at` and the rest of this table. NULL means
-- "no guest ever warmed this feed", which is every feed the crawler owns.
ALTER TABLE feeds ADD COLUMN guest_warmed_at INTEGER;

-- Guest-warmed feeds are a small minority of the archive, so the cap count and
-- the reaper both start from a partial index rather than scanning `feeds`.
CREATE INDEX idx_feeds_guest_warmed ON feeds(guest_warmed_at) WHERE guest_warmed_at IS NOT NULL;
