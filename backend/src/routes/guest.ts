import type { Env, FeedItem } from '../types';
import { STARTER_CHANNELS } from '../config/starter-feeds';
import { checkRateLimit } from '../services/rate-limit';
import { handleV2Mentions, handleV2MentionLane, handleV2MarginHighlights } from './feeds-v2';
import { archiveHead, readArchiveState } from './timeline';
import { timedAll, timedBatch } from '../utils/d1-timing';
import { log } from '../utils/logger';

/**
 * The unauthenticated reading surface: the starter channels, and a timeline over
 * a caller-supplied feed list. Both are strictly read-only against the SHARED
 * archive, and each is per-IP rate limited.
 *
 * There is deliberately no unauthenticated path that PUTS a feed into the
 * archive. Adding a source needs an account, so the only feeds a guest can name
 * are the curated starter ones, which the crawler already owns — nothing here
 * can be steered into fetching a caller-chosen URL.
 */

const MAX_FEEDS = 50;
const MAX_LIMIT = 200;
const COLD_PER_FEED = 30;
// Feeds per cold-start page. 25 × 30 items is the same order as the authed
// path's cold budget.
const COLD_FEEDS_PER_PAGE = 25;

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

export async function handleGuestTimeline(request: Request, env: Env): Promise<Response> {
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
  let incremental = Number.isInteger(since) && since >= 0 && body.generation === generation;
  let page: GuestRow[] = [];
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

    // Rewound-archive guard, the guest twin of the authed one in timeline.ts. A
    // Time Travel restore rewinds `feed_items.seq` while `items_generation`
    // comes back unchanged, so every stored cursor sits above the head and
    // `seq > ?` returns nothing on every poll from here on. A guest has no
    // second sync path to self-heal from, so fall through to a cold start.
    // Costs a MAX(seq) only on an otherwise empty page.
    if (page.length === 0 && since > (await archiveHead(env))) {
      log.warn('guest_timeline_rewound', { since });
      incremental = false;
      hasMore = false;
    }
  }

  // Cold start: no usable cursor, a generation mismatch, a rewound archive — or
  // no feeds at all, which the incremental query above skips.
  if (!incremental || !feedUrls.length) {
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
 * POST /api/guest/mentions and /api/guest/mention-lane
 *
 * The discussion section's read path, without a session. Who across the
 * Atmosphere referenced this URL (counts per lane), and who they are (the
 * records themselves). Both answer from public data — Constellation's index of
 * public repos, through the proxy's cache — so there is nothing here an account
 * unlocks, and an empty discussion under every article was the only thing
 * gating it bought.
 *
 * The `/api/v2` twins are the same handlers behind a session check; these add
 * the per-IP limit that the authenticated path gets for free from its per-DID
 * one (index.ts rate-limits by `session.did`, which an anonymous caller has no
 * equivalent of). Writing to a lane stays account-only, as it must: every one
 * of those writes a record to the reader's own repo.
 */
export async function handleGuestMentions(request: Request, env: Env): Promise<Response> {
  const limited = await guestRateLimit(request, env, '/api/guest/mentions');
  return limited ?? handleV2Mentions(request, env);
}

export async function handleGuestMentionLane(request: Request, env: Env): Promise<Response> {
  const limited = await guestRateLimit(request, env, '/api/guest/mention-lane');
  return limited ?? handleV2MentionLane(request, env);
}

/**
 * POST /api/guest/margin-highlights
 *
 * The community highlights an article carries: what other readers marked in it,
 * from Margin's public records through the proxy's cache. Public data, same as
 * the two above — the session check on the `/api/v2` twin bought nothing except
 * an unhighlighted page for a guest, and a 401 on the way there.
 */
export async function handleGuestMarginHighlights(request: Request, env: Env): Promise<Response> {
  const limited = await guestRateLimit(request, env, '/api/guest/margin-highlights');
  return limited ?? handleV2MarginHighlights(request, env);
}
