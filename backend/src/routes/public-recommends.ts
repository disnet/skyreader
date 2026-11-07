import type { Env } from '../types';
import { checkRateLimit } from '../services/rate-limit';
import { log } from '../utils/logger';

/**
 * GET /api/public/recommends — what Skyreader readers have recommended lately,
 * for the front of the public link pages (read.skyreader.app). A recommend is a
 * public app.skyreader.social.recommend record; `recommendations` in D1 is its
 * index (routes/recommends.ts).
 *
 * Articles only, never people: each item is the article (URL, title) with how
 * many readers recommended it and when it was last recommended. The page links
 * each one to its link page, which names whoever wrote about it publicly and
 * already honors the logged-out opt-out.
 *
 * Session-free and the same for everyone, so it's one edge-cache entry; the
 * shared budget only bounds cache misses.
 */

export const PUBLIC_RECOMMENDS_PATH = '/api/public/recommends';
const RATE_LIMIT_KEY = 'public-recommends';
const CACHE_SECONDS = 300;
// How far back "lately" reaches, and how many articles the page shows.
const WINDOW_DAYS = 30;
const LIMIT = 24;

interface Row {
  url: string;
  title: string | null;
  people: number;
  latest: number;
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export async function handlePublicRecommends(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const cache = caches.default;
  const cacheKey = new Request(`${new URL(request.url).origin}${PUBLIC_RECOMMENDS_PATH}`);
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) return new Response(cached.body, cached);

  const limit = await checkRateLimit(env, RATE_LIMIT_KEY, PUBLIC_RECOMMENDS_PATH);
  if (!limit.allowed) {
    return json({ error: 'Busy' }, 429, {
      'Retry-After': String(limit.retryAfter || 60),
      'Cache-Control': 'no-store',
    });
  }

  // One row per article: more readers first, then the most recent. The URL and
  // title shown are the latest recommender's (MAX(created_at) picks that row's
  // bare columns in SQLite).
  const since = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;
  let rows: Row[];
  try {
    const result = await env.DB.prepare(
      `SELECT url, title, COUNT(*) AS people, MAX(created_at) AS latest
         FROM recommendations
        WHERE created_at >= ?
        GROUP BY url_normalized
        ORDER BY people DESC, latest DESC
        LIMIT ?`
    )
      .bind(since, LIMIT)
      .all<Row>();
    rows = result.results;
  } catch (error) {
    log.warn('public_recommends_query_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'Unavailable' }, 502, { 'Cache-Control': 'no-store' });
  }

  const body = {
    items: rows.map((row) => ({
      url: row.url,
      title: row.title,
      people: row.people,
      recommendedAt: new Date(row.latest * 1000).toISOString(),
    })),
  };
  const response = json(body, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  ctx.waitUntil(
    cache.put(cacheKey, response.clone()).catch((error) => {
      log.warn('public_recommends_cache_put_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    })
  );
  return response;
}
