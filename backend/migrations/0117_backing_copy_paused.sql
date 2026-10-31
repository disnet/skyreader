-- The reader can pause a background copy into their Semble/Margin collection
-- and resume it later (services/backing/copy-queue.ts). A paused run keeps its
-- queue, and nothing starts it again but the reader.
ALTER TABLE backing_copy_runs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
