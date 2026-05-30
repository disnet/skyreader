import type {
  FeedItem,
  GroupedShare,
  IntegrationStatus,
  ItemLabel,
  ItemLabelType,
  MarginCollection,
  ParsedFeed,
  ReshareActivity,
  SembleCollection,
  SocialDocument,
  SocialShare,
  User,
} from '$lib/types';

const API_BASE = import.meta.env.VITE_API_URL || '';

export class RateLimitError extends Error {
  retryAfter: number;

  constructor(retryAfter: number) {
    super(`Rate limit exceeded. Try again in ${retryAfter} seconds.`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ScopeUpgradeError extends Error {
  constructor(message?: string) {
    super(message || 'Your session was created with outdated permissions. Please log in again.');
    this.name = 'ScopeUpgradeError';
  }
}

export class UrlSaveLimitError extends Error {
  limit: number;
  current: number;
  resetsAt: string;

  constructor(message: string, limit: number, current: number, resetsAt: string) {
    super(message);
    this.name = 'UrlSaveLimitError';
    this.limit = limit;
    this.current = current;
    this.resetsAt = resetsAt;
  }
}

export class OfflineError extends Error {
  constructor() {
    super('You are offline');
    this.name = 'OfflineError';
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

class ApiClient {
  private onUnauthorized: (() => void) | null = null;
  private onScopeUpgradeRequired: (() => void) | null = null;
  // In-flight session probe, shared so a burst of concurrent 401s only triggers
  // one re-verification request instead of a thundering herd.
  private sessionProbe: Promise<'valid' | 'invalid' | 'unknown'> | null = null;

  // Set callback for when 401 is received (session invalid)
  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
  }

  // Set callback for when 403 scope_upgrade_required is received
  setOnScopeUpgradeRequired(callback: () => void) {
    this.onScopeUpgradeRequired = callback;
  }

  // Re-verify the session directly against /api/auth/me. Used to distinguish a
  // genuinely-invalid session from a transient 401 (e.g. a blip during a deploy
  // when the API custom domain is mid-rollout, or the cross-subdomain cookie
  // isn't attached to a particular in-flight request). Returns:
  //   'valid'   - session is fine, the original 401 was transient
  //   'invalid' - probe also got 401, session is genuinely gone
  //   'unknown' - network/other error, can't confirm; treat as transient
  // The probe uses a raw fetch (not this.fetch) to avoid recursing into the 401
  // handler, and is deduped via this.sessionProbe.
  private probeSession(): Promise<'valid' | 'invalid' | 'unknown'> {
    if (this.sessionProbe) return this.sessionProbe;
    const probe = (async (): Promise<'valid' | 'invalid' | 'unknown'> => {
      try {
        const response = await fetch(`${API_BASE}/api/auth/me`, {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        if (response.ok) return 'valid';
        if (response.status === 401) return 'invalid';
        return 'unknown';
      } catch {
        return 'unknown';
      } finally {
        this.sessionProbe = null;
      }
    })();
    this.sessionProbe = probe;
    return probe;
  }

  private async fetch<T>(
    path: string,
    options: RequestInit = {},
    retriedAfter401 = false
  ): Promise<T> {
    // Fail fast when offline instead of waiting for network timeout
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new OfflineError();
    }

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Session is managed via HTTP-only cookies, no Authorization header needed
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      // Handle 401 - session is invalid/expired
      if (response.status === 401) {
        // Don't immediately tear down local auth: a single 401 is often
        // transient (e.g. during a prod deploy). Re-verify the session before
        // logging out. Skip re-verification if this is already the post-probe
        // retry, to avoid looping.
        if (!retriedAfter401) {
          const status = await this.probeSession();
          if (status === 'valid') {
            // Session is fine — the 401 was transient. Retry the original
            // request once, transparently.
            return this.fetch<T>(path, options, true);
          }
          if (status === 'unknown') {
            // Couldn't confirm the session is gone (network blip mid-deploy).
            // Surface the failure but keep the user logged in.
            throw new Error('Session check failed');
          }
          // status === 'invalid' → session genuinely gone, fall through.
        }

        console.warn('Session expired or invalid, logging out...');
        if (this.onUnauthorized) {
          this.onUnauthorized();
        }
        throw new Error('Session expired');
      }

      // Handle 403 - scope upgrade required or limit reached
      if (response.status === 403) {
        const body = await response.json().catch(() => ({ error: 'Forbidden' }));
        if ((body as { error: string }).error === 'scope_upgrade_required') {
          if (this.onScopeUpgradeRequired) {
            this.onScopeUpgradeRequired();
          }
          throw new ScopeUpgradeError((body as { message?: string }).message);
        }
        if ((body as { error: string }).error === 'url_save_limit_reached') {
          const b = body as { message: string; limit: number; current: number; resetsAt: string };
          throw new UrlSaveLimitError(b.message, b.limit, b.current, b.resetsAt);
        }
        throw new Error((body as { error: string }).error || `HTTP ${response.status}`);
      }

      // Handle 429 - rate limit exceeded
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
        throw new RateLimitError(retryAfter);
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

  // Feeds (V2 - via Fly.io proxy)
  async fetchFeedV2(url: string, sinceGuids?: string[], limit?: number): Promise<ParsedFeed> {
    const params = new URLSearchParams({ url });
    if (sinceGuids && sinceGuids.length > 0) {
      params.set('since_guids', sinceGuids.join(','));
    }
    if (limit) {
      params.set('limit', limit.toString());
    }
    return this.fetch(`/api/v2/feeds/fetch?${params}`);
  }

  async fetchFeedsBatchV2(
    feeds: Array<{ url: string; since_guids?: string[]; limit?: number }>
  ): Promise<{
    feeds: Record<
      string,
      {
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
    >;
  }> {
    return this.fetch('/api/v2/feeds/batch', {
      method: 'POST',
      body: JSON.stringify({ feeds }),
    });
  }

  async discoverFeedsV2(url: string): Promise<{ feeds: string[] }> {
    return this.fetch(`/api/v2/feeds/discover?url=${encodeURIComponent(url)}`);
  }

  // Social
  async getSocialFeed(
    cursor?: string,
    limit = 50,
    includeDocuments = true
  ): Promise<{
    shares: SocialShare[];
    documents?: SocialDocument[];
    cursor: string | null;
  }> {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (cursor) params.set('cursor', cursor);
    if (includeDocuments) params.set('include', 'documents');
    return this.fetch(`/api/social/feed?${params}`);
  }

  async getGroupedSocialFeed(
    cursor?: string,
    limit = 30
  ): Promise<{
    groups: GroupedShare[];
    cursor: string | null;
  }> {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (cursor) params.set('cursor', cursor);
    return this.fetch(`/api/social/feed/grouped?${params}`);
  }

  async getReshareActivity(
    cursor?: string,
    limit = 50
  ): Promise<{
    activity: ReshareActivity[];
    cursor: string | null;
  }> {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (cursor) params.set('cursor', cursor);
    return this.fetch(`/api/activity/reshares?${params}`);
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
      articleContent?: string;
      articleImage?: string;
      articlePublishedAt?: string;
      note?: string;
      createdAt: string;
      reshareOf?: {
        uri: string;
        authorDid: string | null;
      };
      reshareCount?: number;
    }>;
  }> {
    return this.fetch('/api/shares/my');
  }

  // Content detection
  async detectContent(did: string): Promise<{
    did: string;
    publications: Array<{
      uri: string;
      name: string;
      url: string;
      description?: string;
      iconUrl?: string;
    }>;
    shareCount: number;
    freestandingDocumentCount: number;
  }> {
    return this.fetch(`/api/social/detect-content?did=${encodeURIComponent(did)}`);
  }

  // Subscriptions
  async createSubscription(data: {
    rkey: string;
    feedUrl?: string;
    title?: string;
    siteUrl?: string;
    category?: string;
    tags?: string[];
    source?: string;
    sourceType?: string;
    subjectDid?: string;
    collectionNsid?: string;
  }): Promise<{ rkey: string; uri: string }> {
    return this.fetch('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateSubscription(
    rkey: string,
    updates: {
      customTitle?: string | null;
      customIconUrl?: string | null;
      category?: string | null;
    }
  ): Promise<{ success: boolean }> {
    return this.fetch(`/api/subscriptions/${rkey}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteSubscription(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/subscriptions/${rkey}`, {
      method: 'DELETE',
    });
  }

  async bulkCreateSubscriptions(
    subscriptions: Array<{
      rkey: string;
      feedUrl: string;
      title?: string;
      siteUrl?: string;
      category?: string;
      source?: string;
    }>
  ): Promise<{ results: Array<{ rkey: string; uri: string }> }> {
    return this.fetch('/api/subscriptions/bulk', {
      method: 'POST',
      body: JSON.stringify({ subscriptions }),
    });
  }

  async bulkUpdateSubscriptions(
    rkeys: string[],
    updates: {
      customTitle?: string | null;
      customIconUrl?: string | null;
      category?: string | null;
    }
  ): Promise<{ success: boolean; updated: number }> {
    return this.fetch('/api/subscriptions/bulk-update', {
      method: 'POST',
      body: JSON.stringify({ rkeys, updates }),
    });
  }

  async bulkDeleteSubscriptions(rkeys: string[]): Promise<{ success: boolean; deleted: number }> {
    return this.fetch('/api/subscriptions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ rkeys }),
    });
  }

  // Shares
  async createShare(data: {
    rkey: string;
    itemUrl: string;
    feedUrl?: string;
    itemGuid?: string;
    itemTitle?: string;
    itemAuthor?: string;
    itemDescription?: string;
    content?: string;
    itemImage?: string;
    itemPublishedAt?: string;
    note?: string;
    tags?: string[];
    reshareOf?: {
      uri: string;
      authorDid: string;
    };
  }): Promise<{ rkey: string; uri: string }> {
    return this.fetch('/api/shares', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteShare(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/shares/${rkey}`, {
      method: 'DELETE',
    });
  }

  // Unified social read positions (new API)
  async getSocialReadPositions(type?: 'share' | 'document'): Promise<{
    positions: Array<{
      rkey: string;
      type: 'share' | 'document';
      itemUri: string;
      authorDid: string;
      itemUrl: string | null;
      itemTitle: string | null;
      readAt: string;
    }>;
  }> {
    const params = type ? `?type=${type}` : '';
    return this.fetch(`/api/social/read-positions${params}`);
  }

  async markSocialItemAsRead(data: {
    type: 'share' | 'document';
    rkey: string;
    itemUri: string;
    authorDid: string;
    itemUrl?: string;
    itemTitle?: string;
  }): Promise<{ rkey: string; uri: string }> {
    return this.fetch('/api/social/read-positions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async markSocialItemsAsReadBulk(
    items: Array<{
      type: 'share' | 'document';
      rkey: string;
      itemUri: string;
      authorDid: string;
      itemUrl?: string;
      itemTitle?: string;
    }>
  ): Promise<{ success: boolean; marked: number }> {
    return this.fetch('/api/social/read-positions/bulk', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  async markSocialItemAsUnread(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/social/read-positions/${rkey}`, {
      method: 'DELETE',
    });
  }

  // Share read positions (legacy API - kept for backwards compatibility)
  async markShareAsRead(data: {
    rkey: string;
    shareUri: string;
    shareAuthorDid: string;
    itemUrl?: string;
    itemTitle?: string;
  }): Promise<{ rkey: string; uri: string }> {
    return this.fetch('/api/social/share-read', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async markShareAsUnread(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/social/share-read/${rkey}`, {
      method: 'DELETE',
    });
  }

  async getShareReadPositions(): Promise<{
    positions: Array<{
      rkey: string;
      shareUri: string;
      shareAuthorDid: string;
      itemUrl: string | null;
      itemTitle: string | null;
      readAt: string;
    }>;
  }> {
    return this.fetch('/api/social/share-read');
  }

  // List records (still used for syncFromBackend)
  async listRecords<T>(collection: string): Promise<{
    records: Array<{ uri: string; cid: string; value: T }>;
  }> {
    return this.fetch(`/api/records/list?collection=${encodeURIComponent(collection)}`);
  }

  // Reading (read positions)
  // Pass `since` (a previously returned cursor) for an incremental delta fetch;
  // omit it for a full windowed fetch. Returns the new cursor to send next time.
  async getReadPositions(since?: number): Promise<{
    positions: Array<{
      item_guid: string;
      read_at: number;
      rkey: string;
    }>;
    cursor: number;
  }> {
    const params = since ? `?since=${since}` : '';
    return this.fetch(`/api/reading/positions${params}`);
  }

  async markAsRead(data: {
    itemGuid: string;
    itemUrl?: string;
    itemTitle?: string;
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

  async markAsReadBulk(
    items: Array<{
      itemGuid: string;
      itemUrl?: string;
      itemTitle?: string;
    }>
  ): Promise<{ success: boolean; marked: number; skipped: number }> {
    return this.fetch('/api/reading/mark-read-bulk', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  // Labels (unified item labels API)
  async getLabels(
    options: {
      label?: string;
      itemType?: ItemLabelType;
      cursor?: string;
      limit?: number;
      since?: number;
    } = {}
  ): Promise<{
    labels: Array<{
      itemKey: string;
      itemType: string;
      label: string;
      props: Record<string, unknown>;
      rkey?: string;
      createdAt: number;
      updatedAt: number;
    }>;
    cursor?: string;
  }> {
    const params = new URLSearchParams();
    if (options.label) params.set('label', options.label);
    if (options.itemType) params.set('itemType', options.itemType);
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.since !== undefined) params.set('since', String(options.since));
    const query = params.toString();
    return this.fetch(`/api/labels${query ? `?${query}` : ''}`);
  }

  async getAllLabels(
    options: { label?: string; itemType?: ItemLabelType; since?: number } = {}
  ): Promise<
    Array<{
      itemKey: string;
      itemType: string;
      label: string;
      props: Record<string, unknown>;
      rkey?: string;
      createdAt: number;
      updatedAt: number;
    }>
  > {
    const all: Array<{
      itemKey: string;
      itemType: string;
      label: string;
      props: Record<string, unknown>;
      rkey?: string;
      createdAt: number;
      updatedAt: number;
    }> = [];
    let cursor: string | undefined;
    do {
      // Use the backend max page size to minimise round-trips when paginating.
      const response = await this.getLabels({ ...options, cursor, limit: 500 });
      all.push(...response.labels);
      cursor = response.cursor;
    } while (cursor);
    return all;
  }

  async addLabel(data: {
    itemKey: string;
    itemType: ItemLabelType;
    label: string;
    props?: Record<string, unknown>;
  }): Promise<{ success: boolean }> {
    return this.fetch('/api/labels', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteLabel(itemKey: string, label: string): Promise<{ success: boolean }> {
    return this.fetch('/api/labels', {
      method: 'DELETE',
      body: JSON.stringify({ itemKey, label }),
    });
  }

  async bulkAddLabels(
    labels: Array<{
      itemKey: string;
      itemType: ItemLabelType;
      label: string;
      props?: Record<string, unknown>;
    }>
  ): Promise<{ success: boolean; added: number }> {
    return this.fetch('/api/labels/bulk', {
      method: 'POST',
      body: JSON.stringify({ labels }),
    });
  }

  // Settings
  async getSettings(): Promise<{
    pdsSyncEnabled: boolean;
    lastPdsSyncSubscriptions: number | null;
    lastPdsSyncReadPositions: number | null;
    createdAt: number;
    updatedAt: number;
  }> {
    return this.fetch('/api/settings');
  }

  async updateSettings(settings: { pdsSyncEnabled?: boolean }): Promise<{
    pdsSyncEnabled: boolean;
    lastPdsSyncSubscriptions: number | null;
    lastPdsSyncReadPositions: number | null;
    createdAt: number;
    updatedAt: number;
  }> {
    return this.fetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  // Integrations
  async getIntegrationStatus(): Promise<IntegrationStatus> {
    return this.fetch('/api/integrations/status');
  }

  async createSembleCard(data: {
    url: string;
    title?: string;
    description?: string;
    author?: string;
    publishedAt?: string;
    collections?: { uri: string; cid: string }[];
  }): Promise<{
    uri: string;
    cid: string;
    collectionResults?: { uri: string; error?: string }[];
  }> {
    return this.fetch('/api/integrations/semble/cards', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listSembleCollections(): Promise<{ collections: SembleCollection[] }> {
    return this.fetch('/api/integrations/semble/collections');
  }

  async createMarginBookmark(data: {
    url: string;
    title?: string;
    description?: string;
    collectionUris?: string[];
  }): Promise<{
    uri: string;
    cid: string;
    collectionResults?: { uri: string; error?: string }[];
  }> {
    return this.fetch('/api/integrations/margin/bookmarks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listMarginCollections(): Promise<{ collections: MarginCollection[] }> {
    return this.fetch('/api/integrations/margin/collections');
  }

  // Extract article content via the proxy (fetch + Defuddle, cached proxy-side)
  async extract(url: string): Promise<ExtractedArticle> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new OfflineError();
    }

    const response = await fetch(`${API_BASE}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        if (this.onUnauthorized) {
          this.onUnauthorized();
        }
        throw new Error('Session expired');
      }
      throw new Error(`Failed to extract article: ${response.status}`);
    }

    return (await response.json()) as ExtractedArticle;
  }

  // Bookmarks
  async saveFromUrl(
    url: string,
    rkey: string,
    options?: {
      fromFeed?: boolean;
      source?: 'url' | 'feed' | 'share' | 'document';
      itemGuid?: string;
      title?: string;
      author?: string;
      description?: string;
      content?: string;
      image?: string;
      publishedAt?: string;
      domain?: string;
      wordCount?: number;
    }
  ): Promise<{
    rkey: string;
    uri: string;
    url: string;
    title: string | null;
    author: string | null;
    description: string | null;
    content: string | null;
    contentType: string | null;
    domain: string | null;
    image: string | null;
    wordCount: number | null;
    publishedAt: string | null;
    savedAt: string;
    source?: 'url' | 'feed' | 'share' | 'document';
    itemGuid?: string;
  }> {
    return this.fetch('/api/saved', {
      method: 'POST',
      body: JSON.stringify({ url, rkey, ...options }),
    });
  }

  async getSaved(): Promise<{
    articles: Array<{
      rkey: string;
      uri: string;
      url: string;
      title: string | null;
      author: string | null;
      description: string | null;
      content: string | null;
      contentType: string | null;
      domain: string | null;
      image: string | null;
      wordCount: number | null;
      publishedAt: string | null;
      savedAt: string;
      source?: 'url' | 'feed' | 'share' | 'document';
      itemGuid?: string;
    }>;
  }> {
    return this.fetch('/api/saved');
  }

  async deleteSaved(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/saved/${rkey}`, {
      method: 'DELETE',
    });
  }

  async deleteSavedByGuid(guid: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/saved/by-guid/${encodeURIComponent(guid)}`, {
      method: 'DELETE',
    });
  }

  // PDS Sync
  async triggerFullSync(): Promise<{
    success: boolean;
    subscriptions?: {
      success: boolean;
      pulledFromPds: number;
      pushedToPds: number;
      skipped: number;
      warnings: string[];
      hasMore?: boolean;
    };
    error?: string;
    hasMore?: boolean;
  }> {
    return this.fetch('/api/sync/full', { method: 'POST' });
  }

  async getSyncStatus(): Promise<{
    pdsSyncEnabled: boolean;
    lastSyncSubscriptions: number | null;
  }> {
    return this.fetch('/api/sync/status');
  }

  // Channels
  async getChannels(): Promise<{
    channels: Array<{
      uuid: string;
      name: string;
      config: string;
      position: number;
      createdAt: number;
      updatedAt: number;
    }>;
    deletedUuids: string[];
  }> {
    return this.fetch('/api/channels');
  }

  async syncChannels(
    channels: Array<{
      uuid: string;
      name: string;
      config: string;
      position: number;
      createdAt: number;
      updatedAt: number;
    }>
  ): Promise<{ success: boolean }> {
    return this.fetch('/api/channels', {
      method: 'PUT',
      body: JSON.stringify({ channels }),
    });
  }

  async upsertChannel(
    uuid: string,
    data: { name: string; config: string; position: number; createdAt: number; updatedAt: number }
  ): Promise<{ success: boolean }> {
    return this.fetch(`/api/channels/${uuid}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteChannel(uuid: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/channels/${uuid}`, {
      method: 'DELETE',
    });
  }
}

export const api = new ApiClient();
