-- Semble connections drawn off a reader's saves (docs/plans/SEMBLE_CONNECTIONS.md).
--
-- The JetstreamPoller watches `network.cosmik.connection` network-wide and keeps
-- an edge only when one of its ends is a URL someone has saved, so this holds the
-- slice of Semble's graph that touches a Skyreader Library, not all of it. Both
-- ends are stored normalized (normalizeArticleUrl), the same form as
-- saved_articles.url_key below.
CREATE TABLE semble_connections (
  uri               TEXT PRIMARY KEY,     -- at://<curator>/network.cosmik.connection/<rkey>
  curator_did       TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  source_normalized TEXT NOT NULL,
  target_url        TEXT NOT NULL,
  target_normalized TEXT NOT NULL,
  connection_type   TEXT,
  note              TEXT,
  created_at        INTEGER NOT NULL,     -- the record's createdAt (ms)
  indexed_at        INTEGER NOT NULL      -- when the poller first saw it (ms)
);
CREATE INDEX idx_semble_connections_source ON semble_connections(source_normalized);
CREATE INDEX idx_semble_connections_target ON semble_connections(target_normalized);

-- Every save's normalized URL, for matching connections. Not url_normalized:
-- that is the backing join key, unique per reader and deliberately left NULL on
-- native saves. This one is set on every save ('' for a save with no web URL),
-- may repeat, and is backfilled per reader (services/semble-connections.ts).
-- Leading with url_key serves both the ingest's "has anyone saved this?" and
-- the backfill's "which of this reader's rows are still NULL?".
ALTER TABLE saved_articles ADD COLUMN url_key TEXT;
CREATE INDEX idx_saved_articles_url_key ON saved_articles(url_key, user_did);

-- When a reader last looked at a save's connections. A connection counts as new
-- when it was indexed after this (or after the save itself, before any look).
CREATE TABLE semble_connection_seen (
  user_did  TEXT NOT NULL,
  url_key   TEXT NOT NULL,
  seen_at   INTEGER NOT NULL,
  PRIMARY KEY (user_did, url_key)
);
