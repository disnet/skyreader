-- Add source_type and subject_did columns to subscriptions_cache
-- for AT Protocol content stream subscriptions
ALTER TABLE subscriptions_cache ADD COLUMN source_type TEXT DEFAULT NULL;
ALTER TABLE subscriptions_cache ADD COLUMN subject_did TEXT DEFAULT NULL;

-- Index for querying subscriptions by source type (e.g., find all atproto.shares subs for a user)
CREATE INDEX idx_subs_cache_source ON subscriptions_cache(user_did, source_type);

-- Index for querying which users subscribe to a given DID's content
CREATE INDEX idx_subs_cache_subject ON subscriptions_cache(subject_did);
