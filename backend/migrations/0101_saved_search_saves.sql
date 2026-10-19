-- Saved searches over the reader's own saves (docs/plans/SAVED_SEARCH_CHANNELS.md,
-- "Saves"). A channel whose Library sources include every save mirrors that
-- here; the Percolator then matches new saves (by saved_articles.id) and looks
-- back over all of the reader's saves once.
ALTER TABLE saved_queries ADD COLUMN include_saves INTEGER NOT NULL DEFAULT 0;

-- How far a query's look back has walked its reader's saves: '' before it
-- starts, 'done' after, otherwise the last save it finished (JSON, newest first).
ALTER TABLE saved_queries ADD COLUMN backfill_saves_after TEXT NOT NULL DEFAULT '';
