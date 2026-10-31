-- The reader can pause a background copy into their Semble/Margin collection
-- and resume it later (services/backing/copy-queue.ts). A paused run keeps its
-- queue, and nothing starts it again but the reader.
ALTER TABLE backing_copy_runs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;

-- When the hop now copying claimed the run (NULL between hops), so resuming
-- a copy paused mid-hop waits for that hop rather than copying beside it.
ALTER TABLE backing_copy_runs ADD COLUMN claimed_at INTEGER;
