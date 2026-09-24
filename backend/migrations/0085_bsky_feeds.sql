-- Bluesky feeds as sources: the Following timeline, or a custom feed the reader
-- pinned or saved in Bluesky, added as a source a channel can name. Only the
-- subscription lives here; posts are never stored, each channel view reads the
-- feed live through the reader's PDS. See docs/plans/BLUESKY_FEEDS_PLAN.md.
CREATE TABLE IF NOT EXISTS bsky_feeds (
    user_did TEXT NOT NULL,
    feed_uri TEXT NOT NULL,            -- 'following', or an app.bsky.feed.generator at-uri
    display_name TEXT NOT NULL,
    description TEXT,
    avatar TEXT,
    created_at INTEGER NOT NULL,       -- ms
    PRIMARY KEY (user_did, feed_uri),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);
