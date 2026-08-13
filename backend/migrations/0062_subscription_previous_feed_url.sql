-- Preserve the prior publication URI while a linkblog follower is being moved.
-- Atmospheric reconciliation uses it to delete the old portable graph edge
-- before confirming the replacement edge.
ALTER TABLE subscriptions_cache ADD COLUMN atmosphere_previous_feed_url TEXT DEFAULT NULL;
