-- Composite index for keyset pagination of the saved list.
-- GET /api/saved orders by (saved_at DESC, id DESC) and pages via a cursor;
-- this index lets the keyset scan seek directly instead of sorting the full
-- per-user set on every refresh.
CREATE INDEX IF NOT EXISTS idx_saved_articles_user_savedat
  ON saved_articles(user_did, saved_at DESC, id DESC);
