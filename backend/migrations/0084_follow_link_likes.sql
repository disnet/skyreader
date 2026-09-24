-- From your follows: likes on each sharer's own post, which pick whose words a
-- link's card quotes (the most-liked). Read from the timeline when a share is
-- first seen, then re-read from the public appview once stale, only for links
-- two or more follows shared with words. See docs/plans/FOLLOWS_LINKS_PLAN.md.
ALTER TABLE follow_link_shares ADD COLUMN like_count INTEGER;       -- NULL for a repost, or unknown
ALTER TABLE follow_link_shares ADD COLUMN likes_checked_at INTEGER; -- ms, when like_count was last read

-- Whether the reader wants follows links in Everything (every "All sources"
-- view): NULL until they've been asked, then 0 or 1. On the sync row because
-- that's the one per-reader follows row; answering "no" before granting the
-- timeline permission makes the row early, which the refresh claim handles.
ALTER TABLE follow_link_sync ADD COLUMN in_everything INTEGER;
