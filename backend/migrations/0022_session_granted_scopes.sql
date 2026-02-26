-- Add granted_scopes column to sessions table
-- This tracks what OAuth scopes were granted when the session was created
-- Allows us to detect when a session needs re-auth due to scope changes

ALTER TABLE sessions ADD COLUMN granted_scopes TEXT;
