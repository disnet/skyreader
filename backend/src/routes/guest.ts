import type { Env, FeedItem } from '../types';
import { STARTER_CHANNELS } from '../config/starter-feeds';
import { checkRateLimit, getRateLimitConfig } from '../services/rate-limit';
import { readArchiveState } from './timeline';
import { timedAll, timedBatch } from '../utils/d1-timing';
import { log } from '../utils/logger';
import { handleV2FeedDiscover, warmFeedIntoArchive } from './feeds-v2';

const MAX_FEEDS = 50;
const MAX_LIMIT = 200;
const COLD_PER_FEED = 30;

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
  if (!urls?.[0]) return json({ error: 'feedUrl must be an HTTP(S) URL' }, 400);
  const existing = await env.DB.prepare('SELECT last_ingest_at FROM feeds WHERE feed_url = ?')
    .bind(urls[0])
    .first<{ last_ingest_at: number | null }>();
  if (existing?.last_ingest_at && existing.last_ingest_at > Date.now() / 1000 - 15 * 60) {
    return json({ ok: true, fresh: true });
  }
  // Deliberate bounded exception to subscription-gated warming: guest rows are
  // local-only, so this IP-limited endpoint is their only archive freshness path.
  const result = await warmFeedIntoArchive(env, urls[0]);
  return json({ ok: result.success, itemCount: result.itemCount, error: result.error });
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
    const selected = feedUrls.slice(offset, offset + 25);
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
