// A newly added feed starts with only its newest few items unread.
//
// Everything a feed has published before you subscribe is its back catalogue,
// and an OPML import of hundreds of feeds used to turn that into thousands of
// unread items the reader had to clear before anything new was visible. So a
// subscription made by adding a feed (POST /api/subscriptions, or a bulk import)
// carries `skip_backlog_at`, the time it was made, and for a day after that
// every item the feed had published before then, except its newest
// NEW_FEED_UNREAD_ITEMS, is marked read.
//
// For a day, rather than once, because the items arrive when they arrive: a
// feed someone else follows is already in the archive, but a feed new to it
// comes in with its first crawl, which may be the subscribe-time warm, the
// client's pull-through, or the crawler minutes later, in one push or several.
// So the skip runs wherever a new subscription's items can show up: after the
// subscribe (`skipBacklogForUser`, for whatever is already archived) and after
// every ingest that brings a feed new items (`skipBacklogForFeeds`, from
// `ingestBatch`), newest subscriptions first. Repeating it is safe:
// it only ever touches items published before the subscription, and never a row
// already there.
//
// Known gaps: a feed with no dates counts its items by when the crawler first saw
// them, so one first crawled after the subscribe isn't skipped. Only the feed's
// newest-100 window is skipped; "Show older" past it is as before. And opening a
// skipped item doesn't send a new mark-read (it already reads as read), so it
// reaches search only once it's highlighted, saved, or marked unread and read.
//
// A skipped item is a `read` row, so unread counts, the timeline and every device
// agree through the ordinary read path; there is no second read-state authority.
// Its props carry `skipped: true`, which keeps the reader's search index to what
// they actually read (services/search-index.ts). DO NOTHING on conflict: a row
// already there, read or explicitly marked unread, is the reader's own choice.

import type { Env } from '../types';
import { ARTICLE_WINDOW_PER_FEED } from '../config/window';
import { log, serializeError } from '../utils/logger';

/** Items a newly added feed starts with unread: its newest few. */
export const NEW_FEED_UNREAD_ITEMS = 10;

/** How long after subscribing the skip is still owed. */
export const SKIP_BACKLOG_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Most subscriptions one call skips. Each is one statement, and the ingest path
 * that calls this already spends a statement per item, so this keeps it well
 * inside the invocation's D1 budget. What's left over is picked up by the next
 * ingest of that feed, or by the user's job.
 */
export const MAX_SKIPS_PER_CALL = 100;

/**
 * A page of the user's job. Smaller than MAX_SKIPS_PER_CALL so a page stays
 * inside the queue consumer's per-job share of the D1 budget.
 */
export const SKIPS_PER_USER_PAGE = 50;

const SKIP_BATCH_SIZE = 50;
const IN_CHUNK = 90;

interface PendingSkip {
  id: number;
  user_did: string;
  feed_url: string;
  skip_backlog_at: number;
}

/**
 * One statement: mark read every item in the feed's window that was published
 * before the reader subscribed, except the newest NEW_FEED_UNREAD_ITEMS of them.
 * Ordered as the timeline orders a feed (published_at DESC, seq DESC), so the
 * ones left unread are the ones the reader sees first. An item with no date
 * counts by when the crawler first saw it.
 */
export function skipBacklogStatement(
  env: Env,
  userDid: string,
  feedUrl: string,
  subscribedAtMs: number,
  nowMs: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO item_labels_cache
       (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
     SELECT ?1, w.guid, 'article', 'read',
            json_object('readAt', ?2,
                        'itemUrl', json_extract(w.item_json, '$.url'),
                        'itemTitle', json_extract(w.item_json, '$.title'),
                        'skipped', json('true')),
            NULL, ?3, ?3, ?2
       FROM (SELECT fi.guid, fi.item_json FROM feed_items fi
              WHERE fi.feed_url = ?4
                AND COALESCE(fi.published_at, fi.first_seen_at) < ?7
              ORDER BY fi.published_at DESC, fi.seq DESC
              LIMIT ?5 OFFSET ?6) w
      WHERE true
     ON CONFLICT(user_did, item_key, label) DO NOTHING`
  ).bind(
    userDid,
    nowMs,
    Math.floor(nowMs / 1000),
    feedUrl,
    ARTICLE_WINDOW_PER_FEED - NEW_FEED_UNREAD_ITEMS,
    NEW_FEED_UNREAD_ITEMS,
    subscribedAtMs
  );
}

async function runSkips(env: Env, pending: PendingSkip[], nowMs: number): Promise<void> {
  for (let i = 0; i < pending.length; i += SKIP_BATCH_SIZE) {
    await env.DB.batch(
      pending
        .slice(i, i + SKIP_BATCH_SIZE)
        .map((p) => skipBacklogStatement(env, p.user_did, p.feed_url, p.skip_backlog_at, nowMs))
    );
  }
}

/**
 * After an ingest: skip the back catalogue the touched feeds brought in, for
 * every subscription still owed it. Best-effort: a failure here is logged and
 * never fails the ingest, which has already written its items. The crawler's
 * next push of the feed, or the user's job, tries again.
 */
export async function skipBacklogForFeeds(env: Env, feedUrls: string[]): Promise<void> {
  if (feedUrls.length === 0) return;
  const nowMs = Date.now();
  try {
    const pending: PendingSkip[] = [];
    for (let i = 0; i < feedUrls.length && pending.length < MAX_SKIPS_PER_CALL; i += IN_CHUNK) {
      const chunk = feedUrls.slice(i, i + IN_CHUNK);
      const { results } = await env.DB.prepare(
        `SELECT id, user_did, feed_url, skip_backlog_at FROM subscriptions_cache
          WHERE skip_backlog_at IS NOT NULL AND skip_backlog_at > ?
            AND feed_url IN (${chunk.map(() => '?').join(',')})
          ORDER BY skip_backlog_at DESC
          LIMIT ?`
      )
        .bind(nowMs - SKIP_BACKLOG_WINDOW_MS, ...chunk, MAX_SKIPS_PER_CALL - pending.length)
        .all<PendingSkip>();
      pending.push(...(results ?? []));
    }
    if (pending.length === 0) return;
    if (pending.length >= MAX_SKIPS_PER_CALL) {
      log.warn('skip_backlog_capped', { feeds: feedUrls.length, cap: MAX_SKIPS_PER_CALL });
    }
    await runSkips(env, pending, nowMs);
  } catch (error) {
    log.warn('skip_backlog_failed', { path: 'ingest', ...serializeError(error) });
  }
}

/**
 * Skip the back catalogue of one reader's new subscriptions, for whatever the
 * archive already holds, a page of SKIPS_PER_USER_PAGE at a time in subscription
 * order. Returns the id to continue after, or null when that was the last page.
 * `feedUrl` narrows it to one subscription (a single add).
 */
export async function skipBacklogForUser(
  env: Env,
  did: string,
  opts: { afterId?: number; feedUrl?: string } = {}
): Promise<number | null> {
  const nowMs = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, user_did, feed_url, skip_backlog_at FROM subscriptions_cache
      WHERE user_did = ? AND skip_backlog_at IS NOT NULL AND skip_backlog_at > ?
        AND id > ? ${opts.feedUrl ? 'AND feed_url = ?' : ''}
      ORDER BY id LIMIT ?`
  )
    .bind(
      did,
      nowMs - SKIP_BACKLOG_WINDOW_MS,
      opts.afterId ?? 0,
      ...(opts.feedUrl ? [opts.feedUrl] : []),
      SKIPS_PER_USER_PAGE
    )
    .all<PendingSkip>();
  const pending = results ?? [];
  await runSkips(env, pending, nowMs);
  return pending.length === SKIPS_PER_USER_PAGE ? pending[pending.length - 1].id : null;
}

/** Hourly: forget the skips whose window has passed, so the partial index stays small. */
export async function clearExpiredBacklogSkips(env: Env, nowMs = Date.now()): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE subscriptions_cache SET skip_backlog_at = NULL
      WHERE skip_backlog_at IS NOT NULL AND skip_backlog_at <= ?`
  )
    .bind(nowMs - SKIP_BACKLOG_WINDOW_MS)
    .run();
  return result.meta?.changes ?? 0;
}
