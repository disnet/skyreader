-- Pinned Shelf collections: the ones a reader keeps on the Shelf's one-line
-- collection row, ahead of the recently opened ones. Order follows `position`.
ALTER TABLE shelf_collections ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
