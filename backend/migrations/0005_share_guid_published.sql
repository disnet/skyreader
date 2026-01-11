-- Add item_guid, item_published_at, and feed_url columns to shares table
ALTER TABLE shares ADD COLUMN item_guid TEXT;
ALTER TABLE shares ADD COLUMN item_published_at INTEGER;
ALTER TABLE shares ADD COLUMN feed_url TEXT;

-- Index for looking up shares by guid
CREATE INDEX idx_shares_item_guid ON shares(item_guid);
