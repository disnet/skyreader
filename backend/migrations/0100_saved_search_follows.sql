-- Saved searches over follows links (docs/plans/SAVED_SEARCH_CHANNELS.md,
-- rollout step 2).
--
-- When a share row was first written (ms). The matcher walks new shares by this,
-- not by shared_at: a refresh that catches up after a gap writes shares whose
-- posts are hours old. Rows from before this column stay NULL and are only
-- reached by a query's backfill.
ALTER TABLE follow_link_shares ADD COLUMN first_seen_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_follow_link_shares_first_seen
    ON follow_link_shares(first_seen_at, user_did, post_uri, sharer_did);

-- How far a query's backfill has walked its reader's stored shares: '' before
-- it starts, 'done' after, otherwise the last share it finished (JSON).
ALTER TABLE saved_queries ADD COLUMN backfill_follows_after TEXT NOT NULL DEFAULT '';

-- Queries that already take in follows links backfill their stored week of
-- shares once. Their feed and author cursors are already at the end, so the
-- backfill goes straight to the shares. (Matches resolveQueryScope: include
-- naming bsky~follows, exclude not naming it, all when follows show in
-- Everything.)
UPDATE saved_queries SET backfill_state = 'pending'
 WHERE CASE source_mode
         WHEN 'include' THEN EXISTS (SELECT 1 FROM json_each(source_keys) WHERE value = 'bsky~follows')
         WHEN 'exclude' THEN NOT EXISTS (SELECT 1 FROM json_each(source_keys) WHERE value = 'bsky~follows')
         ELSE EXISTS (SELECT 1 FROM follow_link_sync fs
                       WHERE fs.user_did = saved_queries.user_did AND fs.in_everything = 1)
       END;

-- A follows link matched on its post text and card only, because the reader's
-- daily extraction budget was spent before its article could be read.
ALTER TABLE channel_matches ADD COLUMN body_skipped INTEGER NOT NULL DEFAULT 0;
-- Follows matches only: the link's url, title, description and thumb (JSON).
-- Shares are dropped after 7 days and matches are kept for 90, so the card
-- has to live on the match.
ALTER TABLE channel_matches ADD COLUMN link_json TEXT;

-- Every source a matched story arrived from, the first one included. One story
-- is one channel_matches row however it arrives; this is what lets the channel
-- say "from Feed name · shared by Maya and 2 others".
CREATE TABLE IF NOT EXISTS channel_match_sources (
    user_did TEXT NOT NULL,
    channel_uuid TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    source_kind TEXT NOT NULL,      -- 'feed' | 'document' | 'follows'
    source_ref TEXT NOT NULL,       -- feed_url, author DID, or the sharer's DID
    item_key TEXT NOT NULL,         -- guid, document URI, or the sharer's post URI
    meta_json TEXT,                 -- follows: the sharer's handle, name and avatar
    matched_at INTEGER NOT NULL,    -- ms
    PRIMARY KEY (user_did, channel_uuid, dedup_key, source_kind, source_ref),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channel_match_sources_matched
    ON channel_match_sources(matched_at);
