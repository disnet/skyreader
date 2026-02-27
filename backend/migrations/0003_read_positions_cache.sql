-- Cache of user read positions (synced from AT Protocol)
-- Used to dedupe before syncing to PDS
CREATE TABLE IF NOT EXISTS read_positions_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    record_uri TEXT,  -- NULL until synced to PDS
    item_guid TEXT NOT NULL,
    item_url TEXT,
    item_title TEXT,
    starred INTEGER DEFAULT 0,
    read_at INTEGER NOT NULL,
    synced_at INTEGER,  -- NULL until synced to PDS
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE,
    UNIQUE(user_did, rkey)
);

CREATE INDEX IF NOT EXISTS idx_read_positions_cache_user ON read_positions_cache(user_did);
CREATE INDEX IF NOT EXISTS idx_read_positions_cache_guid ON read_positions_cache(user_did, item_guid);
CREATE INDEX IF NOT EXISTS idx_read_positions_cache_unsynced ON read_positions_cache(synced_at) WHERE synced_at IS NULL;
