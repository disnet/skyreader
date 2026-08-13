ALTER TABLE user_settings ADD COLUMN linkblog_disabled INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_user_settings_linkblog_disabled
  ON user_settings(user_did) WHERE linkblog_disabled = 1;
