import type { Env } from '../types';
import { checkRateLimit } from '../services/rate-limit';
import { FeedProxyClient, type MentionLaneEntryResult } from '../services/feed-proxy-client';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { log } from '../utils/logger';

/**
 * GET /api/public/link?url=… — the data behind a public link page
 * (read.skyreader.app/<url>, served by linkblog-site): the article's title, site
 * name and description, who across the Atmosphere referenced it in each lane, and
 * the people inside those lanes. Everything here is public atproto data.
 *
 * It's a GET so the answer can sit in the edge cache, keyed by the NORMALIZED
 * URL: a link that goes viral costs one proxy lookup per cache window, not one
 * per visitor, and `?utm_source=…` variants share the entry. The guest POST
 * routes can't be cached this way.
 *
 * The rate limit counts cache misses only, against one shared bucket. The
 * page's own server is the main caller, and a Worker's subrequest carries
 * Cloudflare's address rather than the visitor's, so a per-IP key would put
 * every visitor in one bucket anyway. What the shared budget bounds is the work
 * behind a miss (a Constellation lookup, and at most one fetch of the article per
 * URL per decay window), whoever is asking. Per-visitor limiting belongs at the
 * edge of read.skyreader.app.
 */

const MAX_URL_LENGTH = 2048;
// Seconds a settled answer is cached. The proxy's own lane cache is 5 minutes,
// so a longer edge window would only hide new discussion.
const CACHE_SECONDS = 300;
// The page refreshes itself while a lookup is pending; a short cache keeps a
// burst of visitors to a brand-new link from each reaching the proxy.
const PENDING_CACHE_SECONDS = 5;
const RATE_LIMIT_KEY = 'public-link';
export const PUBLIC_LINK_PATH = '/api/public/link';

// The entry fields the page shows. The proxy's entries carry more (like counts,
// source markers) that a public page has no use for.
type PublicEntry = Pick<
  MentionLaneEntryResult,
  'did' | 'handle' | 'displayName' | 'avatar' | 'createdAt' | 'note' | 'url' | 'verb' | 'quote'
> & { collections: { name: string; url: string | null }[] };

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function publicEntry(entry: MentionLaneEntryResult): PublicEntry {
  return {
    did: entry.did,
    handle: entry.handle,
    displayName: entry.displayName,
    avatar: entry.avatar,
    createdAt: entry.createdAt,
    note: entry.note,
    url: entry.url,
    verb: entry.verb,
    quote: entry.quote,
    collections: entry.collections ?? [],
  };
}

export async function handlePublicLink(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const raw = new URL(request.url).searchParams.get('url') ?? '';
  const normalized = raw.length <= MAX_URL_LENGTH ? normalizeArticleUrl(raw) : null;
  if (!normalized) return json({ error: 'Invalid url' }, 400);

  // The cache is an optimization, never a dependency: a misbehaving Cache API
  // costs a proxy round trip and nothing else.
  const cache = caches.default;
  const cacheKey = new Request(
    `${new URL(request.url).origin}${PUBLIC_LINK_PATH}?url=${encodeURIComponent(normalized)}`
  );
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) return new Response(cached.body, cached);

  const limit = await checkRateLimit(env, RATE_LIMIT_KEY, PUBLIC_LINK_PATH);
  if (!limit.allowed) {
    return json({ error: 'Busy' }, 429, {
      'Retry-After': String(limit.retryAfter || 60),
      'Cache-Control': 'no-store',
    });
  }

  let page;
  try {
    page = await new FeedProxyClient(env).fetchLinkPage(normalized);
  } catch (error) {
    log.warn('public_link_proxy_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'Unavailable' }, 502, { 'Cache-Control': 'no-store' });
  }

  const entries: Record<string, PublicEntry[]> = {};
  for (const [lane, list] of Object.entries(page.entries)) {
    if (Array.isArray(list)) entries[lane] = list.map(publicEntry);
  }
  const body = {
    url: page.url,
    meta: page.meta,
    total: page.total,
    lanes: page.lanes,
    entries,
    pending: page.pending,
    unavailable: page.unavailable,
  };

  // An answer the index couldn't fully give is never cached: the next visitor
  // should get a fresh try, not five minutes of "unreachable".
  if (page.unavailable) return json(body, 200, { 'Cache-Control': 'no-store' });

  const seconds = page.pending ? PENDING_CACHE_SECONDS : CACHE_SECONDS;
  const response = json(body, 200, { 'Cache-Control': `public, max-age=${seconds}` });
  ctx.waitUntil(
    cache.put(cacheKey, response.clone()).catch((error) => {
      log.warn('public_link_cache_put_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    })
  );
  return response;
}
