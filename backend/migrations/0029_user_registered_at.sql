-- Add registered_at to distinguish Skyreader users from externally-discovered users
-- NULL = discovered via Jetstream (using another app)
-- timestamp = logged into Skyreader directly
ALTER TABLE users ADD COLUMN registered_at INTEGER;

-- Backfill: existing users with real pds_url are Skyreader users
UPDATE users SET registered_at = created_at WHERE pds_url != '';
