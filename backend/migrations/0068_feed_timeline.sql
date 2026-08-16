-- D1-served feed timeline (ingest-push architecture).
--
-- The Fly proxy stays the crawler but leaves the read path entirely: it pushes
-- new/edited items into the tables below, and a client refresh becomes ONE query
-- (feed_items JOIN subscriptions_cache LEFT JOIN item_labels_cache) instead of
-- N batched Worker->Fly hops plus chunked read-key lookups.
--
-- Retention: D1 is the ARCHIVE. Ordinary ingest never deletes an item; the proxy's
-- own K=200 log is only the outbox (a delivery window). The single trim that
-- exists is a per-feed sanity cap (5,000) that healthy feeds never reach — see
-- routes/ingest.ts.

-- The dormant pre-Fly trio. Zero references in backend/src; feed_cache was
-- already wiped to '{}' by 0018. Dropped so the names are free for the new shapes.
DROP TABLE IF EXISTS feed_items;
DROP TABLE IF EXISTS feed_cache;
DROP TABLE IF EXISTS feed_metadata;

-- One row per crawled feed: metadata for the reader plus ingest observability.
CREATE TABLE feeds (
    feed_url       TEXT PRIMARY KEY,
    title          TEXT,
    site_url       TEXT,
    description    TEXT,
    image_url      TEXT,
    last_ingest_at INTEGER,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The durable item archive. Same invariants as the proxy's proven log:
-- AUTOINCREMENT seq is a never-reused monotonic cursor, an edit updates in place
-- (seq unchanged, so it is not re-delivered), content_hash is NOT NULL because a
-- NULL would make the edit predicate (`<>`) silently never match.
CREATE TABLE feed_items (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_url      TEXT NOT NULL,
    guid          TEXT NOT NULL,
    item_json     TEXT NOT NULL,
    published_at  INTEGER,
    first_seen_at INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,
    UNIQUE(feed_url, guid)
);

CREATE INDEX idx_feed_items_feed_seq ON feed_items(feed_url, seq);
CREATE INDEX idx_feed_items_feed_published_seq
    ON feed_items(feed_url, published_at DESC, seq DESC);

-- The timeline join probes subscriptions by (user_did, feed_url).
CREATE INDEX IF NOT EXISTS idx_subscriptions_cache_user_feed
    ON subscriptions_cache(user_did, feed_url);

-- Generation token for the archive (D1 recreation / Time Travel restore guard).
-- Clients store it beside their cursor and cold-start on mismatch. Any D1 restore
-- must bump this (seqs rewind while the token would otherwise stay the same).
INSERT OR IGNORE INTO sync_state (key, value)
VALUES ('items_generation', lower(hex(randomblob(16))));
