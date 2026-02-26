-- Add columns to track refresh failures and enable retry logic with backoff
ALTER TABLE sessions ADD COLUMN refresh_failures INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN last_refresh_attempt INTEGER;
ALTER TABLE sessions ADD COLUMN last_refresh_error TEXT;
ALTER TABLE sessions ADD COLUMN refresh_locked_until INTEGER;

-- Index for efficient cleanup queries
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_locked ON sessions(refresh_locked_until);
