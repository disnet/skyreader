-- Add PDS sync columns to user_settings table (created in 0017_leaflet_sync.sql)
ALTER TABLE user_settings ADD COLUMN pds_sync_enabled INTEGER DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN last_pds_sync_subscriptions INTEGER;
ALTER TABLE user_settings ADD COLUMN last_pds_sync_read_positions INTEGER;

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_user_settings_sync_enabled ON user_settings(pds_sync_enabled) WHERE pds_sync_enabled = 1;
