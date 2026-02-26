-- Users table - caches AT Protocol user information
CREATE TABLE IF NOT EXISTS users (
    did TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    pds_url TEXT NOT NULL,
    last_synced_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);

-- Follows cache - which users follow whom (from Bluesky)
CREATE TABLE IF NOT EXISTS follows_cache (
    follower_did TEXT NOT NULL,
    following_did TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (follower_did, following_did),
    FOREIGN KEY (follower_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follows_following ON follows_cache(following_did);

-- Aggregated shares from all users
CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_did TEXT NOT NULL,
    record_uri TEXT UNIQUE NOT NULL,
    record_cid TEXT NOT NULL,
    item_url TEXT NOT NULL,
    item_title TEXT,
    item_author TEXT,
    item_description TEXT,
    item_image TEXT,
    note TEXT,
    tags TEXT, -- JSON array stored as text
    indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (author_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shares_author ON shares(author_did);
CREATE INDEX IF NOT EXISTS idx_shares_created ON shares(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_item_url ON shares(item_url);

-- Feed metadata cache (for proxy optimization)
CREATE TABLE IF NOT EXISTS feed_metadata (
    feed_url TEXT PRIMARY KEY,
    title TEXT,
    site_url TEXT,
    description TEXT,
    last_fetched_at INTEGER,
    etag TEXT,
    last_modified TEXT,
    fetch_error TEXT,
    error_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Sync state tracking (e.g., Jetstream cursor)
CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
