-- User-time last-write-wins for item labels.
--
-- Until now every label write blindly overwrote whatever was there, so the
-- winner was whichever HTTP request arrived last. A device draining an offline
-- queue an hour late therefore resurrected stale intent — re-marking unread
-- something the user had since read on another device.
--
-- `client_updated_at` is the moment the USER acted, in unix MILLISECONDS,
-- clamped server-side to "now" so a forward-skewed clock can't pin a row
-- permanently. Every write path compares it before overwriting:
--
--   ON CONFLICT(...) DO UPDATE SET ... WHERE excluded.client_updated_at >= client_updated_at
--
-- `updated_at` (server seconds) keeps its job unchanged: it is the delta
-- cursor, so the sync stream stays arrival-ordered and monotonic. This column
-- is only the conflict tiebreaker.
--
-- Backfilled from updated_at so pre-existing rows compare sensibly against new
-- writes; COALESCE guards the row an older Worker might still insert mid-deploy.
ALTER TABLE item_labels_cache ADD COLUMN client_updated_at INTEGER;

UPDATE item_labels_cache SET client_updated_at = updated_at * 1000;

-- The delta is now ordered by (updated_at, id) so same-second rows can't be
-- skipped by a strictly-greater cursor. This index is what keeps that ordered
-- scan a seek rather than a per-user sort.
CREATE INDEX IF NOT EXISTS idx_item_labels_user_updated
  ON item_labels_cache(user_did, updated_at, id);
