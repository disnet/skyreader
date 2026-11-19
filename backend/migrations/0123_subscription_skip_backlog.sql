-- A new subscription starts with only its newest few items unread
-- (services/backlog-skip.ts). Unix ms when the reader subscribed, while that
-- skip is still owed; NULL otherwise. The hourly cron clears it once the window
-- has passed, so the partial index only ever holds the last day's subscriptions.
ALTER TABLE subscriptions_cache ADD COLUMN skip_backlog_at INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cache_skip_backlog
  ON subscriptions_cache(feed_url)
  WHERE skip_backlog_at IS NOT NULL;
