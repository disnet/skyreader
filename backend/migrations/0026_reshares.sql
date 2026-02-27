-- Add reshare support columns to shares table
ALTER TABLE shares ADD COLUMN reshare_of_uri TEXT;
ALTER TABLE shares ADD COLUMN reshare_of_author_did TEXT;
ALTER TABLE shares ADD COLUMN reshare_count INTEGER DEFAULT 0;

-- Index for efficiently finding all reshares of a specific share
CREATE INDEX idx_shares_reshare_of ON shares(reshare_of_uri);

-- Index for efficient grouping/deduplication by article URL and ordering by creation time
CREATE INDEX idx_shares_item_url_created ON shares(item_url, created_at);
