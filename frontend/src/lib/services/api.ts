import type { DiscoverUser, FeedItem, ParsedFeed, SocialShare, User } from '$lib/types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787';

class ApiClient {
  private sessionId: string | null = null;
  private onUnauthorized: (() => void) | null = null;

  setSession(sessionId: string | null) {
    this.sessionId = sessionId;
  }

  // Set callback for when 401 is received (session invalid)
  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.sessionId) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.sessionId}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      // Handle 401 - session is invalid/expired
      if (response.status === 401) {
        console.warn('Session expired or invalid, logging out...');
        if (this.onUnauthorized) {
          this.onUnauthorized();
        }
        throw new Error('Session expired');
      }

      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error((error as { error: string }).error || `HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  // Auth
  async login(handle: string, returnUrl?: string): Promise<{ authUrl: string }> {
    const params = new URLSearchParams({ handle });
    if (returnUrl) params.set('returnUrl', returnUrl);
    return this.fetch(`/api/auth/login?${params}`);
  }

  async logout(): Promise<void> {
    await this.fetch('/api/auth/logout', { method: 'POST' });
  }

  async getMe(): Promise<User> {
    return this.fetch('/api/auth/me');
  }

  // Feeds
  async fetchFeed(url: string, force = false): Promise<ParsedFeed> {
    const params = new URLSearchParams({ url });
    if (force) params.set('force', 'true');
    return this.fetch(`/api/feeds/fetch?${params}`);
  }

  async fetchCachedFeed(url: string): Promise<ParsedFeed & { cached?: boolean }> {
    return this.fetch(`/api/feeds/cached?url=${encodeURIComponent(url)}`);
  }

  async discoverFeeds(url: string): Promise<{ feeds: string[] }> {
    return this.fetch(`/api/feeds/discover?url=${encodeURIComponent(url)}`);
  }

  async fetchArticle(feedUrl: string, guid: string, itemUrl?: string): Promise<FeedItem | null> {
    const params = new URLSearchParams({ feedUrl, guid });
    if (itemUrl) params.set('itemUrl', itemUrl);
    const result = await this.fetch<{ article: FeedItem }>(`/api/feeds/article?${params}`);
    return result.article;
  }

  async getFeedStatuses(feedUrls: string[]): Promise<Record<string, {
    cached: boolean;
    lastFetchedAt?: number;
    error?: string;
    itemCount?: number;
  }>> {
    const params = new URLSearchParams();
    feedUrls.forEach(url => params.append('url', url));
    return this.fetch(`/api/feeds/status?${params}`);
  }

  async fetchFeedsBatch(urls: string[]): Promise<{
    feeds: Record<string, {
      title: string;
      description?: string;
      siteUrl?: string;
      imageUrl?: string;
      items: FeedItem[];
      status: 'ready' | 'pending';
      lastFetchedAt?: number;
    }>;
  }> {
    return this.fetch('/api/feeds/batch', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    });
  }

  // Items (paginated queries)
  async getItems(options: {
    feedUrls?: string[];
    since?: number;
    before?: number;
    limit?: number;
    search?: string;
  }): Promise<{ items: (FeedItem & { feedUrl: string; feedTitle?: string })[]; cursor: number | null }> {
    const params = new URLSearchParams();
    options.feedUrls?.forEach(url => params.append('feedUrl', url));
    if (options.since) params.set('since', options.since.toString());
    if (options.before) params.set('before', options.before.toString());
    if (options.limit) params.set('limit', options.limit.toString());
    if (options.search) params.set('search', options.search);
    return this.fetch(`/api/items?${params}`);
  }

  async getRecentItems(hours = 24, limit = 100): Promise<{ items: (FeedItem & { feedUrl: string; feedTitle?: string })[] }> {
    return this.fetch(`/api/items/recent?hours=${hours}&limit=${limit}`);
  }

  async getItem(feedUrl: string, guid: string): Promise<{ item: FeedItem & { feedUrl: string; feedTitle?: string } }> {
    const params = new URLSearchParams({ feedUrl, guid });
    return this.fetch(`/api/items/get?${params}`);
  }

  async getItemsByFeed(feedUrl: string, options?: { limit?: number; before?: number }): Promise<{
    feed: { title: string; siteUrl?: string; description?: string; imageUrl?: string } | null;
    items: (FeedItem & { feedUrl: string; feedTitle?: string })[];
    cursor: number | null;
  }> {
    const params = new URLSearchParams({ feedUrl });
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.before) params.set('before', options.before.toString());
    return this.fetch(`/api/items/by-feed?${params}`);
  }

  // Social
  async getSocialFeed(cursor?: string, limit = 50): Promise<{
    shares: SocialShare[];
    cursor: string | null;
  }> {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (cursor) params.set('cursor', cursor);
    return this.fetch(`/api/social/feed?${params}`);
  }

  async syncFollows(): Promise<{ synced: number }> {
    return this.fetch('/api/social/sync-follows', { method: 'POST' });
  }

  async getFollowedUsers(): Promise<{
    users: Array<{
      did: string;
      handle: string;
      displayName?: string;
      avatarUrl?: string;
      onApp?: boolean;
      source: 'bluesky' | 'inapp' | 'both';
    }>;
  }> {
    return this.fetch('/api/social/following');
  }

  async getDiscoverUsers(limit = 20): Promise<{ users: DiscoverUser[] }> {
    const params = new URLSearchParams({ limit: limit.toString() });
    return this.fetch(`/api/discover?${params}`);
  }

  async getPopularShares(
    period: 'day' | 'week' | 'month' = 'week',
    cursor?: string,
    limit = 50
  ): Promise<{
    shares: (SocialShare & { shareCount: number })[];
    cursor: string | null;
  }> {
    const params = new URLSearchParams({ period, limit: limit.toString() });
    if (cursor) params.set('cursor', cursor);
    return this.fetch(`/api/social/popular?${params}`);
  }

  // User's own shares
  async getMyShares(): Promise<{
    shares: Array<{
      recordUri: string;
      recordCid: string;
      feedUrl?: string;
      articleGuid?: string;
      articleUrl: string;
      articleTitle?: string;
      articleAuthor?: string;
      articleDescription?: string;
      articleImage?: string;
      articlePublishedAt?: string;
      note?: string;
      createdAt: string;
    }>;
  }> {
    return this.fetch('/api/shares/my');
  }

  // Record sync
  async syncRecord(request: {
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    record?: Record<string, unknown>;
  }): Promise<{ uri?: string; cid?: string }> {
    return this.fetch('/api/records/sync', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async bulkSyncRecords(operations: Array<{
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    record?: Record<string, unknown>;
  }>): Promise<{ results: Array<{ rkey: string; uri: string; cid?: string }> }> {
    return this.fetch('/api/records/bulk-sync', {
      method: 'POST',
      body: JSON.stringify({ operations }),
    });
  }

  async listRecords<T>(collection: string): Promise<{
    records: Array<{ uri: string; cid: string; value: T }>;
  }> {
    return this.fetch(`/api/records/list?collection=${encodeURIComponent(collection)}`);
  }

  // Reading (read positions)
  async getReadPositions(): Promise<{
    positions: Array<{
      item_guid: string;
      item_url: string | null;
      item_title: string | null;
      starred: number;
      read_at: number;
      rkey: string;
    }>;
  }> {
    return this.fetch('/api/reading/positions');
  }

  async markAsRead(data: {
    itemGuid: string;
    itemUrl?: string;
    itemTitle?: string;
    starred?: boolean;
  }): Promise<{ success: boolean; rkey?: string; alreadyRead?: boolean }> {
    return this.fetch('/api/reading/mark-read', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async markAsUnread(itemGuid: string): Promise<{ success: boolean }> {
    return this.fetch('/api/reading/mark-unread', {
      method: 'POST',
      body: JSON.stringify({ itemGuid }),
    });
  }

  async toggleStar(itemGuid: string, starred: boolean): Promise<{ success: boolean; starred: boolean }> {
    return this.fetch('/api/reading/toggle-star', {
      method: 'POST',
      body: JSON.stringify({ itemGuid, starred }),
    });
  }

  async markAsReadBulk(items: Array<{
    itemGuid: string;
    itemUrl?: string;
    itemTitle?: string;
  }>): Promise<{ success: boolean; marked: number; skipped: number }> {
    return this.fetch('/api/reading/mark-read-bulk', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }
}

export const api = new ApiClient();
