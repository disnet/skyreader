-- Add last_active_at to users table for tracking active users
-- Default to 0 (epoch start) - will be updated on first authenticated request
ALTER TABLE users ADD COLUMN last_active_at INTEGER DEFAULT 0;

-- Create index for efficient active user queries
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at);

-- Cache of user subscriptions (synced from AT Protocol)
-- Used by scheduled feed fetcher to know which feeds to refresh
CREATE TABLE subscriptions_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    record_uri TEXT UNIQUE NOT NULL,
    feed_url TEXT NOT NULL,
    title TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX idx_subscriptions_cache_user ON subscriptions_cache(user_did);
CREATE INDEX idx_subscriptions_cache_feed_url ON subscriptions_cache(feed_url);

-- Add scheduled fetch tracking to feed_metadata
ALTER TABLE feed_metadata ADD COLUMN last_scheduled_fetch_at INTEGER;
ALTER TABLE feed_metadata ADD COLUMN subscriber_count INTEGER DEFAULT 0;
