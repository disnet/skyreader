-- Feed discovery for the sites of people a reader follows on Bluesky: a domain
-- handle (@someone.com) or a link in their profile. Shared across readers, so a
-- popular writer's site is discovered once, not once per follower
-- (routes/site-feeds.ts).
--
-- `site` is the normalized host plus path (no scheme, no trailing slash).
-- `feeds_json` is the JSON array of feed URLs found there, empty when none were.
-- `expires_at` is when to ask again: later for a found feed than for a miss.
CREATE TABLE site_feed_discovery (
  site       TEXT PRIMARY KEY,
  feeds_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
