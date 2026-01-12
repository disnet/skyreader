-- Cache of share read positions (synced from AT Protocol)
-- Used to dedupe before syncing to PDS
CREATE TABLE share_read_positions_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    record_uri TEXT,
    share_uri TEXT NOT NULL,
    share_author_did TEXT NOT NULL,
    item_url TEXT,
    item_title TEXT,
    read_at TEXT NOT NULL,
    synced_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE,
    UNIQUE(user_did, rkey),
    UNIQUE(user_did, share_uri)
);

CREATE INDEX idx_share_read_positions_cache_user ON share_read_positions_cache(user_did);
CREATE INDEX idx_share_read_positions_cache_share ON share_read_positions_cache(user_did, share_uri);
