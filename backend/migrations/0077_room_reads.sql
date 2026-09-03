-- Reading Rooms spike: anonymous per-article read counts, scoped to the room.
--
-- A "read" is counted only when a user opens an article FROM the room surface
-- (never joined against existing read state — joining a room must not
-- retroactively disclose reading history; see docs/plans/READING_ROOMS_SPIKE.md).
-- Counts served as COUNT(DISTINCT did) per (collection_uri, url_normalized);
-- never written to public records. No rooms/room_members tables: room identity
-- is the collection at-uri, membership lives in members' repos (readAlong records).
CREATE TABLE IF NOT EXISTS room_reads (
    collection_uri TEXT NOT NULL,  -- the Semble/Margin collection at-uri (the room's identity)
    url_normalized TEXT NOT NULL,  -- normalizeArticleUrl(url) — same key as saved_articles
    did            TEXT NOT NULL,  -- the reader (private; only ever aggregated)
    read_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (collection_uri, url_normalized, did)
);
