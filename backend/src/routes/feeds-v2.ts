import type { Env, FeedItem } from '../types';
import { FeedProxyClient, FeedProxyError } from '../services/feed-proxy-client';
import type {
  ProxyDocumentEntry,
  SocialContextQuery,
  SocialContextResult,
} from '../services/feed-proxy-client';
import { resolveStandardSite } from '../utils/canonical-url';

interface V2FeedResponse {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  fetchedAt: number;
}

interface V2BatchFeedResult {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  status: 'ready' | 'error';
  error?: string;
  errorCount?: number;
  nextRetryAt?: number;
  lastFetchedAt?: number;
}

interface V2BatchResponse {
  feeds: Record<string, V2BatchFeedResult>;
}

/**
 * GET /api/v2/feeds/fetch
 *
 * Fetch a single feed via Fly.io proxy with GUID-based incremental sync.
 *
 * Query params:
 * - url: Feed URL (required)
 * - since_guids: Comma-separated GUIDs the client already has (optional)
 * - limit: Max items to return (optional, default 100)
 */
export async function handleV2FeedFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('url');
  const sinceGuidsParam = url.searchParams.get('since_guids');
  const limitParam = url.searchParams.get('limit');

  if (!feedUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URL
  try {
    new URL(feedUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sinceGuids = sinceGuidsParam ? sinceGuidsParam.split(',').filter(Boolean) : undefined;
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;

  try {
    const client = new FeedProxyClient(env);
    const feed = await client.fetchFeed(feedUrl, sinceGuids, limit);

    const response: V2FeedResponse = {
      title: feed.title,
      description: feed.description,
      siteUrl: feed.siteUrl,
      imageUrl: feed.imageUrl,
      items: feed.items,
      fetchedAt: feed.fetchedAt,
    };

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('V2 feed fetch error:', error);

    if (error instanceof FeedProxyError) {
      return new Response(
        JSON.stringify({
          error: error.message,
          errorCount: error.errorCount,
          nextRetryAt: error.nextRetryAt,
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to fetch feed' }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * POST /api/v2/feeds/batch
 *
 * Batch fetch multiple feeds via Fly.io proxy with GUID-based incremental sync.
 *
 * Request body:
 * {
 *   feeds: Array<{
 *     url: string;
 *     since_guids?: string[];  // GUIDs client already has
 *     limit?: number;
 *   }>
 * }
 */
export async function handleV2BatchFeedFetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: {
    feeds?: Array<{
      url: string;
      since_guids?: string[];
      limit?: number;
    }>;
  };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const feeds = body.feeds;
  if (!feeds || !Array.isArray(feeds) || feeds.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing feeds array in request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Limit to prevent abuse
  if (feeds.length > 50) {
    return new Response(JSON.stringify({ error: 'Too many feeds (max 50)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URLs
  const validFeeds: typeof feeds = [];
  const invalidUrls: string[] = [];

  for (const feed of feeds) {
    try {
      new URL(feed.url);
      validFeeds.push(feed);
    } catch {
      invalidUrls.push(feed.url);
    }
  }

  const responseFeeds: Record<string, V2BatchFeedResult> = {};

  // Initialize invalid URLs with error status
  for (const url of invalidUrls) {
    responseFeeds[url] = {
      title: 'Invalid URL',
      items: [],
      status: 'error',
      error: 'Invalid URL format',
    };
  }

  if (validFeeds.length === 0) {
    return new Response(JSON.stringify({ feeds: responseFeeds }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const client = new FeedProxyClient(env);
    const proxyResponse = await client.fetchFeedsBatch(validFeeds);

    // Map proxy response to v2 response format
    for (const feed of validFeeds) {
      const proxyFeed = proxyResponse.feeds[feed.url];
      if (proxyFeed) {
        responseFeeds[feed.url] = {
          title: proxyFeed.title,
          description: proxyFeed.description,
          siteUrl: proxyFeed.siteUrl,
          imageUrl: proxyFeed.imageUrl,
          items: proxyFeed.items,
          status: proxyFeed.status,
          error: proxyFeed.error,
          errorCount: proxyFeed.errorCount,
          nextRetryAt: proxyFeed.nextRetryAt,
          lastFetchedAt: proxyFeed.lastFetchedAt,
        };
      } else {
        responseFeeds[feed.url] = {
          title: 'Unknown Feed',
          items: [],
          status: 'error',
          error: 'Feed not found in proxy response',
        };
      }
    }

    const response: V2BatchResponse = { feeds: responseFeeds };

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('V2 batch feed fetch error:', error);

    // Return partial results with error for all valid feeds
    for (const feed of validFeeds) {
      if (!responseFeeds[feed.url]) {
        responseFeeds[feed.url] = {
          title: 'Error',
          items: [],
          status: 'error',
          error: error instanceof Error ? error.message : 'Proxy fetch failed',
        };
      }
    }

    return new Response(JSON.stringify({ feeds: responseFeeds }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface V2BatchDocumentResponse {
  authors: ProxyDocumentEntry[];
}

/**
 * POST /api/v2/documents/batch
 *
 * Batch fetch standard.site documents for multiple authors via the Fly.io proxy.
 * Thin pass-through — no D1 reads/writes. Documents come back already resolved
 * (canonical URL + site icon) in the frontend's SocialDocument shape.
 *
 * Request body:
 * {
 *   documents: Array<{
 *     did: string;            // publisher DID (subjectDid of an atproto.documents sub)
 *     siteUri?: string;       // at://...publication, '__freestanding__', or omit for all
 *     since_uris?: string[];  // recordUris the client already has (incremental trim)
 *   }>
 * }
 */
export async function handleV2BatchDocumentFetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: {
    documents?: Array<{ did: string; siteUri?: string; since_uris?: string[] }>;
  };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const entries = body.documents;
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing documents array in request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (entries.length > 50) {
    return new Response(JSON.stringify({ error: 'Too many authors (max 50)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Only forward entries with a plausible DID; surface the rest as error entries
  // in the response. Order isn't preserved (invalids are emitted first), but the
  // client reconciles by did/siteUri, not by position.
  const valid: typeof entries = [];
  const invalid: typeof entries = [];
  for (const entry of entries) {
    if (entry.did && typeof entry.did === 'string' && entry.did.startsWith('did:')) {
      valid.push(entry);
    } else {
      invalid.push(entry);
    }
  }

  const errorEntry = (
    entry: { did: string; siteUri?: string },
    error: string
  ): ProxyDocumentEntry => ({
    did: entry.did,
    siteUri: entry.siteUri,
    documents: [],
    status: 'error',
    error,
  });

  const authors: ProxyDocumentEntry[] = invalid.map((e) => errorEntry(e, 'Invalid DID'));

  if (valid.length === 0) {
    return new Response(JSON.stringify({ authors }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const client = new FeedProxyClient(env);
    const proxyEntries = await client.fetchDocumentsBatch(valid);
    authors.push(...proxyEntries);

    const response: V2BatchDocumentResponse = { authors };
    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('V2 batch document fetch error:', error);
    const message = error instanceof Error ? error.message : 'Proxy fetch failed';
    for (const entry of valid) {
      authors.push(errorEntry(entry, message));
    }
    return new Response(JSON.stringify({ authors }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/v2/social-context
 *
 * Batch fetch Constellation social context for link posts via the Fly.io proxy
 * (Phase 3). Thin pass-through — no D1. Each item carries an optional `key` (the
 * client reconciles by it), a `docUri` (the link post's record), and/or an
 * `articleUrl` (the external article, for "who else linked this"). Best-effort:
 * on any proxy failure we return empty context per item rather than erroring, so
 * the read never depends on it.
 */
export async function handleV2SocialContext(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { items?: SocialContextQuery[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const items = body.items;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing items array in request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (items.length > 25) {
    return new Response(JSON.stringify({ error: 'Too many items (max 25)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const emptyFor = (item: SocialContextQuery): SocialContextResult => ({
    key: item.key || item.docUri || item.articleUrl || '',
    recommendCount: 0,
    quoteCount: 0,
    alsoLinkedBy: [],
  });

  try {
    const client = new FeedProxyClient(env);
    const results = await client.fetchSocialContext(items);
    return new Response(JSON.stringify({ items: results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    // Adornment only — degrade to empty context instead of failing the request.
    console.error('V2 social-context fetch error:', error);
    return new Response(JSON.stringify({ items: items.map(emptyFor) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export interface WarmCacheResult {
  success: boolean;
  itemCount?: number;
  error?: string;
}

/**
 * Warm up the proxy cache for a single feed.
 * Just fetches via proxy to ensure it's cached - no D1 storage.
 */
export async function warmProxyCache(env: Env, feedUrl: string): Promise<WarmCacheResult> {
  try {
    const client = new FeedProxyClient(env);
    const feed = await client.fetchFeed(feedUrl);
    return { success: true, itemCount: feed.items.length };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch feed';
    console.error(`[warmProxyCache] Error fetching ${feedUrl}:`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Warm up the proxy cache for multiple feeds in a single batch request.
 * Just fetches via proxy to ensure they're cached - no D1 storage.
 */
export async function warmProxyCacheBatch(
  env: Env,
  feedUrls: string[]
): Promise<Record<string, WarmCacheResult>> {
  const results: Record<string, WarmCacheResult> = {};

  if (feedUrls.length === 0) {
    return results;
  }

  try {
    const client = new FeedProxyClient(env);
    const batchResponse = await client.fetchFeedsBatch(feedUrls.map((url) => ({ url })));

    for (const feedUrl of feedUrls) {
      const feedResult = batchResponse.feeds[feedUrl];

      if (!feedResult) {
        results[feedUrl] = { success: false, error: 'Feed not found in proxy response' };
      } else if (feedResult.status === 'error') {
        results[feedUrl] = { success: false, error: feedResult.error };
      } else {
        results[feedUrl] = { success: true, itemCount: feedResult.items.length };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Batch fetch failed';
    console.error(`[warmProxyCacheBatch] Batch error:`, errorMessage);

    for (const feedUrl of feedUrls) {
      results[feedUrl] = { success: false, error: errorMessage };
    }
  }

  return results;
}

/**
 * GET /api/v2/feeds/discover
 *
 * Discover feed URLs from a website URL via Fly.io proxy.
 *
 * Query params:
 * - url: Website URL to discover feeds from (required)
 */
export async function handleV2FeedDiscover(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const siteUrl = url.searchParams.get('url');

  if (!siteUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URL
  try {
    new URL(siteUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const client = new FeedProxyClient(env);
    const { feeds, standardSites } = await client.discoverFeeds(siteUrl);

    // Resolve + verify the first advertised standard.site into a subscribable
    // publication (the HTML <link> is only a hint; resolveStandardSite confirms it
    // via the domain's .well-known endpoint). Preferred over RSS/Atom in the UI.
    let standardSite = null;
    if (standardSites.length > 0) {
      try {
        standardSite = await resolveStandardSite(standardSites[0], env);
      } catch (error) {
        console.error('Standard.site resolution error:', error);
      }
    }

    return new Response(JSON.stringify({ feeds, standardSite }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('V2 feed discovery error:', error);
    const blocked = error instanceof FeedProxyError && error.blocked === true;
    // Status stays non-2xx so the frontend's fetch wrapper throws and the modal
    // surfaces error.message. The clear "blocking automated access" wording now
    // comes from the message itself; `blocked` is carried for any caller that
    // wants to branch on it.
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to discover feeds',
        blocked,
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
