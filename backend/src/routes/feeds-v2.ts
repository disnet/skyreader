import type { Env, FeedItem, Session } from '../types';
import { FeedProxyClient, FeedProxyError } from '../services/feed-proxy-client';
import type {
  ProxyDocumentEntry,
  SocialContextQuery,
  SocialContextResult,
  ArticleMentionsResult,
} from '../services/feed-proxy-client';
import { resolveStandardSite } from '../utils/canonical-url';
import { getReadKeys } from './reading';

interface V2FeedResponse {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  fetchedAt: number;
  cursor?: number;
  generation?: string;
  hasMore?: boolean;
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
  // Durable-log cursor contract, threaded straight from the proxy. The client
  // stores cursor+generation per subscription and sends since_seq back; hasMore
  // drives its drain loop. (See RETENTION_SYNC_PLAN.md.)
  cursor?: number;
  generation?: string;
  hasMore?: boolean;
}

interface V2BatchResponse {
  feeds: Record<string, V2BatchFeedResult>;
  // Server time (unix seconds) the response was annotated. The client seeds its
  // forward-read-delta cursor from this on its first annotated fetch, so the
  // delta starts from bootstrap with no client/server clock skew.
  readCursor?: number;
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
  const sinceSeqParam = url.searchParams.get('since_seq');
  const generationParam = url.searchParams.get('generation');
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
  const sinceSeq =
    sinceSeqParam !== null && Number.isInteger(Number(sinceSeqParam))
      ? Number(sinceSeqParam)
      : undefined;
  const generation = generationParam ?? undefined;

  try {
    const client = new FeedProxyClient(env);
    const feed = await client.fetchFeed(feedUrl, sinceGuids, limit, sinceSeq, generation);

    const response: V2FeedResponse = {
      title: feed.title,
      description: feed.description,
      siteUrl: feed.siteUrl,
      imageUrl: feed.imageUrl,
      items: feed.items,
      fetchedAt: feed.fetchedAt,
      cursor: feed.cursor,
      generation: feed.generation,
      hasMore: feed.hasMore,
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
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to fetch feed',
      }),
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
export async function handleV2BatchFeedFetch(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
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
      since_seq?: number;
      generation?: string;
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
          cursor: proxyFeed.cursor,
          generation: proxyFeed.generation,
          hasMore: proxyFeed.hasMore,
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

    // Inline read annotation: the proxy response just gave us every returned
    // GUID, so a single per-user read join stamps `read` onto each item before
    // the per-user (uncached) response goes back. Read state arrives with the
    // articles it belongs to — no separate read fetch, no time window. The shared
    // Fly.io proxy cache is untouched (it's keyed by URL, one layer down).
    const readCursor = Math.floor(Date.now() / 1000);
    const allGuids: string[] = [];
    for (const feed of validFeeds) {
      const result = responseFeeds[feed.url];
      if (result?.status === 'ready') {
        for (const item of result.items) allGuids.push(item.guid);
      }
    }
    const readGuids = await getReadKeys(env, session.did, 'article', allGuids);
    for (const feed of validFeeds) {
      const result = responseFeeds[feed.url];
      if (result?.status === 'ready') {
        for (const item of result.items) item.read = readGuids.has(item.guid);
      }
    }

    const response: V2BatchResponse = { feeds: responseFeeds, readCursor };

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
  // See V2BatchResponse.readCursor — documents ride the identical read delta.
  readCursor?: number;
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
 *     siteUri?: string;        // at://...publication, or omit for all
 *     since_digest?: string;   // per-scope content digest the client last saw
 *   }>
 * }
 */
export async function handleV2BatchDocumentFetch(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: {
    documents?: Array<{ did: string; siteUri?: string; since_digest?: string }>;
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

    // Inline read annotation, identical to the feed path but keyed by recordUri
    // and item_type='document' (decision 3: documents share the unified read
    // store). Stamps `read` onto each document in the per-user response.
    // Only `ready` entries carry documents (`unchanged` is bodyless, `error`
    // empty), so the read join sees a URI list to stamp only for changed scopes.
    const readCursor = Math.floor(Date.now() / 1000);
    const allUris: string[] = [];
    for (const entry of authors) {
      if (entry.status === 'ready' && entry.documents) {
        for (const doc of entry.documents) allUris.push(doc.recordUri);
      }
    }
    const readUris = await getReadKeys(env, session.did, 'document', allUris);
    for (const entry of authors) {
      if (entry.status === 'ready' && entry.documents) {
        for (const doc of entry.documents) doc.read = readUris.has(doc.recordUri);
      }
    }

    const response: V2BatchDocumentResponse = { authors, readCursor };
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

/**
 * POST /api/v2/mentions
 *
 * Batch fetch the network-wide mention breakdown for article URLs via the Fly.io
 * proxy (Phase 5). Thin pass-through — no D1. Each URL resolves to per-lane
 * distinct-DID counts + a deduped total, keyed back by the original URL string.
 * Best-effort: on any proxy failure we return empty per URL rather than erroring,
 * so the read never depends on it.
 */
export async function handleV2Mentions(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { urls?: string[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const urls = body.urls;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing urls array in request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (urls.length > 50) {
    return new Response(JSON.stringify({ error: 'Too many urls (max 50)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const emptyFor = (url: string): ArticleMentionsResult => ({
    url,
    total: 0,
    lanes: [],
  });

  try {
    const client = new FeedProxyClient(env);
    const results = await client.fetchArticleMentions(urls);
    return new Response(JSON.stringify({ items: results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    // Adornment only — degrade to empty per URL instead of failing the request.
    console.error('V2 mentions fetch error:', error);
    return new Response(JSON.stringify({ items: urls.map(emptyFor) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/v2/mention-lane
 *
 * Resolve the people inside one mention lane (Phase 5 "see existing items") via
 * the Fly.io proxy: who referenced this article URL via that lane, each with
 * their note + a link out. Thin pass-through — no D1. Lazily called when a lane
 * is expanded. Best-effort: on any proxy failure we return an empty list rather
 * than erroring, so the read never depends on it.
 */
export async function handleV2MentionLane(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { url?: string; lane?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { url, lane } = body;
  if (!url || typeof url !== 'string' || !lane || typeof lane !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing url or lane in request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const client = new FeedProxyClient(env);
    const entries = await client.fetchMentionLaneItems(url, lane);
    return new Response(JSON.stringify({ entries }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    // Adornment only — degrade to an empty list instead of failing the request.
    console.error('V2 mention-lane fetch error:', error);
    return new Response(JSON.stringify({ entries: [] }), {
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
        results[feedUrl] = {
          success: false,
          error: 'Feed not found in proxy response',
        };
      } else if (feedResult.status === 'error') {
        results[feedUrl] = { success: false, error: feedResult.error };
      } else {
        results[feedUrl] = {
          success: true,
          itemCount: feedResult.items.length,
        };
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
