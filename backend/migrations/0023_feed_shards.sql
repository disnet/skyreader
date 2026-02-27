-- Add shard_id column for parallel feed refreshing
ALTER TABLE feed_metadata ADD COLUMN shard_id INTEGER DEFAULT 0;

-- Create index for efficient shard queries
CREATE INDEX idx_feed_metadata_shard_id ON feed_metadata(shard_id);

-- Backfill existing feeds using a simple hash
-- SQLite doesn't have a string hash, so we use a character-based approach
UPDATE feed_metadata
SET shard_id = (
  (UNICODE(SUBSTR(feed_url, 1, 1)) +
   UNICODE(SUBSTR(feed_url, LENGTH(feed_url)/2, 1)) +
   UNICODE(SUBSTR(feed_url, LENGTH(feed_url), 1))) % 4
);
