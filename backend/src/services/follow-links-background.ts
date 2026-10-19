// From your follows, refreshed while the reader is away. See
// docs/plans/FOLLOWS_LINKS_PLAN.md, "Background refresh".
//
// The read path still refreshes on view (follow-links.ts); this keeps the
// shares fresh between visits for readers who use them: anyone who opened
// follows links in the last week, and Supporters with a saved search that
// covers them. The minute cron picks the readers who are due and hands each to
// their own FollowLinksPoller, so every refresh gets an invocation's whole
// D1/subrequest budget rather than sharing the cron's.

import type { Env } from '../types';
import { FOLLOW_LINKS_SCOPE_DENIED } from './follow-links-store';
import { entitledTiers, SAVED_SEARCH_ENABLED_KEY } from './saved-search';
import { log, serializeError } from '../utils/logger';

/** How often a background reader's shares are refreshed. */
export const FOLLOW_LINKS_BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
/** A reader who opened follows links within this long is kept fresh. */
export const FOLLOW_LINKS_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Readers handed off per cron minute. At the 30-minute interval this keeps up
 * with 600 background readers; past that, the most overdue go first.
 */
export const BACKGROUND_REFRESHES_PER_MINUTE = 20;
/** last_seen_at is written at most this often per reader, to spare a write per view. */
export const SEEN_STAMP_MS = 60 * 60 * 1000;
/** Operator switch in sync_state: only an explicit '0' stops the background refresh. */
export const FOLLOW_LINKS_BACKGROUND_KEY = 'follow_links_background_enabled';
/** The channel source key for follows links (frontend utils/sourceKeys.ts). */
const FOLLOWS_SOURCE_KEY = 'bsky~follows';

/**
 * Record that the reader opened follows links, which keeps them in the background
 * set. Only an existing row: a reader's first view creates it in the refresh it
 * starts, and inserting one here would race that refresh's claim and lose it.
 * The client re-polls while that first refresh gathers, which stamps it.
 */
export async function markFollowLinksSeen(env: Env, did: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `UPDATE follow_link_sync SET last_seen_at = ?2
      WHERE user_did = ?1 AND (last_seen_at IS NULL OR last_seen_at < ?3)`
  )
    .bind(did, now, now - SEEN_STAMP_MS)
    .run();
}

/**
 * Readers whose follows links are due a background refresh, most overdue first.
 *
 * A reader qualifies by opening follows links in the last week, or, once
 * they've turned follows links on (a first refresh finished), by having a
 * saved search, on a plan that matches them, whose sources take in follows
 * links: 'include' naming them, 'exclude' not naming them, or 'all' when the
 * reader shows follows links in Everything (frontend utils/sourceFilter.ts).
 * Due means neither a refresh nor a hand-off in the last interval. A reader
 * whose PDS refused the timeline for want of scope waits for the read path,
 * which asks them to grant it again.
 */
export async function selectDueReaders(
  env: Env,
  now = Date.now(),
  limit = BACKGROUND_REFRESHES_PER_MINUTE
): Promise<string[]> {
  const tiers = entitledTiers();
  // Numbered after the fixed parameters: a bare `?` would take the number after
  // the highest one written before it, colliding with ?4.
  const tierList = tiers.length > 0 ? tiers.map((_, i) => `?${8 + i}`).join(',') : 'NULL';
  const rows = await env.DB.prepare(
    `WITH candidates AS (
       SELECT user_did FROM follow_link_sync WHERE last_seen_at >= ?1
       UNION
       SELECT q.user_did FROM saved_queries q
         JOIN users u ON u.did = q.user_did
         LEFT JOIN follow_link_sync fs ON fs.user_did = q.user_did
        WHERE (SELECT value FROM sync_state WHERE key = ?2) = '1'
          AND fs.complete = 1
          AND u.tier IN (${tierList})
          AND CASE q.source_mode
                WHEN 'include' THEN EXISTS (SELECT 1 FROM json_each(q.source_keys) WHERE value = ?3)
                WHEN 'exclude' THEN NOT EXISTS (SELECT 1 FROM json_each(q.source_keys) WHERE value = ?3)
                ELSE fs.in_everything = 1
              END
     )
     SELECT c.user_did FROM candidates c
       LEFT JOIN follow_link_sync s ON s.user_did = c.user_did
      WHERE COALESCE((SELECT value FROM sync_state WHERE key = ?4), '1') != '0'
        AND COALESCE(s.last_poll_at, 0) < ?5
        AND COALESCE(s.bg_attempt_at, 0) < ?5
        AND COALESCE(s.last_error, '') != ?6
      ORDER BY MAX(COALESCE(s.last_poll_at, 0), COALESCE(s.bg_attempt_at, 0))
      LIMIT ?7`
  )
    .bind(
      now - FOLLOW_LINKS_ACTIVE_MS,
      SAVED_SEARCH_ENABLED_KEY,
      FOLLOWS_SOURCE_KEY,
      FOLLOW_LINKS_BACKGROUND_KEY,
      now - FOLLOW_LINKS_BACKGROUND_INTERVAL_MS,
      FOLLOW_LINKS_SCOPE_DENIED,
      limit,
      ...tiers
    )
    .all<{ user_did: string }>();
  return (rows.results ?? []).map((r) => r.user_did);
}

export function followLinksPollerStub(env: Env, did: string) {
  return env.FOLLOW_LINKS_POLLER.get(env.FOLLOW_LINKS_POLLER.idFromName(did));
}

/**
 * The minute cron's phase: stamp the due readers as handed off, then refresh
 * each in their own poller. The stamp comes first so a slow refresh isn't
 * handed off again by the next minute's cron.
 */
export async function dispatchBackgroundFollowLinks(env: Env, now = Date.now()): Promise<void> {
  const dids = await selectDueReaders(env, now);
  if (dids.length === 0) return;

  await env.DB.batch(
    dids.map((did) =>
      env.DB.prepare(
        `INSERT INTO follow_link_sync (user_did, bg_attempt_at) VALUES (?1, ?2)
         ON CONFLICT(user_did) DO UPDATE SET bg_attempt_at = ?2`
      ).bind(did, now)
    )
  );

  const results = await Promise.allSettled(
    dids.map((did) => followLinksPollerStub(env, did).refresh(did))
  );
  const outcomes: Record<string, number> = {};
  for (const [i, r] of results.entries()) {
    const key = r.status === 'fulfilled' ? r.value : 'threw';
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    if (r.status === 'rejected') {
      log.warn('follow_links_background_threw', { did: dids[i], ...serializeError(r.reason) });
    }
  }
  log.info('follow_links_background', { readers: dids.length, ...outcomes });
}
