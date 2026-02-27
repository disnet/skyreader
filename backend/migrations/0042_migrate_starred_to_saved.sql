-- Backfill starred shares into saved_articles
INSERT OR IGNORE INTO saved_articles (user_did, rkey, url, title, source, item_guid, saved_at, created_at)
SELECT
  user_did,
  COALESCE(rkey, lower(hex(randomblob(8)))),
  COALESCE(json_extract(props, '$.itemUrl'), ''),
  json_extract(props, '$.itemTitle'),
  'share',
  item_key,
  created_at * 1000,
  created_at * 1000
FROM item_labels_cache
WHERE label = 'starred'
  AND item_type = 'share'
  AND NOT EXISTS (
    SELECT 1 FROM saved_articles sa
    WHERE sa.user_did = item_labels_cache.user_did
      AND sa.item_guid = item_labels_cache.item_key
  );

-- Backfill starred documents into saved_articles
INSERT OR IGNORE INTO saved_articles (user_did, rkey, url, title, source, item_guid, saved_at, created_at)
SELECT
  user_did,
  COALESCE(rkey, lower(hex(randomblob(8)))),
  COALESCE(json_extract(props, '$.itemUrl'), ''),
  json_extract(props, '$.itemTitle'),
  'document',
  item_key,
  created_at * 1000,
  created_at * 1000
FROM item_labels_cache
WHERE label = 'starred'
  AND item_type = 'document'
  AND NOT EXISTS (
    SELECT 1 FROM saved_articles sa
    WHERE sa.user_did = item_labels_cache.user_did
      AND sa.item_guid = item_labels_cache.item_key
  );

-- Remove all starred labels (saved_articles is now the sole source of truth)
DELETE FROM item_labels_cache WHERE label = 'starred';
