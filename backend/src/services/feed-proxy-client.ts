import type { Env, FeedItem } from '../types';

export class FeedProxyError extends Error {
  errorCount?: number;
  nextRetryAt?: number;

  constructor(message: string, errorCount?: number, nextRetryAt?: number) {
    super(message);
    this.name = 'FeedProxyError';
    this.errorCount = errorCount;
    this.nextRetryAt = nextRetryAt;
  }
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

export interface ExtractedArticle {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  domain: string | null;
  image: string | null;
  published: string | null;
  wordCount: number;
  favicon: string | null;
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

    // Always try to parse as JSON - proxy returns JSON even for errors
    return response.json() as Promise<T>;
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
   * Discover feed URLs from a site URL
   */
  async discoverFeeds(siteUrl: string): Promise<string[]> {
    const params = new URLSearchParams({ url: siteUrl });
    const raw = await this.fetch<{ feeds?: string[]; error?: string }>(`/discover?${params}`);

    if (raw.error) {
      throw new FeedProxyError(raw.error);
    }

    return raw.feeds || [];
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
   * Extract article content from a URL via defuddle
   */
  async extractArticle(url: string): Promise<ExtractedArticle> {
    const raw = await this.fetch<ExtractedArticle & { error?: string }>('/extract', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });

    if (raw.error) {
      throw new FeedProxyError(raw.error);
    }

    return {
      title: raw.title,
      author: raw.author,
      description: raw.description,
      content: raw.content,
      domain: raw.domain,
      image: raw.image,
      published: raw.published,
      wordCount: raw.wordCount || 0,
      favicon: raw.favicon,
    };
  }
}
