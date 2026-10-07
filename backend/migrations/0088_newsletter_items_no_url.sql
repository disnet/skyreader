-- A newsletter item has no web URL: the email is the article (see
-- docs/plans/EMAIL_NEWSLETTERS.md). Items ingested before that rule carry a
-- guessed "View in browser" link — often a subscriber-tracking redirect or a
-- sign-up wall. Clear it so what reads the archive from here on (a cold start,
-- "Show older", the extension, the CLI) sees the same URL-less item new mail
-- produces.
-- seq is left alone, so a client that already synced an item keeps its old URL
-- until the item ages out of its cache. That's how those items behaved before;
-- it's not worth re-delivering the archive for. content_hash is left alone too:
-- it keys the stored body, which hasn't changed.
-- Saves are left alone: an existing newsletter save keeps the link it was made
-- with, which may already be in a Semble/Margin collection.
-- The prefix is matched with GLOB, not LIKE: SQLite's LIKE is case-insensitive,
-- so it can't use the feed_url indexes and would scan the whole archive in one
-- statement. GLOB is case-sensitive and becomes an index range.
UPDATE feed_items
SET item_json = json_set(item_json, '$.url', '')
WHERE feed_url GLOB 'newsletter:*'
  AND COALESCE(json_extract(item_json, '$.url'), '') != '';
