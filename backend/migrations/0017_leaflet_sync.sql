-- User settings table for feature preferences (e.g., Leaflet sync)
CREATE TABLE IF NOT EXISTS user_settings (
    user_did TEXT PRIMARY KEY,
    leaflet_sync_enabled INTEGER DEFAULT 0,
    leaflet_last_synced_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

-- Add source tracking to subscriptions_cache for identifying Leaflet-synced feeds
ALTER TABLE subscriptions_cache ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE subscriptions_cache ADD COLUMN external_ref TEXT;

-- Index for efficient Leaflet subscription queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_source ON subscriptions_cache(user_did, source);

-- DID to handle cache for avoiding repeated plc.directory lookups
CREATE TABLE IF NOT EXISTS did_handle_cache (
    did TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    cached_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Index for cache expiry cleanup
CREATE INDEX IF NOT EXISTS idx_did_handle_cached_at ON did_handle_cache(cached_at);
