-- Links in a backed Semble/Margin collection that hold no article: a note card, a
-- card with no URL, an item that's gone. The incremental membership poll
-- (services/backing/sync.ts pollBackedMembership) skips every link it has already
-- stored, and these never get a backed_collection_members row, so without this
-- table each poll fetched every one of them again. Re-checked by the same random
-- slice as stored members; dropped when a whole listing no longer names the link.
CREATE TABLE backed_skipped_links (
  user_did            TEXT NOT NULL,
  external_collection TEXT NOT NULL,
  link_uri            TEXT NOT NULL,
  PRIMARY KEY (user_did, external_collection, link_uri)
);
