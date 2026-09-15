-- Reading Rooms: materialize each room's article list in D1.
--
-- A room IS a Semble/Margin collection, and until now GET /api/rooms resolved it
-- live: list the owner's membership records, ask Constellation for everyone
-- else's, then fetch every item record off whichever PDS holds it — one or two
-- subrequests per article, on the request path, on every open, from an endpoint
-- that answers signed-out visitors. A Worker invocation caps outbound fetches at
-- 1000, so a busy room could not be read at all, and a quiet one still paid the
-- whole fan-out per reader.
--
-- The same shape backed saves already use (0067): serve the last good snapshot
-- from D1, refresh it in the background. Rooms add one thing: the refresh is
-- INCREMENTAL. A membership record is resolved once, keyed by its at-uri, and
-- later polls only resolve links they have not seen, so a poll costs what
-- changed, not what the room holds. A room too big for one poll fills in over
-- several. See docs/plans/READING_ROOMS_SPIKE.md ("Materialized rooms").
--
-- room_reads (0077) is unchanged: read counts stay private, aggregate, in D1.

-- One row per room we have opened. `record` is the collection record itself
-- (Semble's accessType/collaborators decide canAdd), refreshed each poll.
-- `last_poll_at` is both the retry gate and the lock: a poll claims the room by
-- advancing it conditionally, so two readers opening a stale room start one
-- refresh, not two. `complete` says whether the members table is the whole list.
CREATE TABLE IF NOT EXISTS room_snapshots (
    collection_uri   TEXT PRIMARY KEY,   -- the room's identity
    provider         TEXT NOT NULL,      -- 'semble' | 'margin'
    owner_did        TEXT NOT NULL,
    name             TEXT,
    description      TEXT,
    record           TEXT NOT NULL,      -- JSON: the collection record, for canAdd
    cid              TEXT NOT NULL,
    complete         INTEGER NOT NULL DEFAULT 0,
    last_poll_at     INTEGER NOT NULL DEFAULT 0,  -- epoch ms; attempt, gate, lock
    last_complete_at INTEGER,                     -- epoch ms; last poll that saw everything
    created_at       INTEGER NOT NULL
);

-- One row per membership record (a collectionLink / collectionItem), whichever
-- repo it lives in. A row with a NULL url is a link that resolved to something
-- that is not an article (a free-text card, a deleted item): it stays so the
-- next poll does not fetch it again, and the room never shows it.
CREATE TABLE IF NOT EXISTS room_members (
    collection_uri TEXT NOT NULL,
    link_uri       TEXT NOT NULL,   -- the membership record; how a poll knows it has seen this one
    item_uri       TEXT NOT NULL,   -- what the link points at (may be cross-repo)
    url            TEXT,            -- raw web URL; NULL = resolved, not an article
    url_normalized TEXT,            -- normalizeArticleUrl(url) — the room_reads join key
    item_type      TEXT,            -- the item record's $type
    metadata       TEXT,            -- JSON: title/author/description/image off the item
    added_at       TEXT,            -- ISO, off the membership record (room order)
    resolved_at    INTEGER NOT NULL,
    PRIMARY KEY (collection_uri, link_uri)
);
CREATE INDEX IF NOT EXISTS idx_room_members_url ON room_members(collection_uri, url_normalized);
