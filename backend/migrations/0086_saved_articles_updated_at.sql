-- In-place content changes to a saved item (a browser-extension re-save that
-- upgrades the body, a background extraction filling a stub) don't move
-- saved_at, so the client's incremental refresh — which stops at the first
-- cached rkey — never sees them. updated_at stamps those edits; the client asks
-- GET /api/saved/updates?since=<ms> for rows changed after its high-water mark.
-- NULL = never updated since it was saved (the save itself is picked up by the
-- ordinary saved_at refresh).
ALTER TABLE saved_articles ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_saved_articles_user_updatedat
  ON saved_articles(user_did, updated_at)
  WHERE updated_at IS NOT NULL;
