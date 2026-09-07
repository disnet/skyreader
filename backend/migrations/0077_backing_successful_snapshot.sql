-- Distinguish "the latest complete backing snapshot is empty" from "no complete
-- snapshot has ever landed". last_backing_poll remains the attempt timestamp
-- used by the one-minute retry gate; this timestamp advances only after a
-- provably-complete membership replacement.
ALTER TABLE user_settings ADD COLUMN last_successful_backing_poll INTEGER;

-- Existing non-empty membership proves that a complete snapshot landed before
-- this marker existed. Existing empty snapshots cannot be distinguished from a
-- failed first poll, so they safely perform one final inline poll after deploy.
UPDATE user_settings
SET last_successful_backing_poll = last_backing_poll
WHERE last_backing_poll IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM backed_collection_members m
    WHERE m.user_did = user_settings.user_did
      AND user_settings.backing = m.external_provider || ':' || m.external_collection
  );
