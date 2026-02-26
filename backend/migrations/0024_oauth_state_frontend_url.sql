-- Add frontend_url column to oauth_state table for multi-frontend support
ALTER TABLE oauth_state ADD COLUMN frontend_url TEXT;
