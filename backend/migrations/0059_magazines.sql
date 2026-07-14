-- Durable, cross-device magazines.
--
-- A magazine is an explicitly-generated reading issue with a frozen membership:
-- its item set + order are snapshotted at generate time so it never changes when
-- new articles are saved, and it syncs across the user's devices (D1 only, no PDS
-- record). Modeled on the delta-synced item_labels_cache (0037 + tombstones 0052):
-- `?since=` deltas replay other devices' writes/deletes; the hourly cron GCs old
-- tombstones.
CREATE TABLE IF NOT EXISTS magazines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    rkey TEXT NOT NULL,            -- magazine id (client-minted TID)
    params TEXT NOT NULL,          -- JSON {order, targetMinutes, totalMinutes}
    items TEXT NOT NULL,           -- JSON ordered array of frozen item snapshots
    position TEXT,                 -- JSON {itemKey, paragraphIndex, updatedAt} | null
    title TEXT,                    -- optional display label
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted_at INTEGER,
    UNIQUE(user_did, rkey),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_magazines_user ON magazines(user_did);
CREATE INDEX IF NOT EXISTS idx_magazines_user_updated ON magazines(user_did, updated_at);
