-- Add refresh_in_progress column for optimistic locking
-- Prevents concurrent refresh race conditions
ALTER TABLE sessions ADD COLUMN refresh_in_progress INTEGER;
