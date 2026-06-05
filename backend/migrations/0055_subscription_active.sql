-- Parked feeds: `active` distinguishes subscriptions Skyreader actively services
-- (polls + shows in the reader) from ones it only mirrors. The tier limit counts
-- active subs only; parked subs are unlimited local mirror rows of PDS records the
-- user owns but that exceed their plan's active capacity.
--
-- `active` is purely local servicing state — it is NEVER written to the PDS record.
-- The PDS keeps the full, untouched subscription set (portable across the Atmosphere);
-- parking only governs what this app polls and displays. Existing rows default to
-- active, preserving current behavior on migrate.
ALTER TABLE subscriptions_cache ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- Active-vs-parked is filtered per user on every reader/poll read.
CREATE INDEX IF NOT EXISTS idx_subs_cache_active ON subscriptions_cache(user_did, active);
