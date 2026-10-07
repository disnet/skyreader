-- A newsletter item has no web URL: the email is the article (see
-- docs/plans/EMAIL_NEWSLETTERS.md). Items ingested before that rule carry a
-- guessed "View in browser" link — often a subscriber-tracking redirect or a
-- sign-up wall. Clear it so what reads the archive from here on (a cold start,
-- "Show older", the extension, the CLI) sees the same URL-less item new mail
-- produces.
-- seq is left alone, so this edit is never re-delivered: a client that already
-- synced an item keeps its old URL in IndexedDB. The client's newsletter gate
-- (subscriptionsStore.webUrlFor) is what keeps that cached link out of the
-- reader, its actions and its saves. content_hash is left alone too: it keys
-- the stored body, which hasn't changed.
-- The prefix is matched with GLOB, not LIKE: SQLite's LIKE is case-insensitive,
-- so it can't use the feed_url indexes and would scan the whole archive in one
-- statement. GLOB is case-sensitive and becomes an index range.
UPDATE feed_items
SET item_json = json_set(item_json, '$.url', '')
WHERE feed_url GLOB 'newsletter:*'
  AND COALESCE(json_extract(item_json, '$.url'), '') != '';

-- The same guessed link rides on newsletter saves made before the rule. Clear it
-- so the saved pile neither opens it nor exports it when backing is turned on
-- (export skips URL-less saves). A save already in a Semble/Margin collection is
-- left as it is: that link is already public, and url_normalized is what joins
-- the save to its membership and what unsaving it deletes by. updated_at is
-- stamped so a client's incremental refresh picks the cleared URL up.
UPDATE saved_articles
SET url = '', url_normalized = NULL, updated_at = unixepoch() * 1000
WHERE source = 'feed'
  AND url != ''
  AND item_guid IN (
    SELECT guid FROM feed_items
    WHERE feed_url GLOB 'newsletter:*'
  )
  AND (
    url_normalized IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM backed_collection_members m
      WHERE m.user_did = saved_articles.user_did
        AND m.url_normalized = saved_articles.url_normalized
    )
  );
