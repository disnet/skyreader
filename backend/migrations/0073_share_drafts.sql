-- Cross-device linkblog share drafts (D1 only, no PDS record — drafts are
-- private unposted words; they become public only via the linkblog write path).
-- Modeled on magazines (0059): ?since= deltas + tombstones, hourly cron GC.
--
-- Two clocks, mirroring what the client already keeps: `updated_at` is the
-- server clock (unix seconds) that drives the delta cursor, and
-- `client_updated_at` is the client's ms clock that drives last-write-wins on
-- upsert and the drafts-list sort. `draft` is an opaque JSON blob (blocks +
-- article metadata + repostUri/itemKey) the backend never interprets.
CREATE TABLE IF NOT EXISTS share_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    article_url TEXT NOT NULL,          -- dedupe key, same as the linkblog's
    draft TEXT NOT NULL,                -- JSON: full ShareDraft
    client_updated_at INTEGER NOT NULL, -- client ms clock; LWW + list sort
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted_at INTEGER,
    UNIQUE(user_did, article_url),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_drafts_user ON share_drafts(user_did);
CREATE INDEX IF NOT EXISTS idx_share_drafts_user_updated ON share_drafts(user_did, updated_at);
