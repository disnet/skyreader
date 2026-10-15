-- Shelf collections: user-made, ordered groups of saves (see docs/plans/SHELF_PLAN.md).
--
-- Private and native to Skyreader: nothing here reaches the PDS or a
-- Semble/Margin backing collection. A collection is built so it can later be
-- exported as one (or opened as a reading room), which is why it carries a
-- description and an explicit item order rather than being a tag.
--
-- Ids are client-minted TIDs, so a collection can be created optimistically and
-- addressed before the server has answered.

CREATE TABLE IF NOT EXISTS shelf_collections (
  user_did TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- Sidebar / picker order. REAL so a move can land between two neighbours
  -- without renumbering the rest.
  position REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_did, id)
);

-- Members reference the save by its rkey: stable from the moment the client
-- mints it (optimistic saves included), and present on uploads, which have no
-- URL. A save's delete removes its memberships (routes/saved.ts); a member
-- whose save is gone for any other reason is skipped by the client.
CREATE TABLE IF NOT EXISTS shelf_collection_items (
  user_did TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  saved_rkey TEXT NOT NULL,
  position REAL NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_did, collection_id, saved_rkey)
);

CREATE INDEX IF NOT EXISTS idx_shelf_collection_items_rkey
  ON shelf_collection_items(user_did, saved_rkey);
