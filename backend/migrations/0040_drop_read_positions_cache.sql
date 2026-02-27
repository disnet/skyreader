-- Migrate any remaining read positions not yet in item_labels_cache
INSERT OR IGNORE INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, synced_at, created_at, updated_at)
SELECT
    user_did, item_guid, 'article', 'read',
    json_object('readAt', read_at, 'itemUrl', item_url, 'itemTitle', item_title),
    rkey, synced_at, COALESCE(created_at, unixepoch()), COALESCE(created_at, unixepoch())
FROM read_positions_cache
WHERE NOT EXISTS (
    SELECT 1 FROM item_labels_cache
    WHERE item_labels_cache.user_did = read_positions_cache.user_did
      AND item_labels_cache.item_key = read_positions_cache.item_guid
      AND item_labels_cache.label = 'read'
);

DROP TABLE IF EXISTS read_positions_cache;
