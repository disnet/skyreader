import type { Env, FeedItem } from '../types';

export class FeedProxyError extends Error {
  errorCount?: number;
  nextRetryAt?: number;
  // True when the failure is the target site refusing our automated fetcher
  // (e.g. a bot filter / CDN 403), as opposed to our proxy being unavailable.
  blocked?: boolean;

  constructor(message: string, errorCount?: number, nextRetryAt?: number, blocked?: boolean) {
    super(message);
    this.name = 'FeedProxyError';
    this.errorCount = errorCount;
    this.nextRetryAt = nextRetryAt;
    this.blocked = blocked;
  }
}

export interface ExtractedArticle {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  domain: string | null;
  image: string | null;
  published: string | null;
  wordCount: number;
}

export interface ProxyFeedResponse {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  fetchedAt: number;
  // Durable-log cursor contract (see RETENTION_SYNC_PLAN.md). `cursor` is the max
  // seq the client has now seen for this feed; it stores it and sends it back as
  // `since_seq`. `generation` guards against a proxy DB wipe (cold-start on
  // mismatch). `hasMore` means the feed's backlog wasn't fully drained this poll.
  cursor?: number;
  generation?: string;
  hasMore?: boolean;
}

export interface ProxyBatchFeedEntry {
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
  // See ProxyFeedResponse — the per-feed cursor contract.
  cursor?: number;
  generation?: string;
  hasMore?: boolean;
}

export interface ProxyBatchResponse {
  feeds: Record<string, ProxyBatchFeedEntry>;
}

/**
 * A resolved standard.site document, shaped to match the frontend's
 * `SocialDocument` (minus the client-only `id`). Returned by the proxy's
 * `/documents` endpoint with canonical URL + site icon already resolved.
 */
export interface ProxyDocument {
  authorDid: string;
  recordUri: string;
  recordCid: string;
  siteUri: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  coverImageCid?: string;
  textContent?: string;
  bskyPostUri?: string;
  tags?: string[];
  updatedAt?: string;
  canonicalUrl?: string;
  content?: unknown;
  indexedAt?: string;
  createdAt: string;
  siteIcon?: string;
  // Stamped by handleV2BatchDocumentFetch from a per-user read join (item_type
  // 'document'). Not returned by the proxy itself — annotation only.
  read?: boolean;
}

export interface ProxyDocumentEntry {
  did: string;
  siteUri?: string;
  // Present only on `ready`. Omitted on `unchanged` (the client already holds the
  // scope) and `error`.
  documents?: ProxyDocument[];
  // `unchanged`: the client's `since_digest` matched the proxy's current scope
  // digest — nothing changed, nothing to apply. `ready`: digest miss / cold start
  // → full scoped set + new `digest`. `error`: non-authoritative blob.
  status: 'ready' | 'unchanged' | 'error';
  error?: string;
  errorCount?: number;
  nextRetryAt?: number;
  // Per-scope content hash, returned on `ready` for the client to echo as
  // `since_digest` next poll.
  digest?: string;
  // True when `documents` is the author's complete document set (fit under the
  // proxy's per-author cap), so an absent record can be treated as deleted rather
  // than merely beyond the cap. Absent/false → set may be truncated.
  complete?: boolean;
}

interface RawDocumentBatchResponse {
  authors?: ProxyDocumentEntry[];
  error?: string;
}

// Social context (Constellation) request/response shapes (Phase 3).
export interface SocialContextQuery {
  key?: string;
  docUri?: string;
  articleUrl?: string;
  excludeDid?: string;
}

export interface AlsoLinkedEntry {
  did: string;
  handle: string | null;
  note: string | null;
  recordUri: string;
}

export interface SocialContextResult {
  key: string;
  quoteCount: number;
  alsoLinkedBy: AlsoLinkedEntry[];
}

interface RawSocialContextResponse {
  items?: SocialContextResult[];
  error?: string;
}

// Network-wide article mentions (Phase 5): per-lane breakdown of who across the
// Atmosphere referenced an article URL, keyed back by the original URL string.
export interface MentionLaneResult {
  lane: string;
  label: string;
  verb: string;
  noun: string;
  icon: string;
  count: number;
  capped: boolean;
}

export interface ArticleMentionsResult {
  url: string;
  total: number;
  lanes: MentionLaneResult[];
}

interface RawMentionsResponse {
  items?: ArticleMentionsResult[];
  error?: string;
}

// One resolved reference inside a lane (Phase 5 "see existing items"): a person
// who referenced an article URL via that lane, with their note + a link out.
export interface MentionLaneEntryResult {
  did: string;
  handle: string | null;
  note: string | null;
  url: string | null;
  // Named Semble collection(s) the saver filed the card into (Semble lane only).
  collections: { name: string; url: string | null }[];
  // margin.at lane only: the note's motivation as a past-tense verb, and the
  // highlighted passage it targets (distinct from the comment in `note`).
  verb: string | null;
  quote: string | null;
}

interface RawMentionLaneResponse {
  entries?: MentionLaneEntryResult[];
  error?: string;
}

// Raw response types from the proxy
interface RawFeedResponse {
  feed: {
    title: string;
    description?: string;
    siteUrl?: string;
    imageUrl?: string;
    items: FeedItem[];
  } | null;
  cache?: string;
  cursor?: number;
  generation?: string;
  hasMore?: boolean;
  error?: string;
  errorCount?: number;
  nextRetryAt?: number;
}

interface RawBatchResponse {
  feeds: Record<
    string,
    {
      feed?: {
        title: string;
        description?: string;
        siteUrl?: string;
        imageUrl?: string;
        items: FeedItem[];
      } | null;
      error?: string;
      errorCount?: number;
      nextRetryAt?: number;
      cache?: string;
      cursor?: number;
      generation?: string;
      hasMore?: boolean;
    }
  >;
}

export class FeedProxyClient {
  private proxyUrl: string;
  private proxySecret: string;

  constructor(env: Env) {
    this.proxyUrl = env.FEED_PROXY_URL;
    this.proxySecret = env.FEED_PROXY_SECRET;
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.proxyUrl}${path}`;

    const headers = new Headers(options.headers);
    headers.set('X-Proxy-Secret', this.proxySecret);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(url, {
      ...options,
      headers,
    });

    // The proxy app returns JSON for its own errors, but infrastructure in
    // front of it (Fly.io edge, gateway timeouts) can return a plain-text body
    // like "error code: 502". Read as text first so a non-JSON body surfaces a
    // clean message instead of leaking a confusing JSON parse SyntaxError.
    //
    // We can't tell from a bare edge error whether the proxy is down or the
    // target site is stalling/blocking us, so phrase it neutrally — don't claim
    // our service is unavailable or tell the user to "try again" (a bot block
    // won't clear on retry).
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FeedProxyError(
        `Couldn't load the feed (HTTP ${response.status}). The source may be blocking automated access or temporarily unavailable.`
      );
    }
  }

  /**
   * Fetch a single feed with optional GUID-based filtering
   */
  async fetchFeed(
    feedUrl: string,
    sinceGuids?: string[],
    limit?: number,
    sinceSeq?: number,
    generation?: string
  ): Promise<ProxyFeedResponse> {
    const params = new URLSearchParams({ url: feedUrl });

    if (sinceGuids && sinceGuids.length > 0) {
      params.set('since_guids', sinceGuids.join(','));
    }

    if (limit) {
      params.set('limit', limit.toString());
    }

    if (sinceSeq !== undefined) {
      params.set('since_seq', String(sinceSeq));
    }
    if (generation) {
      params.set('generation', generation);
    }

    const raw = await this.fetch<RawFeedResponse>(`/feed?${params}`);

    // Check for error response
    if (raw.error || !raw.feed) {
      const error = new FeedProxyError(
        raw.error || 'Failed to fetch feed',
        raw.errorCount,
        raw.nextRetryAt
      );
      throw error;
    }

    // Unwrap the feed from the response
    return {
      title: raw.feed.title,
      description: raw.feed.description,
      siteUrl: raw.feed.siteUrl,
      imageUrl: raw.feed.imageUrl,
      items: raw.feed.items,
      fetchedAt: Date.now(),
      cursor: raw.cursor,
      generation: raw.generation,
      hasMore: raw.hasMore,
    };
  }

  /**
   * Discover feed URLs from a site URL.
   *
   * Returns RSS/Atom feed URLs as well as any advertised standard.site
   * (AT Protocol) document URIs (at://did/site.standard.document/rkey).
   */
  async discoverFeeds(siteUrl: string): Promise<{ feeds: string[]; standardSites: string[] }> {
    const params = new URLSearchParams({ url: siteUrl });
    const raw = await this.fetch<{
      feeds?: string[];
      standardSites?: string[];
      error?: string;
      blocked?: boolean;
    }>(`/discover?${params}`);

    if (raw.error) {
      throw new FeedProxyError(raw.error, undefined, undefined, raw.blocked);
    }

    return { feeds: raw.feeds || [], standardSites: raw.standardSites || [] };
  }

  /**
   * Fetch multiple feeds in a single request with GUID-based filtering
   */
  async fetchFeedsBatch(
    feeds: Array<{
      url: string;
      since_guids?: string[];
      since_seq?: number;
      generation?: string;
      limit?: number;
    }>
  ): Promise<ProxyBatchResponse> {
    const raw = await this.fetch<RawBatchResponse & { error?: string }>('/feeds', {
      method: 'POST',
      body: JSON.stringify({ feeds }),
    });

    // Check if proxy returned an error response (e.g., 401 Unauthorized)
    if (!raw.feeds) {
      throw new FeedProxyError(raw.error || 'Invalid response from feed proxy');
    }

    // Unwrap each feed from the response
    const result: ProxyBatchResponse = { feeds: {} };

    for (const [url, entry] of Object.entries(raw.feeds)) {
      if (entry.error || !entry.feed) {
        result.feeds[url] = {
          title: 'Error',
          items: [],
          status: 'error',
          error: entry.error || 'Empty response from proxy',
          errorCount: entry.errorCount,
          nextRetryAt: entry.nextRetryAt,
        };
      } else {
        result.feeds[url] = {
          title: entry.feed.title,
          description: entry.feed.description,
          siteUrl: entry.feed.siteUrl,
          imageUrl: entry.feed.imageUrl,
          items: entry.feed.items,
          status: 'ready',
          lastFetchedAt: Date.now(),
          cursor: entry.cursor,
          generation: entry.generation,
          hasMore: entry.hasMore,
        };
      }
    }

    return result;
  }

  /**
   * Fetch standard.site documents for multiple authors in a single request.
   *
   * Each entry is an author DID, optionally scoped to a publication (`siteUri`:
   * an `at://...publication/rkey`, or omitted for all), and optionally carrying
   * the per-scope content digest the client last saw (`since_digest`) — a match
   * returns a bodyless `unchanged` entry.
   * Returns the proxy's per-author entries verbatim (already in SocialDocument
   * shape on a `ready` result).
   */
  async fetchDocumentsBatch(
    authors: Array<{
      did: string;
      siteUri?: string;
      since_digest?: string;
    }>
  ): Promise<ProxyDocumentEntry[]> {
    const raw = await this.fetch<RawDocumentBatchResponse>('/documents', {
      method: 'POST',
      body: JSON.stringify({ authors }),
    });

    if (!raw.authors) {
      throw new FeedProxyError(raw.error || 'Invalid response from feed proxy');
    }

    return raw.authors;
  }

  /**
   * Fetch Constellation social context for a batch of link posts (Phase 3):
   * recommend/quote counts + "who else linked this article" (with handles +
   * notes). Best-effort adornment — the proxy degrades each item silently.
   */
  async fetchSocialContext(items: SocialContextQuery[]): Promise<SocialContextResult[]> {
    const raw = await this.fetch<RawSocialContextResponse>('/social-context', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });

    if (!raw.items) {
      throw new FeedProxyError(raw.error || 'Invalid response from feed proxy');
    }

    return raw.items;
  }

  /**
   * Fetch the network-wide mention breakdown for a batch of article URLs
   * (Phase 5): per-lane distinct-DID counts + a deduped total, keyed back by the
   * original URL. Best-effort adornment — the proxy returns empty per URL on a
   * cold/sub-threshold lookup and enriches in the background for a later poll.
   */
  async fetchArticleMentions(urls: string[]): Promise<ArticleMentionsResult[]> {
    const raw = await this.fetch<RawMentionsResponse>('/mentions', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    });

    if (!raw.items) {
      throw new FeedProxyError(raw.error || 'Invalid response from feed proxy');
    }

    return raw.items;
  }

  /**
   * Fetch the people inside one mention lane (Phase 5 "see existing items"): who
   * referenced this article URL via that lane, each with their note + a link out
   * to the post / card / highlight. Resolved lazily on lane expand. Best-effort —
   * the proxy returns an empty list rather than error on a Constellation outage.
   */
  async fetchMentionLaneItems(url: string, lane: string): Promise<MentionLaneEntryResult[]> {
    const raw = await this.fetch<RawMentionLaneResponse>('/mention-lane', {
      method: 'POST',
      body: JSON.stringify({ url, lane }),
    });

    if (!raw.entries) {
      throw new FeedProxyError(raw.error || 'Invalid response from feed proxy');
    }

    return raw.entries;
  }

  /**
   * Fetch the linkblog registry (Phase 6): the DIDs of everyone with a Skyreader
   * linkblog, from the proxy's cached Constellation marker query. Best-effort —
   * the proxy returns an empty list on a Constellation outage rather than error.
   */
  async fetchLinkblogRegistry(): Promise<string[]> {
    const raw = await this.fetch<{ dids?: string[]; error?: string }>('/linkblog-registry');
    if (!raw.dids) {
      throw new FeedProxyError(raw.error || 'Invalid response from feed proxy');
    }
    return raw.dids;
  }

  /**
   * Fetch a URL and return cleaned, extracted article content (Defuddle, done
   * proxy-side and cached).
   */
  async extract(url: string): Promise<ExtractedArticle> {
    const proxyUrl = `${this.proxyUrl}/extract`;

    const headers = new Headers();
    headers.set('X-Proxy-Secret', this.proxySecret);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      // The proxy returns a JSON error body ({ error, blocked }); fall back to
      // the raw text if it's a non-JSON edge error.
      const text = await response.text();
      try {
        const body = JSON.parse(text) as { error?: string; blocked?: boolean };
        throw new FeedProxyError(
          body.error || `Failed to extract article: HTTP ${response.status}`,
          undefined,
          undefined,
          body.blocked
        );
      } catch (e) {
        if (e instanceof FeedProxyError) throw e;
        throw new FeedProxyError(text || `Failed to extract article: HTTP ${response.status}`);
      }
    }

    return (await response.json()) as ExtractedArticle;
  }
}
