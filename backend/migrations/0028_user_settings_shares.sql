-- Add last_pds_sync_shares column to user_settings table
ALTER TABLE user_settings ADD COLUMN last_pds_sync_shares INTEGER;
