-- Migrate share_read_positions_cache to unified social_read_positions_cache
-- Supports tracking read state for any social item type (shares, documents, etc.)

-- Step 1: Create new unified table with proper structure
CREATE TABLE IF NOT EXISTS social_read_positions_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    record_uri TEXT,
    item_type TEXT NOT NULL DEFAULT 'share',
    item_uri TEXT NOT NULL,
    author_did TEXT NOT NULL,
    item_url TEXT,
    item_title TEXT,
    read_at TEXT NOT NULL,
    synced_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE,
    UNIQUE(user_did, rkey),
    UNIQUE(user_did, item_uri)
);

-- Step 2: Migrate existing data from share_read_positions_cache
INSERT INTO social_read_positions_cache
    (id, user_did, rkey, record_uri, item_type, item_uri, author_did, item_url, item_title, read_at, synced_at, created_at)
SELECT
    id, user_did, rkey, record_uri, 'share', share_uri, share_author_did, item_url, item_title, read_at, synced_at, created_at
FROM share_read_positions_cache;

-- Step 3: Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_social_read_positions_user ON social_read_positions_cache(user_did);
CREATE INDEX IF NOT EXISTS idx_social_read_positions_item ON social_read_positions_cache(user_did, item_uri);
CREATE INDEX IF NOT EXISTS idx_social_read_positions_type ON social_read_positions_cache(user_did, item_type);

-- Step 4: Drop old table
DROP TABLE IF EXISTS share_read_positions_cache;
