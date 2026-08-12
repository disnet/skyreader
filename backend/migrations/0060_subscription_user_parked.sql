-- Distinguish subscriptions explicitly parked by the user from subscriptions
-- automatically parked because the plan's active capacity was full.
-- Like `active`, this is local servicing state and is never written to the PDS.
ALTER TABLE subscriptions_cache ADD COLUMN user_parked INTEGER NOT NULL DEFAULT 0;

-- Preserve every existing user's current choices. Older auto-parked rows become
-- sticky too, which is safer than unexpectedly reactivating them after deploy.
UPDATE subscriptions_cache SET user_parked = 1 WHERE active = 0;
