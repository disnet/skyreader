-- Add subscription tier column to users table
-- Default 'free' for all existing and new users
ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';

-- Index for querying users by tier (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);
