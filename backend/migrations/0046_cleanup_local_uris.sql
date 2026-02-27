-- Migration: Clean up local:// URIs, replace with at://
-- local:// URIs were temporary placeholders for records not yet synced to PDS.
-- Now we always generate at:// URIs upfront, so clean up any remaining local:// rows.

-- shares: delete local:// duplicates where at:// version exists
DELETE FROM shares
WHERE record_uri LIKE 'local://%'
AND EXISTS (
  SELECT 1 FROM shares s2
  WHERE s2.author_did = shares.author_did
  AND s2.record_uri = 'at://' || SUBSTR(shares.record_uri, 9)
);

-- shares: rewrite remaining local:// to at://
UPDATE shares
SET record_uri = 'at://' || SUBSTR(record_uri, 9)
WHERE record_uri LIKE 'local://%';

-- subscriptions_cache: delete local:// duplicates where at:// version exists
DELETE FROM subscriptions_cache
WHERE record_uri LIKE 'local://%'
AND EXISTS (
  SELECT 1 FROM subscriptions_cache s2
  WHERE s2.user_did = subscriptions_cache.user_did
  AND s2.record_uri = 'at://' || SUBSTR(subscriptions_cache.record_uri, 9)
);

-- subscriptions_cache: rewrite remaining local:// to at://
UPDATE subscriptions_cache
SET record_uri = 'at://' || SUBSTR(record_uri, 9)
WHERE record_uri LIKE 'local://%';

-- social_read_positions_cache: rewrite local:// to at:// (no unique constraint on record_uri)
UPDATE social_read_positions_cache
SET record_uri = 'at://' || SUBSTR(record_uri, 9)
WHERE record_uri LIKE 'local://%';

-- share_read_positions_cache: table does not exist in production, skipped
