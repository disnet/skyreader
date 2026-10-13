-- Bluesky likes and bookmarks as sources (services/bsky-sources.ts). The source
-- itself is a private, local-only subscriptions_cache row (feed_url
-- `bsky-likes:<did>` / `bsky-bookmarks:<did>`) whose link posts are ingested into
-- feed_items; this table only remembers how far each one has been walked.
--
-- kind:           'likes' | 'bookmarks'
-- last_poll_at:   ms; the refresh gate and the claim (compare-and-set)
-- newest_seen:    high-water mark — a like's rkey (a TID, so it sorts by time) or
--                 a bookmark's createdAt; a refresh stops walking once it passes it
-- last_error:     the last refresh's failure, 'scope_denied' when the PDS refused
CREATE TABLE IF NOT EXISTS bsky_source_sync (
    user_did TEXT NOT NULL,
    kind TEXT NOT NULL,
    last_poll_at INTEGER NOT NULL DEFAULT 0,
    newest_seen TEXT,
    last_error TEXT,
    PRIMARY KEY (user_did, kind),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);
