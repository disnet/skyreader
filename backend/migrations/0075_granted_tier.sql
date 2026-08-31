-- Comped tiers survive Polar.
--
-- Before paid plans existed, supporters were granted their tier by hand from
-- the admin app. Those grants were open-ended, so they must not be an artifact
-- of "nobody has cancelled them yet": granted_tier records the tier a user is
-- entitled to for free, independent of anything Polar says.
--
-- Two things read it:
--   * the Polar webhook's empty-state downgrade falls back to granted_tier
--     instead of 'free', so an early supporter who chooses to start paying and
--     later cancels lands back on their grant, not on the free tier;
--   * the frontend (via /api/auth/me) tells a granted supporter their access is
--     a thank-you they keep, rather than offering them a billing portal that
--     has no Polar customer behind it.
--
-- The admin app keeps this column in step with users.tier: granting a tier sets
-- it, and setting a user back to 'free' clears it (the grant is revoked).
ALTER TABLE users ADD COLUMN granted_tier TEXT;

-- Backfill: every non-free tier that Polar didn't pay for is a grant. Rows with
-- tier_source NULL are pre-Polar legacy grants (see migration 0073); 'admin' is
-- an explicit grant from the admin app. Polar-sourced rows are left alone.
UPDATE users
   SET granted_tier = tier
 WHERE tier IS NOT NULL
   AND tier != 'free'
   AND (tier_source IS NULL OR tier_source = 'admin');
