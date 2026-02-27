-- Publications cache for resolving site.standard.publication URLs
-- This avoids repeated fetches for publications referenced by multiple documents

CREATE TABLE IF NOT EXISTS publications_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publication_uri TEXT UNIQUE NOT NULL,  -- at://did/site.standard.publication/rkey
    author_did TEXT NOT NULL,
    base_url TEXT NOT NULL,                -- The publication's URL field
    name TEXT,
    description TEXT,
    cached_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    expires_at INTEGER NOT NULL            -- Cache TTL: 24 hours from cached_at
);

-- Index for efficient lookups and cleanup
CREATE INDEX IF NOT EXISTS idx_publications_cache_expires ON publications_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_publications_cache_author ON publications_cache(author_did);
