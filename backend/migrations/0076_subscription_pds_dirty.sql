-- Track subscriptions whose local edits have not reached the PDS yet.
--
-- Every subscription mutation write-throughs to the PDS, but the create/update
-- pushes are fire-and-forget (`ctx.waitUntil` + a logged error), so a failed
-- write leaves the PDS holding a stale record with nothing to repair it: the
-- sync's push phase skips any subscription that already exists on the PDS, so a
-- changed customTitle / category / customIconUrl was never reconciled. A rename
-- that missed simply stayed wrong forever.
--
-- The flag makes "still owed to the PDS" a fact rather than a guess. Sync
-- repairs exactly the rows carrying it, so it never has to infer intent by
-- diffing the two sides — which it cannot do safely in the other direction
-- anyway: a PDS record missing from D1 is usually over the plan's mirror cap or
-- past the listing's page limit, not deleted. This flag only ever drives
-- *updates*; nothing here deletes from the user's repo.
--
-- Local servicing state (`active`, `user_parked`) is deliberately not covered:
-- parking is plan capacity, not an unsubscribe, and is never written to the PDS.
ALTER TABLE subscriptions_cache ADD COLUMN pds_dirty INTEGER NOT NULL DEFAULT 0;

-- Existing rows start clean. Backfilling 1 would queue a repair push of every
-- subscription for every user on the first sync after deploy, to fix drift we
-- have no evidence of; genuinely stale records are rare and the next edit to one
-- marks it anyway.
CREATE INDEX IF NOT EXISTS idx_subscriptions_cache_pds_dirty
  ON subscriptions_cache (user_did)
  WHERE pds_dirty = 1;
