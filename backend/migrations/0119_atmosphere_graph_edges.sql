-- standard.site follows (`site.standard.graph.subscription`) made in any app,
-- imported into Skyreader whether or not the reader has Atmospheric sync on
-- (services/atmosphere-graph-import.ts).
--
-- One row per graph record we have seen, keyed by its rkey: a Jetstream delete
-- carries only the rkey, so this is how an unfollow in Leaflet finds the
-- publication it was for. A record is imported the first time it is seen and
-- never again, which is what keeps a reader's unsubscribe in Skyreader from
-- being undone by the follow still sitting in their graph (with sync off we
-- never write to it). `record_uri` is the subscription the import created, and
-- only that row is removed when the follow goes: NULL when the reader already
-- followed the publication here.
CREATE TABLE atmosphere_graph_edges (
  user_did        TEXT NOT NULL,
  rkey            TEXT NOT NULL,
  publication_uri TEXT NOT NULL,
  record_uri      TEXT,
  PRIMARY KEY (user_did, rkey)
);
CREATE INDEX idx_atmosphere_graph_edges_pub ON atmosphere_graph_edges (user_did, publication_uri);

-- When each reader's graph was last listed in full. The cron lists the
-- never-listed first, then re-lists everyone weekly to catch what the firehose
-- missed. `queued_at` keeps one reader from being queued every minute while
-- their scan waits in the queue.
CREATE TABLE atmosphere_graph_scans (
  user_did   TEXT PRIMARY KEY,
  scanned_at INTEGER,
  queued_at  INTEGER
);
