-- Add profile_updated_at to track when profile data was last refreshed from Bluesky
ALTER TABLE users ADD COLUMN profile_updated_at INTEGER;

-- Backfill existing rows with updated_at value
UPDATE users SET profile_updated_at = updated_at WHERE profile_updated_at IS NULL;
