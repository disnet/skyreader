-- Unified item labels cache table
-- Replaces read_positions_cache and social_read_positions_cache
CREATE TABLE IF NOT EXISTS item_labels_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    item_key TEXT NOT NULL,
    item_type TEXT NOT NULL,  -- 'article', 'share', 'document', 'userShare'
    label TEXT NOT NULL,      -- 'read', 'starred', 'archived', 'tag:<name>'
    props TEXT,               -- JSON metadata
    rkey TEXT,
    record_uri TEXT,
    synced_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_did, item_key, label),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_item_labels_user ON item_labels_cache(user_did);
CREATE INDEX IF NOT EXISTS idx_item_labels_user_item ON item_labels_cache(user_did, item_key);
CREATE INDEX IF NOT EXISTS idx_item_labels_user_label ON item_labels_cache(user_did, label);
CREATE INDEX IF NOT EXISTS idx_item_labels_user_type_label ON item_labels_cache(user_did, item_type, label);

-- Migrate existing read_positions_cache data
INSERT OR IGNORE INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, synced_at, created_at, updated_at)
SELECT
    user_did,
    item_guid,
    'article',
    'read',
    json_object('readAt', read_at, 'itemUrl', item_url, 'itemTitle', item_title),
    rkey,
    synced_at,
    created_at,
    created_at
FROM read_positions_cache;

-- Migrate starred items
INSERT OR IGNORE INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, synced_at, created_at, updated_at)
SELECT
    user_did,
    item_guid,
    'article',
    'starred',
    json_object('starredAt', read_at, 'itemUrl', item_url, 'itemTitle', item_title),
    rkey,
    synced_at,
    created_at,
    created_at
FROM read_positions_cache
WHERE starred = 1;

-- Migrate social_read_positions_cache data
INSERT OR IGNORE INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, synced_at, created_at, updated_at)
SELECT
    user_did,
    item_uri,
    item_type,
    'read',
    json_object('readAt', read_at, 'authorDid', author_did, 'itemUrl', item_url, 'itemTitle', item_title),
    rkey,
    synced_at,
    created_at,
    created_at
FROM social_read_positions_cache;
