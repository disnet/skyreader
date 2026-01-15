-- Rate limiting table for per-user API request tracking
CREATE TABLE IF NOT EXISTS rate_limits (
  did TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER DEFAULT 1,
  PRIMARY KEY (did, endpoint, window_start)
);

-- Index for efficient cleanup of old rate limit records
CREATE INDEX IF NOT EXISTS idx_rate_limits_cleanup ON rate_limits(window_start);
