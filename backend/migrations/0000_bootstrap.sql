-- Bootstrap: Mark all legacy migrations as applied
-- This handles the case where migrations were applied manually via d1 execute
-- before switching to d1 migrations apply

-- Create the migrations tracking table if it doesn't exist
CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert records for all legacy migrations (ignore if already exists)
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_scheduled_feeds.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_read_positions_cache.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0004_follows_sync.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0005_share_guid_published.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0006_share_feed_url.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0007_share_content.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0008_sessions.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0009_oauth_state.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0010_feed_cache.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0011_feed_items.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0012_inapp_follows.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0013_share_read_positions_cache.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0014_feed_metadata_image_url.sql');
