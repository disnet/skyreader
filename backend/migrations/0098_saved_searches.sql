-- Saved searches as channels (docs/plans/SAVED_SEARCH_CHANNELS.md).
--
-- A channel whose config carries a `query` is mirrored here when the client
-- syncs it, so the server can match new items against it. The rest of the
-- channel config stays opaque; only the query and the source selection are
-- copied out. The Percolator Durable Object reads these rows, runs each new
-- item past the queries that cover its source, and writes the hits to
-- channel_matches.

CREATE TABLE IF NOT EXISTS saved_queries (
    user_did TEXT NOT NULL,
    channel_uuid TEXT NOT NULL,
    query TEXT NOT NULL,            -- as typed
    fts_query TEXT NOT NULL,        -- parseSearchQuery().match, ready for FTS5 MATCH
    source_mode TEXT NOT NULL,      -- 'all' | 'include' | 'exclude'
    source_keys TEXT NOT NULL,      -- JSON array, the channel's own source keys
    digest TEXT NOT NULL DEFAULT 'off', -- 'off' | 'daily'
    -- Backfill over recent history, run once after create and after any change
    -- to the query or its sources. It walks the query's feeds, then its document
    -- authors, in sorted order; the two cursors are the last of each it finished.
    backfill_state TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done'
    backfill_feed_after TEXT NOT NULL DEFAULT '',   -- feed_url
    backfill_doc_after TEXT NOT NULL DEFAULT '',    -- author DID
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_did, channel_uuid),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_backfill
    ON saved_queries(backfill_state);

-- One row per story per channel. A story that arrives twice (a feed and a
-- newsletter carrying the same link) keys on its normalized URL, so it matches
-- once; items with no URL key on their own item key.
CREATE TABLE IF NOT EXISTS channel_matches (
    user_did TEXT NOT NULL,
    channel_uuid TEXT NOT NULL,
    dedup_key TEXT NOT NULL,        -- normalized URL, else 'item:' || item_key
    item_key TEXT NOT NULL,         -- what read state is filed under (guid / document URI)
    source_kind TEXT NOT NULL,      -- 'feed' | 'document'
    source_ref TEXT NOT NULL,       -- feed_url, or the document's author DID
    feed_seq INTEGER,               -- feed_items.seq for feed matches
    snippet TEXT NOT NULL DEFAULT '', -- FTS5 snippet, matches wrapped in \u0002…\u0003
    published_at INTEGER,           -- ms
    matched_at INTEGER NOT NULL,    -- ms
    PRIMARY KEY (user_did, channel_uuid, dedup_key),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channel_matches_channel_time
    ON channel_matches(user_did, channel_uuid, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_matches_matched
    ON channel_matches(matched_at);

-- The matcher walks new documents by first-seen time; documents_v2 had no
-- index on it.
CREATE INDEX IF NOT EXISTS idx_documents_v2_indexed
    ON documents_v2(indexed_at, record_uri);
