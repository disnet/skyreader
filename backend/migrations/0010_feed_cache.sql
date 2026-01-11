-- Move feed caching from KV to D1
CREATE TABLE IF NOT EXISTS feed_cache (
    url_hash TEXT PRIMARY KEY,
    feed_url TEXT NOT NULL,
    content TEXT NOT NULL,  -- JSON blob of parsed feed
    etag TEXT,
    last_modified TEXT,
    cached_at INTEGER NOT NULL DEFAULT (unixepoch())
);
