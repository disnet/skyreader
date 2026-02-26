-- Bootstrap migration (no-op for fresh installs)
--
-- This migration was originally used to mark legacy migrations as "applied"
-- in production where they were run manually before using wrangler migrations.
-- For fresh local development, this is now a no-op.
--
-- Production databases already have this applied and all tables created.
SELECT 1;
