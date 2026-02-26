-- Clear existing bloated content (one-time cleanup)
-- The content column stored redundant JSON blobs that now exist in feed_items
UPDATE feed_cache SET content = '{}';
