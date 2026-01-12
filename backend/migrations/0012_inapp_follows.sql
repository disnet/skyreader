-- In-app follows table (separate from Bluesky follows in follows_cache)
CREATE TABLE inapp_follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_did TEXT NOT NULL,
    following_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    record_uri TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(follower_did, following_did)
);

CREATE INDEX idx_inapp_follows_follower ON inapp_follows(follower_did);
CREATE INDEX idx_inapp_follows_following ON inapp_follows(following_did);
CREATE INDEX idx_inapp_follows_rkey ON inapp_follows(follower_did, rkey);
