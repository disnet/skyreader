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
}

export interface ProxyDocumentEntry {
  did: string;
  siteUri?: string;
  documents: ProxyDocument[];
  status: 'ready' | 'error';
  error?: string;
  errorCount?: number;
  nextRetryAt?: number;
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
  recommendCount: number;
  quoteCount: number;
  alsoLinkedBy: AlsoLinkedEntry[];
}

interface RawSocialContextResponse {
  items?: SocialContextResult[];
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
  filter?: string;
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
    limit?: number
  ): Promise<ProxyFeedResponse> {
    const params = new URLSearchParams({ url: feedUrl });

    if (sinceGuids && sinceGuids.length > 0) {
      params.set('since_guids', sinceGuids.join(','));
    }

    if (limit) {
      params.set('limit', limit.toString());
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
        };
      }
    }

    return result;
  }

  /**
   * Fetch standard.site documents for multiple authors in a single request.
   *
   * Each entry is an author DID, optionally scoped to a publication (`siteUri`:
   * an `at://...publication/rkey`, or omitted for all), and optionally trimmed
   * to documents the client hasn't seen (`since_uris`).
   * Returns the proxy's per-author entries verbatim (already in SocialDocument
   * shape).
   */
  async fetchDocumentsBatch(
    authors: Array<{
      did: string;
      siteUri?: string;
      since_uris?: string[];
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
