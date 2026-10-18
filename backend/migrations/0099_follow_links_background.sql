-- From your follows, refreshed in the background (docs/plans/FOLLOWS_LINKS_PLAN.md,
-- "Background refresh").
--
-- The OAuth client a session was authorized under. A token refresh has to name
-- the same client_id, which a request gives by its own URL; a background refresh
-- has no request, so it reads it from here. Written at sign-in and on every
-- request-side refresh, so a session from before this column fills in the next
-- time its owner's token refreshes.
ALTER TABLE sessions ADD COLUMN client_id TEXT;

-- When the reader last opened follows links (ms). last_poll_at can't say this:
-- the background refresh moves it too.
ALTER TABLE follow_link_sync ADD COLUMN last_seen_at INTEGER;
-- When the cron last handed this reader to the background refresh (ms), whether
-- or not the refresh ran. Spaces attempts out for a reader whose session can't
-- refresh right now.
ALTER TABLE follow_link_sync ADD COLUMN bg_attempt_at INTEGER;
