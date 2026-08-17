-- Rollout gate for the D1-served timeline.
--
-- `ingestActive` alone flips every client onto the timeline the instant the
-- crawler first checks in — which is the moment the backfill STARTS, not the
-- moment it finishes. The proxy stamps a heartbeat on its very first crawl-set
-- pull (seconds after the release), so without this gate every reader cold-starts
-- against a nearly-empty archive and then drags the entire ~200-items-per-feed
-- backfill through its incremental drain: the expensive global scan, at its worst
-- case, for as long as the backfill takes.
--
-- This decouples the two. Enable INGEST_URL, let the archive fill, watch the
-- proxy's `ingest.pending` trend to ~0, THEN flip this to '1'. It is also the
-- only fast way back: setting it to '0' returns every client to the legacy batch
-- path on their next poll, with no Worker deploy and no waiting out the 30-minute
-- heartbeat freshness window.
--
--   npx wrangler d1 execute skyreader --remote \
--     --command "UPDATE sync_state SET value='1', updated_at=unixepoch() WHERE key='timeline_enabled'"
--
-- Only an explicit '0' gates: an absent row means enabled, so a hand-built schema
-- or a future environment can't be silently held on the legacy path.
--
-- The value depends on whether this deployment already has readers. An existing
-- one (prod, staging) has users and a backfill ahead of it, so it starts gated and
-- an operator opens it deliberately. A fresh one (local dev, e2e, CI) has no users
-- and no backlog, so it starts open and nothing has to know this key exists.
INSERT OR IGNORE INTO sync_state (key, value, updated_at)
SELECT 'timeline_enabled',
       CASE WHEN EXISTS (SELECT 1 FROM users) THEN '0' ELSE '1' END,
       unixepoch();
