-- Tombstones for item_labels_cache
--
-- DELETE /api/labels now soft-deletes (sets deleted_at + bumps updated_at)
-- instead of hard-deleting. This makes the `?since=` delta lossless: a removed
-- label still shows up in the delta (as a tombstone), so clients can replay
-- deletions made on other devices without a periodic full reconcile, and can
-- safely persist their delta cursor across sessions.
--
-- NULL deleted_at = live row. A re-add (ON CONFLICT) resets deleted_at to NULL.
-- Only archived/tagged labels flow through DELETE /api/labels; `read` positions
-- are owned by the reading route and keep hard deletes.
ALTER TABLE item_labels_cache ADD COLUMN deleted_at INTEGER;

-- Partial index to keep the hourly tombstone GC sweep cheap.
CREATE INDEX IF NOT EXISTS idx_item_labels_deleted
  ON item_labels_cache(deleted_at)
  WHERE deleted_at IS NOT NULL;
