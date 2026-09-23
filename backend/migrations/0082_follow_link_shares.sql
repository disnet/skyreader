-- From your follows: the links people you follow share on Bluesky, collected from
-- each reader's own Following timeline (app.bsky.feed.getTimeline, proxied through
-- their PDS). See docs/plans/FOLLOWS_LINKS_PLAN.md.
--
-- Per-reader rows, short-lived: the surface is "what is being shared now", so
-- the hourly cron drops shares older than 7 days. All times are ms.

-- One row per (reader, post, sharer). A repost is keyed on the reposted post and
-- the reposter, so two follows reposting the same post are two shares.
CREATE TABLE IF NOT EXISTS follow_link_shares (
    user_did TEXT NOT NULL,
    post_uri TEXT NOT NULL,
    sharer_did TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- 'post' | 'quote' | 'repost'
    url TEXT NOT NULL,                  -- as posted
    url_normalized TEXT NOT NULL,       -- normalizeArticleUrl(), the grouping key
    post_text TEXT,                     -- the sharer's words, truncated
    card_title TEXT,                    -- NULL when the link was a bare facet
    card_description TEXT,
    card_thumb TEXT,
    sharer_handle TEXT,                 -- denormalized: the timeline hydrates it
    sharer_name TEXT,
    sharer_avatar TEXT,
    shared_at INTEGER NOT NULL,         -- post indexedAt, or the repost's
    PRIMARY KEY (user_did, post_uri, sharer_did),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follow_link_shares_user_time
    ON follow_link_shares(user_did, shared_at);
CREATE INDEX IF NOT EXISTS idx_follow_link_shares_time
    ON follow_link_shares(shared_at);

-- The reader's Discussion panel asks "did anyone I follow share this URL?"
CREATE INDEX IF NOT EXISTS idx_follow_link_shares_user_url
    ON follow_link_shares(user_did, url_normalized);

-- Refresh bookkeeping, one row per reader. `last_poll_at` is both the gate and
-- the lock (compare-and-set, like room_snapshots). `newest_seen_at` is the
-- high-water mark an incremental refresh pages back to; it only advances when a
-- refresh reached it, so a page that fails mid-walk leaves no gap behind it.
CREATE TABLE IF NOT EXISTS follow_link_sync (
    user_did TEXT PRIMARY KEY,
    last_poll_at INTEGER NOT NULL DEFAULT 0,
    newest_seen_at INTEGER,
    complete INTEGER NOT NULL DEFAULT 0, -- a first refresh has finished
    last_error TEXT,
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

-- What the reader did with a link, keyed by URL so it holds across every share
-- of it. Server-side so it agrees across devices, like read state elsewhere.
CREATE TABLE IF NOT EXISTS follow_link_state (
    user_did TEXT NOT NULL,
    url_normalized TEXT NOT NULL,
    opened_at INTEGER,
    dismissed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_did, url_normalized),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follow_link_state_updated
    ON follow_link_state(updated_at);
