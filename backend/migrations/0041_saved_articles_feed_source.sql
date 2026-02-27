-- Add feed-origin columns to saved_articles
ALTER TABLE saved_articles ADD COLUMN source TEXT NOT NULL DEFAULT 'url';  -- 'url' | 'feed'
ALTER TABLE saved_articles ADD COLUMN item_guid TEXT;
CREATE INDEX idx_saved_articles_guid ON saved_articles(user_did, item_guid);

-- Backfill existing starred items into saved_articles
INSERT OR IGNORE INTO saved_articles (user_did, rkey, url, title, source, item_guid, saved_at, created_at)
SELECT
  user_did,
  COALESCE(rkey, lower(hex(randomblob(8)))),
  json_extract(props, '$.itemUrl'),
  json_extract(props, '$.itemTitle'),
  'feed',
  item_key,
  created_at,
  created_at
FROM item_labels_cache
WHERE label = 'starred'
  AND item_type = 'article'
  AND json_extract(props, '$.itemUrl') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM saved_articles sa
    WHERE sa.user_did = item_labels_cache.user_did
      AND sa.url = json_extract(props, '$.itemUrl')
  );
