import type { Env, FeedItem, Session } from '../types';
import { FeedProxyClient, FeedProxyError } from '../services/feed-proxy-client';
import type {
  ProxyDocumentEntry,
  SocialContextQuery,
  SocialContextResult,
  ArticleMentionsResult,
} from '../services/feed-proxy-client';
import { resolveStandardSite } from '../utils/canonical-url';
import { log, serializeError } from '../utils/logger';
import { chunkArray, getReadKeys } from './reading';
import { clearFeedHealth, ingestProxyFeed } from './ingest';
import { readFeedMetadata, readFeedSlice, type FeedHealth } from './timeline';
import {
  getLinkblogTargets,
  publicationUri as linkblogPublicationUri,
} from '../services/linkblog-sync';

interface V2FeedResponse {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  // Unix ms of the last ingest for this feed (freshness, for the client's UI) —
  // no longer a live upstream fetch time, since reads never touch the proxy.
  fetchedAt: number;
  // Present only when the crawler currently considers this feed broken.
  health?: FeedHealth;
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

// Newest-N a single-feed fetch delivers from the D1 archive.
const SINGLE_FEED_LIMIT = 30;
const SINGLE_FEED_MAX_LIMIT = 200;

/**
 * Does this user hold a subscription to this feed? The gate on every write into
 * the shared archive that a user request can trigger. Parked (`active = 0`) subs
 * count — the user owns the feed either way, and re-activating it shouldn't need
 * a different code path.
 */
async function callerSubscribes(env: Env, userDid: string, feedUrl: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM subscriptions_cache WHERE user_did = ? AND feed_url = ? LIMIT 1`
  )
    .bind(userDid, feedUrl)
    .first<{ ok: number }>();
  return !!row;
}

// Shown when an error reaches the client with no message of its own. A blank
// `error` string renders as an empty failure in the reader, which is worse than
// a generic one.
const FEED_FETCH_FALLBACK_ERROR = 'Failed to fetch feed';

/**
 * The queryable half of a `FeedProxyError`, for a log line. `serializeError`
 * covers name/message/stack; these are the fields that say WHICH failure it was
 * — an unparseable body from Fly's edge (`status` + `bodySnippet`) versus the
 * proxy's own verdict on a broken feed (`errorCount` + `nextRetryAt`).
 */
function proxyErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof FeedProxyError)) return {};
  return {
    status: error.status,
    bodySnippet: error.bodySnippet,
    errorCount: error.errorCount,
    nextRetryAt: error.nextRetryAt,
    blocked: error.blocked,
  };
}

/**
 * GET /api/v2/feeds/fetch
 *
 * One feed's newest slice, served from the D1 archive with read state joined in
 * (the timeline's per-feed sibling). This is the "new subscription gap" path:
 * a feed the user just subscribed to contributes nothing to the global timeline
 * cursor (its items sit below it), so the client fetches it directly here.
 *
 * If D1 has nothing for the feed (nobody was subscribed, so the crawler never
 * pushed it), we PULL THROUGH: fetch it from the proxy once, ingest the result,
 * then serve from D1. Steady state never touches Fly.
 *
 * The pull-through only runs for a feed the CALLER actually subscribes to. The
 * archive is shared and (by design) never pruned, so an open ingest surface would
 * let any authenticated user write arbitrary feeds into it forever; requiring a
 * subscription bounds writes to each user's own feed list. Subscriptions are
 * written to `subscriptions_cache` synchronously by POST /api/subscriptions
 * before the client fetches, so the add-feed path is unaffected.
 *
 * Query params:
 * - url: Feed URL (required)
 * - limit: Max items to return (optional, default 30)
 * - refresh: `1` to force the pull-through even when the archive already has the
 *   feed — the "retry this feed" action, the one path that still asks the
 *   crawler for a fresh fetch on demand.
 * - since_guids: accepted and ignored (legacy); the client dedupes by GUID.
 */
export async function handleV2FeedFetch(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('url');
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

  const parsedLimit = limitParam ? parseInt(limitParam, 10) : SINGLE_FEED_LIMIT;
  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), SINGLE_FEED_MAX_LIMIT)
    : SINGLE_FEED_LIMIT;

  const forceRefresh = url.searchParams.get('refresh') === '1';

  // Hoisted out of the try so the outer catch can log it. Whether the archive
  // had anything is what separates a fatal pull-through (nothing to serve, so
  // the error is the response) from a refresh failure we swallow.
  let archiveEmpty = false;

  try {
    let items = await readFeedSlice(env, session.did, feedUrl, limit);
    let metadata = await readFeedMetadata(env, feedUrl);

    // Pull-through: the archive has nothing for this feed (first subscriber, so
    // the crawler never pushed it), or the caller explicitly asked for a fresh
    // fetch. One synchronous proxy call, ingested so every later read — and
    // every other user — comes from D1. Gated on the caller's own subscription
    // (see the note above); a non-subscriber just reads whatever D1 already holds.
    archiveEmpty = items.length === 0;
    const wantsPullThrough = archiveEmpty || forceRefresh;
    if (wantsPullThrough && (await callerSubscribes(env, session.did, feedUrl))) {
      try {
        const client = new FeedProxyClient(env);
        const feed = await client.fetchFeed(feedUrl);
        await ingestProxyFeed(env, feedUrl, feed);
        // We just fetched it, so whatever the crawler last recorded is stale.
        // Clearing here is what makes the user's "retry this feed" action show a
        // result now rather than after the next health report.
        await clearFeedHealth(env, feedUrl);
        items = await readFeedSlice(env, session.did, feedUrl, limit);
        metadata = await readFeedMetadata(env, feedUrl);
      } catch (error) {
        // A failed refresh of a feed we already hold is not a failed read.
        if (archiveEmpty) throw error;
        // warn, not error: this path serves the archive and answers 200. The
        // level is the honest one for "degraded, not broken".
        log.warn('feed_refresh_failed', {
          feedUrl,
          ...proxyErrorFields(error),
          ...serializeError(error),
        });
      }
    }

    const response: V2FeedResponse = {
      title: metadata?.title ?? '',
      description: metadata?.description ?? undefined,
      siteUrl: metadata?.site_url ?? undefined,
      imageUrl: metadata?.image_url ?? undefined,
      items,
      fetchedAt: (metadata?.last_ingest_at ?? Math.floor(Date.now() / 1000)) * 1000,
      // The crawler's verdict on this feed, so a per-feed read reports a broken
      // feed even when the archive still has old items to serve. Timestamps in
      // ms, matching the timeline's health payload.
      health:
        metadata && metadata.error_count > 0
          ? {
              errorCount: metadata.error_count,
              error: metadata.last_error ?? undefined,
              lastErrorAt: metadata.last_error_at ? metadata.last_error_at * 1000 : undefined,
              nextRetryAt: metadata.next_retry_at ? metadata.next_retry_at * 1000 : undefined,
              lastFetchedAt: metadata.last_fetch_at ? metadata.last_fetch_at * 1000 : undefined,
            }
          : undefined,
    };

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('feed_fetch_failed', {
      feedUrl,
      // True here means the pull-through was the whole response — there was
      // nothing in the archive to fall back to.
      archiveEmpty,
      ...proxyErrorFields(error),
      ...serializeError(error),
    });

    if (error instanceof FeedProxyError) {
      return new Response(
        JSON.stringify({
          // An error whose message is empty must not become `{"error": ""}` on
          // the wire — the client renders it as a blank failure.
          error: error.message || FEED_FETCH_FALLBACK_ERROR,
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
        error: (error instanceof Error && error.message) || FEED_FETCH_FALLBACK_ERROR,
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

interface DocumentScopeRequest {
  did: string;
  siteUri?: string;
  since_digest?: string;
}

// The publication scopes this user's own subscription rows point at, per author.
// That's the migrated truth: when an author connects (or disconnects) a
// publication, migrateLinkblogFollowers rewrites these rows immediately, while a
// follower's device keeps requesting whatever scope it cached.
async function subscribedDocumentScopes(
  env: Env,
  userDid: string,
  dids: string[]
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (dids.length === 0) return out;
  // Chunked: a heavy document subscriber can exceed D1's bound-parameter cap.
  for (const chunk of chunkArray(dids, 89)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT subject_did, feed_url FROM subscriptions_cache
       WHERE user_did = ? AND source_type = 'atproto.documents' AND subject_did IN (${placeholders})`
    )
      .bind(userDid, ...chunk)
      .all<{ subject_did: string; feed_url: string | null }>();
    for (const row of rows.results ?? []) {
      if (!row.feed_url) continue;
      const scopes = out.get(row.subject_did) ?? new Set<string>();
      scopes.add(row.feed_url);
      out.set(row.subject_did, scopes);
    }
  }
  return out;
}

/**
 * Re-point requests that name a linkblog publication its author has moved off.
 *
 * A follower's scope lives on their device (the local subscription's feedUrl) and
 * in their PDS record, neither of which we can rewrite synchronously when an
 * author connects an existing publication. Left alone, that client asks for the
 * abandoned publication forever: the proxy filters by site URI, so the feed just
 * stops updating — no error, no signal. Correcting it here means every client,
 * on every device, self-heals on its next poll.
 *
 * Deliberately narrow. A scope is only stale when it names the author's own
 * Skyreader publication (`skyreader-links`, unambiguously a linkblog follow) or
 * when this user's subscription row has already been migrated to the author's
 * current target. An ordinary publication subscription is never touched.
 *
 * Returns the requests to forward plus a `did\ncorrectedScope → requestedScope`
 * map, so the response still echoes the scope the client asked for and its
 * per-scope digests/reconciliation keys stay stable.
 */
async function correctLinkblogScopes(
  env: Env,
  userDid: string,
  entries: DocumentScopeRequest[]
): Promise<{ requests: DocumentScopeRequest[]; restore: Map<string, string> }> {
  const restore = new Map<string, string>();
  // Own-linkblog pulls resolve their own target client-side, and an unscoped
  // request already gets everything the author wrote.
  const scoped = entries.filter((e) => e.siteUri && e.did !== userDid);
  if (scoped.length === 0) return { requests: entries, restore };

  const dids = [...new Set(scoped.map((e) => e.did))];
  const [targets, subscribed] = await Promise.all([
    getLinkblogTargets(env, dids),
    subscribedDocumentScopes(env, userDid, dids),
  ]);
  const requested = new Set(entries.map((e) => `${e.did}\n${e.siteUri ?? ''}`));

  const requests = entries.map((entry) => {
    if (!entry.siteUri || entry.did === userDid) return entry;
    const target = targets.get(entry.did);
    if (!target || target.siteUri === entry.siteUri) return entry;
    const rows = subscribed.get(entry.did);
    const stale =
      entry.siteUri === linkblogPublicationUri(entry.did) ||
      (!!rows && !rows.has(entry.siteUri) && rows.has(target.siteUri));
    // Don't collapse two requested scopes onto one — the client asked for both.
    if (!stale || requested.has(`${entry.did}\n${target.siteUri}`)) return entry;
    restore.set(`${entry.did}\n${target.siteUri}`, entry.siteUri);
    return { ...entry, siteUri: target.siteUri };
  });
  return { requests, restore };
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
    // Re-point any scope whose author has since moved their linkblog, echoing the
    // requested scope back so the client's keys are untouched. Best-effort: a D1
    // hiccup here must not cost the user their documents.
    let requests = valid;
    let restore = new Map<string, string>();
    try {
      ({ requests, restore } = await correctLinkblogScopes(env, session.did, valid));
    } catch (e) {
      console.error('Linkblog scope correction failed; forwarding scopes as-is:', e);
    }

    const client = new FeedProxyClient(env);
    const proxyEntries = await client.fetchDocumentsBatch(requests);
    for (const entry of proxyEntries) {
      const requestedScope = entry.siteUri && restore.get(`${entry.did}\n${entry.siteUri}`);
      if (requestedScope) entry.siteUri = requestedScope;
    }
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
 * GET /api/v2/documents/get?uri=at://...
 *
 * On-demand fetch of a single standard.site document — the in-app reader path
 * for a curated Collection piece whose author the user doesn't subscribe to (so
 * it's in no batch response). Thin pass-through to the proxy, then the same
 * per-user read annotation the batch path applies (item_type 'document').
 */
export async function handleV2GetDocument(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const uri = new URL(request.url).searchParams.get('uri');
  if (!uri || !uri.startsWith('at://')) {
    return new Response(JSON.stringify({ error: 'Missing or invalid uri' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const client = new FeedProxyClient(env);
    const document = await client.fetchDocument(uri);
    if (!document) {
      return new Response(JSON.stringify({ error: 'Document not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stamp per-user read state, mirroring the batch path's annotation.
    const readUris = await getReadKeys(env, session.did, 'document', [document.recordUri]);
    document.read = readUris.has(document.recordUri);

    return new Response(JSON.stringify({ document }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('V2 get document error:', error);
    const message = error instanceof Error ? error.message : 'Proxy fetch failed';
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
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
 * their note + a link out. Thin pass-through — no D1. Lazily called when the
 * discussion is opened. Adornment, so the read never depends on it — but a
 * failure answers 503, not an empty list: "we couldn't ask" and "nobody wrote
 * about this" are different claims, and only one of them deserves a retry.
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
    // Adornment, so this never breaks the read — but it fails loudly rather than
    // returning `[]`, which the client would show as "nobody wrote about this"
    // and then cache as settled. The surface turns a 503 into a retry.
    console.error('V2 mention-lane fetch error:', error);
    // No `entries` key at all: a caller that reads the body can't mistake this
    // for an answer. (No `retryable` either — that flag means "session refresh
    // pending" to the client's fetch wrapper and would trigger a silent retry.)
    return new Response(JSON.stringify({ error: 'Atmosphere unavailable' }), {
      status: 503,
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
 * Fetch a newly subscribed feed through the proxy and INGEST it into the archive.
 *
 * This used to only warm the proxy's cache and throw the parse away. Now that D1
 * is the read path, the same one fetch we were already paying for at subscribe
 * time populates the archive — so the client's first per-feed read is a plain D1
 * query instead of another synchronous crawl through the pull-through.
 */
export async function warmFeedIntoArchive(env: Env, feedUrl: string): Promise<WarmCacheResult> {
  try {
    const client = new FeedProxyClient(env);
    const feed = await client.fetchFeed(feedUrl);
    await ingestProxyFeed(env, feedUrl, feed);
    return { success: true, itemCount: feed.items.length };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch feed';
    console.error(`[warmFeedIntoArchive] Error fetching ${feedUrl}:`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * The same, for several feeds in one proxy batch request (bulk / OPML import).
 * A feed whose ingest fails is reported as an error but never fails the others.
 */
export async function warmFeedsIntoArchive(
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
        try {
          await ingestProxyFeed(env, feedUrl, feedResult);
          results[feedUrl] = { success: true, itemCount: feedResult.items.length };
        } catch (error) {
          results[feedUrl] = {
            success: false,
            error: error instanceof Error ? error.message : 'Ingest failed',
          };
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Batch fetch failed';
    console.error(`[warmFeedsIntoArchive] Batch error:`, errorMessage);

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
