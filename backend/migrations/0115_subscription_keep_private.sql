-- A subscription the reader chose to keep off their PDS, though Atmospheric sync
-- is on. Asked when a new feed looks private (a member-only podcast, a feed URL
-- carrying a personal token): published to the PDS, that URL is public, and
-- anyone holding it can read the feed as the reader.
--
-- A kept-private row lives in D1 only, like a newsletter: never pushed, never
-- marked owing a write, never deleted from the PDS. Unlike a newsletter it is an
-- ordinary feed in every other way, crawled and served like any other.
ALTER TABLE subscriptions_cache ADD COLUMN keep_private INTEGER NOT NULL DEFAULT 0;
