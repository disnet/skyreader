-- A newsletter item has no web URL: the email is the article (see
-- docs/plans/EMAIL_NEWSLETTERS.md). Items ingested before that rule carry a
-- guessed "View in browser" link — often a subscriber-tracking redirect or a
-- sign-up wall. Clear it so every reader of the archive (timeline, "Show older",
-- saves, extension, CLI) sees the same URL-less item new mail produces.
-- content_hash is left alone: it keys the stored body, which hasn't changed.
UPDATE feed_items
SET item_json = json_set(item_json, '$.url', '')
WHERE feed_url LIKE 'newsletter:%'
  AND COALESCE(json_extract(item_json, '$.url'), '') != '';
