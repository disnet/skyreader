-- Make the connected-linkblog lookup cost scale with linkblog users, not users.
--
-- getConnectedLinkblogAuthors (linkblog-sync.ts) runs on every /discover and
-- friends-with-linkblogs request and asks for the handful of rows where
-- linkblog_publication IS NOT NULL. Migration 0061 added the bare column, so
-- that was a full scan of user_settings. A partial index holds only the rows
-- that qualify, and carrying user_did in it makes the query covering.
CREATE INDEX IF NOT EXISTS idx_user_settings_linkblog_publication
  ON user_settings(linkblog_publication, user_did)
  WHERE linkblog_publication IS NOT NULL;
