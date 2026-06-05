-- Guard against duplicate subscriptions for the same source.
--
-- The Atmospheric subscription import (atmosphere-subscription-sync.ts) does a
-- check-then-INSERT against an in-memory snapshot of the user's local subs. Two
-- overlapping syncs (separate tabs/devices — there is no backend sync lock) can
-- both observe a publication as "not yet local" and both insert it with distinct
-- record_uris, since the only existing UNIQUE constraint is on record_uri. The
-- result is two identical document subscriptions for one publication.
--
-- A unique index on (user_did, source_type, feed_url) makes the import (and any
-- other INSERT path) idempotent at the DB layer: the losing concurrent insert is
-- ignored. NULL source_type rows (legacy RSS) are unaffected — SQLite treats
-- NULLs as distinct in a unique index — which matches today's behavior; the
-- `atproto.documents` rows we care about always carry a source_type.

-- Collapse any pre-existing exact duplicates first, keeping the earliest row of
-- each group, so creating the unique index can't fail on legacy data.
DELETE FROM subscriptions_cache
WHERE id NOT IN (
  SELECT MIN(id)
    FROM subscriptions_cache
   GROUP BY user_did, source_type, feed_url
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_cache_user_source_feed
  ON subscriptions_cache(user_did, source_type, feed_url);
