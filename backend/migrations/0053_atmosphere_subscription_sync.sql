-- Atmospheric subscription sync: keep a user's standard.site follows
-- (site.standard.graph.subscription) in sync with their Skyreader subscriptions.

-- Provenance/shadow marker on each atproto.documents/publication subscription:
-- the unixepoch when it was last confirmed mirrored in the user's graph.
-- NULL  = locally added, not yet known in the graph (edge push pending).
-- set   = known mirrored, so its later absence from the graph means the user
--         unsubscribed from the publication in another Atmospheric app, and the
--         local subscription should be removed (delete propagation).
ALTER TABLE subscriptions_cache ADD COLUMN atmosphere_synced INTEGER DEFAULT NULL;

-- Opt-in (a sub-toggle under Atmospheric sync) to import standard.site
-- subscriptions and keep them reconciled. Only effective when pds_sync_enabled.
ALTER TABLE user_settings ADD COLUMN atmosphere_sub_sync_enabled INTEGER DEFAULT 0;
