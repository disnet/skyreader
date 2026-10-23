-- Liking a Semble connection someone drew off a save (routes/saved-connections.ts).
--
-- A like is a community.lexicon.interaction.like record in the reader's own repo,
-- whose subject is a strongRef (uri + cid) to the network.cosmik.connection. The
-- poller now keeps each connection's cid so a like can point at the version the
-- reader saw; rows indexed before this have none and look it up when liked.
ALTER TABLE semble_connections ADD COLUMN cid TEXT;

-- Which connections a reader has liked, and the like record's rkey so an unlike
-- can delete it. Claimed before the PDS write, as recommendations are, so two
-- taps racing each other mint one record.
CREATE TABLE connection_likes (
  user_did    TEXT NOT NULL,
  subject_uri TEXT NOT NULL,              -- at://<curator>/network.cosmik.connection/<rkey>
  rkey        TEXT NOT NULL,              -- the like's rkey in the reader's repo
  created_at  INTEGER NOT NULL,           -- ms
  PRIMARY KEY (user_did, subject_uri)
);
