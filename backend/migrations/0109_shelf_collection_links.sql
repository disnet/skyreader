-- Linked Shelf collections: a Shelf collection kept in step with one of the
-- reader's Semble or Margin collections, both ways (services/shelf-link.ts).
--
-- The Shelf collection stays canonical for what Skyreader shows: its order, and
-- members the foreign side can't hold (uploads). The foreign collection is
-- reconciled against it by diff, using the membership records we last saw as
-- the baseline, so a change on either side is told apart from the other.

ALTER TABLE shelf_collections ADD COLUMN link_provider TEXT;      -- 'semble' | 'margin'
ALTER TABLE shelf_collections ADD COLUMN link_uri TEXT;           -- the foreign collection's at-uri
ALTER TABLE shelf_collections ADD COLUMN link_synced_at INTEGER;  -- ms; last finished reconcile
-- Set by a local change (add, remove, a deleted save) so the next reconcile runs
-- past the gate, and so one already running goes round again.
ALTER TABLE shelf_collections ADD COLUMN link_dirty INTEGER NOT NULL DEFAULT 0;
-- ms; a reconcile holds the collection until then (a crashed one lets go by expiry).
ALTER TABLE shelf_collections ADD COLUMN link_lock_until INTEGER;

-- One Shelf collection per foreign collection: two linked to the same one would
-- each read the other's additions as the reader's.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shelf_collections_link
  ON shelf_collections(user_did, link_uri) WHERE link_uri IS NOT NULL;

-- The baseline: every membership record (collectionLink / collectionItem) of the
-- linked collection as of the last reconcile, with what it resolved to. A record
-- the listing names that isn't here was added on the other side; one here the
-- listing no longer names was removed there. `url_normalized` is NULL for a
-- member that isn't an article (a free-text card), kept so it isn't fetched again.
-- Rows carry the foreign collection they were seen in, so rows left by an earlier
-- link are never read as this one's.
CREATE TABLE IF NOT EXISTS shelf_link_members (
  user_did TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  external_collection TEXT NOT NULL,
  link_uri TEXT NOT NULL,
  item_uri TEXT NOT NULL,
  url_normalized TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_did, collection_id, link_uri)
);
