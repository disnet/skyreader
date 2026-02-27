-- Add rkey column to track follow record for deletion handling via Jetstream
ALTER TABLE follows_cache ADD COLUMN rkey TEXT;

-- Create index for efficient lookup during delete events
CREATE INDEX IF NOT EXISTS idx_follows_rkey ON follows_cache(follower_did, rkey);
