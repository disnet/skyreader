-- 0088 cleared the guessed "View in browser" URL from newsletter items, but a
-- save made before then copied that URL into saved_articles — often a
-- subscriber-tracking redirect, which SavedCard still links and an undo
-- re-save would send again. Clear it on those saves too.
-- A newsletter save is a feed save keyed by the item's guid (its Message-ID),
-- matched against the saving reader's own newsletter feeds
-- (`newsletter:<inbox_id>/<sender>`).
-- updated_at is stamped (ms) so GET /api/saved/updates re-delivers the edited
-- rows and clients drop the URL from their cached copy.
-- Saves already published to a Semble/Margin backing collection stay there:
-- those records live in the reader's own repo.
UPDATE saved_articles
SET url = '',
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE source = 'feed'
  AND url != ''
  AND item_guid IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM newsletter_inboxes ni
    -- A range, not LIKE, so the (feed_url, guid) index serves it: '0' is the
    -- character after '/'.
    JOIN feed_items fi
      ON fi.feed_url > 'newsletter:' || ni.inbox_id || '/'
     AND fi.feed_url < 'newsletter:' || ni.inbox_id || '0'
    WHERE ni.user_did = saved_articles.user_did
      AND fi.guid = saved_articles.item_guid
  );
