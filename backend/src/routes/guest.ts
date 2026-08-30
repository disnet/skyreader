import type { Env, FeedItem } from '../types';
import { STARTER_CHANNELS, STARTER_FEED_URLS } from '../config/starter-feeds';
import { checkRateLimit } from '../services/rate-limit';
import { readArchiveState } from './timeline';
import { timedAll, timedBatch } from '../utils/d1-timing';
import { log } from '../utils/logger';
import { handleV2FeedDiscover, warmFeedIntoArchive } from './feeds-v2';

/**
 * The unauthenticated reading surface: starter channels, a timeline over a
 * caller-supplied feed list, and the two endpoints that let a guest add a feed
 * of their own. Everything here reads (or, for `warm`, writes) the SHARED
 * archive with no account behind it, so each handler is per-IP rate limited and
 * the two write paths are additionally bounded by `feeds.guest_warmed_at` and
 * the daily counter in `guest_feed_quota` — see migrations 0073 and 0074, and
 * `claimGuestWarm` below.
 */

const MAX_FEEDS = 50;
const MAX_LIMIT = 200;
const COLD_PER_FEED = 30;
// Feeds per cold-start page. 25 × 30 items is the same order as the authed
// path's cold budget.
const COLD_FEEDS_PER_PAGE = 25;

// A guest warm re-fetches a feed at most this often; a fresher feed is a no-op.
const WARM_FRESH_SECONDS = 15 * 60;
// The read path re-warms guest-added feeds staler than this, a couple at a time.
const LAZY_REWARM_SECONDS = 30 * 60;
const LAZY_REWARM_PER_REQUEST = 2;
// Ceiling on how many feeds guests can add to the archive per day, across all
// callers. The per-IP limit alone bounds one client's rate, not the total, and
// nothing subscribes to these feeds — this is what keeps a URL-cycling client
// from growing `feeds` without limit. Sized well above real guest demand.
const NEW_FEEDS_PER_DAY = 200;

const STARTER_FEED_SET = new Set(STARTER_FEED_URLS);

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function clientKey(request: Request): string {
  return `guest:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
}

function validFeedUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FEEDS) return null;
  const urls: string[] = [];
  for (const valueUrl of value) {
    if (typeof valueUrl !== 'string') return null;
    try {
      const parsed = new URL(valueUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      urls.push(valueUrl.trim());
    } catch {
      return null;
    }
  }
  return [...new Set(urls)].sort();
}

export function handleGuestStarterFeeds(request: Request): Response {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return json({ channels: STARTER_CHANNELS }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

async function guestRateLimit(request: Request, env: Env, path: string): Promise<Response | null> {
  const result = await checkRateLimit(env, clientKey(request), path);
  return result.allowed
    ? null
    : json({ error: 'Rate limit exceeded' }, 429, {
        'Retry-After': String(result.retryAfter || 60),
      });
}

export async function handleGuestFeedDiscover(request: Request, env: Env): Promise<Response> {
  const limited = await guestRateLimit(request, env, '/api/guest/feeds/discover');
  if (limited) return limited;
  return handleV2FeedDiscover(request, env);
}

/**
 * Take the warm slot for a feed the archive ALREADY has, by stamping
 * `guest_warmed_at` — but only if nothing warmed or ingested it inside
 * `freshSeconds`.
 *
 * The freshness test and the stamp are one statement, so the slot is a real
 * claim: of N overlapping callers exactly one gets `true` back and fetches, and
 * the rest are told the feed is already in hand. Reading freshness and then
 * stamping as two statements let every caller in the burst pass, which is the
 * concurrency the per-feed bound exists to stop.
 *
 * Stamped BEFORE the fetch on purpose: a failing URL burns its slot exactly like
 * a succeeding one, so a broken feed can't be retried on every poll.
 */
async function claimWarmSlot(env: Env, feedUrl: string, freshSeconds: number): Promise<boolean> {
  const claimed = await env.DB.prepare(
    `UPDATE feeds SET guest_warmed_at = unixepoch()
     WHERE feed_url = ?1
       AND COALESCE(guest_warmed_at, 0) <= unixepoch() - ?2
       AND COALESCE(last_ingest_at, 0) <= unixepoch() - ?2
     RETURNING feed_url`
  )
    .bind(feedUrl, freshSeconds)
    .first<{ feed_url: string }>();
  return claimed !== null;
}

/**
 * Take one slot from today's global ceiling on NEW guest feeds, returning
 * whether this caller got it.
 *
 * A single conditional upsert: the row is created at 1, or incremented only
 * while it is under the cap, and RETURNING reports nothing when the `WHERE`
 * fails. A `COUNT` followed by an insert would let a concurrent burst overshoot
 * the ceiling by its own size — and every one of those requests makes the proxy
 * fetch a caller-chosen URL, so the ceiling has to hold under concurrency to
 * mean anything.
 */
async function reserveNewGuestFeed(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO guest_feed_quota (day, used) VALUES (unixepoch() / 86400, 1)
     ON CONFLICT(day) DO UPDATE SET used = guest_feed_quota.used + 1
       WHERE guest_feed_quota.used < ?1
     RETURNING used`
  )
    .bind(NEW_FEEDS_PER_DAY)
    .first<{ used: number }>();
  return row !== null;
}

/** Give back a reserved slot the caller turned out not to need. */
async function releaseNewGuestFeed(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE guest_feed_quota SET used = used - 1
     WHERE day = unixepoch() / 86400 AND used > 0`
  ).run();
}

type WarmClaim = 'claimed' | 'fresh' | 'capped';

/**
 * Acquire the right to warm `feedUrl`: `claimed` means fetch it, `fresh` means
 * someone else has it covered (recently warmed, recently ingested, or being
 * warmed right now by a concurrent caller), `capped` means today's ceiling on
 * new guest feeds is spent.
 *
 * The row is created up front, before the fetch, because it is what the reaper
 * later collects — that can't depend on the proxy answering. The quota slot is
 * reserved BEFORE the create and released if the create was a no-op, so the
 * counter only ever errs toward being spent rather than toward letting extra
 * feeds through.
 */
async function claimGuestWarm(env: Env, feedUrl: string): Promise<WarmClaim> {
  if (await claimWarmSlot(env, feedUrl, WARM_FRESH_SECONDS)) return 'claimed';

  // Nothing updated: either the feed is fresh, or the archive has never seen it.
  const existing = await env.DB.prepare('SELECT 1 AS one FROM feeds WHERE feed_url = ?')
    .bind(feedUrl)
    .first<{ one: number }>();
  if (existing) return 'fresh';

  if (!(await reserveNewGuestFeed(env))) return 'capped';

  const created = await env.DB.prepare(
    `INSERT INTO feeds (feed_url, guest_warmed_at) VALUES (?, unixepoch())
     ON CONFLICT(feed_url) DO NOTHING
     RETURNING feed_url`
  )
    .bind(feedUrl)
    .first<{ feed_url: string }>();
  if (!created) {
    // A concurrent caller created it between the probe and here; it holds the
    // per-feed slot, so this request neither fetches nor spends capacity.
    await releaseNewGuestFeed(env);
    return 'fresh';
  }
  return 'claimed';
}

export async function handleGuestFeedWarm(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const limited = await guestRateLimit(request, env, '/api/guest/feeds/warm');
  if (limited) return limited;
  let feedUrl: unknown;
  try {
    feedUrl = (await request.json<{ feedUrl?: unknown }>()).feedUrl;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const urls = validFeedUrls([feedUrl]);
  const url = urls?.[0];
  if (!url) return json({ error: 'feedUrl must be an HTTP(S) URL' }, 400);

  // Starter feeds ride the crawl set (see handleCrawlSet), so they are already
  // as fresh as the crawler can make them.
  if (STARTER_FEED_SET.has(url)) return json({ ok: true, fresh: true });

  // Deliberate bounded exception to subscription-gated warming (feeds-v2.ts's
  // `callerSubscribes`): guest rows are local-only, so this endpoint is their
  // only path into the archive. Bounded per IP above, per feed by the freshness
  // claim, and — for a feed nobody has crawled before — globally per day.
  const claim = await claimGuestWarm(env, url);
  if (claim === 'fresh') return json({ ok: true, fresh: true });
  if (claim === 'capped') {
    log.info('guest_warm_capped', { feedUrl: url });
    return json({ ok: false, error: 'Guest feed capacity reached; try again tomorrow' }, 429, {
      'Retry-After': '3600',
    });
  }

  const result = await warmFeedIntoArchive(env, url);
  return json({ ok: result.success, itemCount: result.itemCount, error: result.error });
}

/**
 * Re-warm the stalest guest-added feeds in this request's list.
 *
 * Nothing else keeps them current: the crawl set is derived from subscriptions
 * plus the starter channels, and a guest has neither. Bounded to
 * LAZY_REWARM_PER_REQUEST feeds per request, only feeds already in the archive
 * (so the read path can never create one), and each one has to win the same
 * conditional claim the explicit warm endpoint uses — the SELECT below only
 * nominates candidates, so two guests reading the same feed at once still
 * produce exactly one fetch.
 */
async function rewarmStaleGuestFeeds(env: Env, feedUrls: string[]): Promise<void> {
  const candidates = feedUrls.filter((url) => !STARTER_FEED_SET.has(url));
  if (candidates.length === 0) return;
  const placeholders = candidates.map(() => '?').join(',');
  const stale = await env.DB.prepare(
    `SELECT feed_url FROM feeds
     WHERE feed_url IN (${placeholders})
       AND guest_warmed_at IS NOT NULL
       AND guest_warmed_at < unixepoch() - ?
       AND COALESCE(last_ingest_at, 0) < unixepoch() - ?
     ORDER BY guest_warmed_at ASC LIMIT ?`
  )
    .bind(...candidates, LAZY_REWARM_SECONDS, LAZY_REWARM_SECONDS, LAZY_REWARM_PER_REQUEST)
    .all<{ feed_url: string }>();

  for (const row of stale.results) {
    try {
      if (!(await claimWarmSlot(env, row.feed_url, LAZY_REWARM_SECONDS))) continue;
      await warmFeedIntoArchive(env, row.feed_url);
    } catch (error) {
      log.warn('guest_rewarm_failed', {
        feedUrl: row.feed_url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

interface GuestRow {
  seq: number;
  feed_url: string;
  item_json: string;
}

function items(
  rows: GuestRow[]
): Array<FeedItem & { seq: number; feedUrl: string; read: boolean }> {
  return rows.flatMap((row) => {
    try {
      return [
        {
          ...(JSON.parse(row.item_json) as FeedItem),
          seq: row.seq,
          feedUrl: row.feed_url,
          read: false,
        },
      ];
    } catch {
      return [];
    }
  });
}

export async function handleGuestTimeline(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const limited = await guestRateLimit(request, env, '/api/guest/timeline');
  if (limited) return limited;

  let body: {
    feedUrls?: unknown;
    since_seq?: unknown;
    generation?: unknown;
    cold_offset?: unknown;
    limit?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const feedUrls = validFeedUrls(body.feedUrls);
  if (!feedUrls)
    return json({ error: `feedUrls must contain at most ${MAX_FEEDS} HTTP(S) URLs` }, 400);

  const { generation, crawlerFresh, timelineEnabled, healthRev } = await readArchiveState(env);
  const ingestActive = crawlerFresh && timelineEnabled;
  if (!ingestActive)
    return json({
      items: [],
      cursor: 0,
      generation,
      ingestActive,
      hasMore: false,
      readCursor: 0,
      coldStart: true,
      healthRev,
    });

  const parsedLimit = Number(body.limit);
  const pageLimit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : MAX_LIMIT;
  const since = Number(body.since_seq);
  const incremental = Number.isInteger(since) && since >= 0 && body.generation === generation;
  let page: GuestRow[];
  let hasMore = false;
  let nextColdOffset: number | undefined;

  if (incremental && feedUrls.length) {
    const placeholders = feedUrls.map((_, index) => `?${index + 2}`).join(',');
    const result = await timedAll<GuestRow>(
      'guest_timeline_incremental',
      env.DB.prepare(
        `SELECT seq, feed_url, item_json FROM feed_items WHERE seq > ?1 AND feed_url IN (${placeholders}) ORDER BY seq ASC LIMIT ?${feedUrls.length + 2}`
      ).bind(since, ...feedUrls, pageLimit + 1)
    );
    hasMore = result.results.length > pageLimit;
    page = result.results.slice(0, pageLimit);
  } else {
    const offset = Number.isInteger(Number(body.cold_offset))
      ? Math.max(Number(body.cold_offset), 0)
      : 0;
    const selected = feedUrls.slice(offset, offset + COLD_FEEDS_PER_PAGE);
    const results = selected.length
      ? await timedBatch<GuestRow>(
          'guest_timeline_cold',
          env.DB,
          selected.map((feedUrl) =>
            env.DB.prepare(
              'SELECT seq, feed_url, item_json FROM feed_items WHERE feed_url = ? ORDER BY published_at DESC, seq DESC LIMIT ?'
            ).bind(feedUrl, COLD_PER_FEED)
          )
        )
      : [];
    page = results.flatMap((result) => result.results).sort((a, b) => b.seq - a.seq);
    hasMore = offset + selected.length < feedUrls.length;
    if (hasMore) nextColdOffset = offset + selected.length;
  }

  const cursor = incremental
    ? (page.at(-1)?.seq ?? since)
    : Math.max(0, ...page.map((row) => row.seq));
  log.info('guest_timeline', { feedCount: feedUrls.length, itemCount: page.length, incremental });

  // Serving never fetches; the re-warm runs after the response is sent.
  if (ctx) ctx.waitUntil(rewarmStaleGuestFeeds(env, feedUrls));

  return json({
    items: items(page),
    cursor,
    generation,
    ingestActive,
    hasMore,
    nextColdOffset,
    readCursor: 0,
    coldStart: !incremental,
    healthRev,
  });
}

/**
 * Delete guest-warmed feeds nobody subscribes to and no guest has touched in
 * `maxAgeDays`, items and all. The daily ceiling bounds how fast this set can
 * grow; this is what stops it growing forever. Bounded per run — the hourly
 * cron catches up over the following hours rather than deleting in one gulp.
 */
export async function reapOrphanGuestFeeds(
  env: Env,
  maxAgeDays = 30,
  limit = 100
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 24 * 60 * 60;
  // Yesterday's quota rows answer nothing — only today's is ever read.
  await env.DB.prepare('DELETE FROM guest_feed_quota WHERE day < unixepoch() / 86400 - 7').run();
  const orphans = await env.DB.prepare(
    `SELECT feed_url FROM feeds
     WHERE guest_warmed_at IS NOT NULL
       AND guest_warmed_at < ?
       AND NOT EXISTS (SELECT 1 FROM subscriptions_cache s WHERE s.feed_url = feeds.feed_url)
     LIMIT ?`
  )
    .bind(cutoff, limit)
    .all<{ feed_url: string }>();

  const urls = orphans.results
    .map((row) => row.feed_url)
    .filter((url) => !STARTER_FEED_SET.has(url));
  if (urls.length === 0) return 0;

  const placeholders = urls.map(() => '?').join(',');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM feed_items WHERE feed_url IN (${placeholders})`).bind(...urls),
    env.DB.prepare(`DELETE FROM feeds WHERE feed_url IN (${placeholders})`).bind(...urls),
  ]);
  return urls.length;
}
