-- Unify document read state onto item_labels_cache
--
-- Document reads have lived in social_read_positions_cache, served as a full
-- dump and rebuilt every session. The read-state refactor folds them onto the
-- same table the article read path uses (item_labels_cache, item_type='document',
-- label='read'), so they inherit inline annotation, the forward delta, the
-- deleted_at tombstone, and the label-agnostic GC for free.
--
-- This makes item_labels_cache's document reads an AUTHORITATIVE copy of
-- social_read_positions_cache (the source of truth under the old code), not an
-- additive merge. Migration 0037 took a one-time snapshot of document reads into
-- item_labels_cache, but every document read/un-read AFTER 0037 went only to
-- social_read_positions_cache — the old document path never wrote to
-- item_labels_cache. So the 0037 snapshot drifted: a document read before 0037
-- and un-read after it was deleted from the source, yet its stale read row
-- survived here as a live (deleted_at IS NULL) row. An additive INSERT OR IGNORE
-- would preserve that stale row, and the new annotation path would then resurrect
-- the document as read. So we drop the drifted snapshot first, then copy the
-- current source of truth. Scoped to document reads only — article reads and all
-- other labels are untouched. Shares are NOT migrated — the share system is gone.
--
-- This runs as a migration, before the new worker code serves any traffic, so
-- social_read_positions_cache is still the live source and no read has yet been
-- written to item_labels_cache via the new unified document path — the DELETE
-- cannot clobber a legitimately-new document read.
DELETE FROM item_labels_cache WHERE item_type = 'document' AND label = 'read';

-- read_at is an ISO string in the source; we keep it verbatim in props.readAt.
-- The source has no updated_at, so created_at seeds both timestamps.
INSERT OR IGNORE INTO item_labels_cache
  (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
SELECT
  user_did,
  item_uri,
  'document',
  'read',
  json_object(
    'readAt', read_at,
    'rkey', rkey,
    'authorDid', author_did,
    'itemUrl', item_url,
    'itemTitle', item_title
  ),
  rkey,
  created_at,
  created_at
FROM social_read_positions_cache
WHERE item_type = 'document';
