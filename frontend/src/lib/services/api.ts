import type {
  FeedItem,
  GroupedShare,
  IntegrationStatus,
  ItemLabel,
  ItemLabelType,
  LinkblogPublication,
  MarginCollection,
  ParsedFeed,
  ReshareActivity,
  SembleCollection,
  SocialContextResult,
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

// The backend has a live session for us but couldn't refresh its access token right
// now (e.g. a request burst racing a token refresh just after a deploy). This is a
// transient, retryable condition — NOT a logout. Surfaced after the in-fetch retries
// are exhausted so callers keep the user signed in.
export class SessionRefreshError extends Error {
  constructor() {
    super('Session is refreshing, please retry');
    this.name = 'SessionRefreshError';
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

// How many times a single request transparently retries a transient
// session-refresh (503) before giving up and surfacing SessionRefreshError.
const MAX_SESSION_REFRESH_RETRIES = 4;
const MAX_UNAUTHORIZED_RETRIES = 1;

type SessionProbeResult = 'active' | 'expired' | 'unknown';

class ApiClient {
  private onUnauthorized: (() => void) | null = null;
  private onScopeUpgradeRequired: (() => void) | null = null;
  private sessionProbe: Promise<SessionProbeResult> | null = null;

  // Set callback for when 401 is received (session invalid)
  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
  }

  // Set callback for when 403 scope_upgrade_required is received
  setOnScopeUpgradeRequired(callback: () => void) {
    this.onScopeUpgradeRequired = callback;
  }

  private probeSession(): Promise<SessionProbeResult> {
    if (this.sessionProbe) return this.sessionProbe;

    const runProbe = async (sessionRefreshAttempt = 0): Promise<SessionProbeResult> => {
      try {
        const response = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });

        if (response.ok) return 'active';
        if (response.status === 401) return 'expired';

        if (response.status === 503) {
          const body = await response
            .json()
            .catch(() => null as { retryable?: boolean; error?: string } | null);
          if (body?.retryable && sessionRefreshAttempt < MAX_SESSION_REFRESH_RETRIES) {
            const delay = 400 * 2 ** sessionRefreshAttempt;
            await new Promise((resolve) => setTimeout(resolve, delay));
            return runProbe(sessionRefreshAttempt + 1);
          }
        }
      } catch {
        // A failed probe is not evidence that the session is gone.
      } finally {
        this.sessionProbe = null;
      }

      return 'unknown';
    };

    this.sessionProbe = runProbe();
    return this.sessionProbe;
  }

  private async fetch<T>(
    path: string,
    options: RequestInit = {},
    sessionRefreshAttempt = 0,
    unauthorizedAttempt = 0
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
      // Handle 503 session_refresh_pending - the backend has a live session for us
      // but couldn't refresh its token in time (transient, e.g. a request burst
      // racing a refresh right after a deploy). Back off and retry transparently;
      // crucially, do NOT log out. The 401 below is reserved for genuine logout.
      if (response.status === 503) {
        const body = await response
          .json()
          .catch(() => null as { retryable?: boolean; error?: string } | null);
        if (body?.retryable) {
          if (sessionRefreshAttempt < MAX_SESSION_REFRESH_RETRIES) {
            // 400ms, 800ms, 1.6s, 3.2s — covers the refresh-poll window without
            // hammering the backend.
            const delay = 400 * 2 ** sessionRefreshAttempt;
            await new Promise((resolve) => setTimeout(resolve, delay));
            return this.fetch<T>(path, options, sessionRefreshAttempt + 1, unauthorizedAttempt);
          }
          // Exhausted retries — keep the user logged in and let the caller decide.
          throw new SessionRefreshError();
        }
        throw new Error(body?.error || `HTTP ${response.status}`);
      }

      // Handle 401. During deploys, an open tab can occasionally see one stale/racy
      // 401 from a background request even though the cookie-backed session is still
      // valid. Confirm against /api/auth/me before tearing down local auth.
      if (response.status === 401) {
        const sessionStatus = path === '/api/auth/me' ? 'expired' : await this.probeSession();

        if (sessionStatus === 'active') {
          if (unauthorizedAttempt < MAX_UNAUTHORIZED_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return this.fetch<T>(path, options, sessionRefreshAttempt, unauthorizedAttempt + 1);
          }
          throw new Error('Unauthorized');
        }

        if (sessionStatus === 'unknown') {
          throw new SessionRefreshError();
        }

        console.warn('Session expired or invalid, logging out...');
        if (this.onUnauthorized) this.onUnauthorized();
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

  async fetchDocumentsBatchV2(
    documents: Array<{ did: string; siteUri?: string; since_uris?: string[] }>
  ): Promise<{
    authors: Array<{
      did: string;
      siteUri?: string;
      documents: SocialDocument[];
      status: 'ready' | 'error';
      error?: string;
      errorCount?: number;
      nextRetryAt?: number;
    }>;
  }> {
    return this.fetch('/api/v2/documents/batch', {
      method: 'POST',
      body: JSON.stringify({ documents }),
    });
  }

  async discoverFeedsV2(url: string): Promise<{
    feeds: string[];
    standardSite?: {
      did: string;
      publicationUri: string;
      name: string;
      url?: string;
      description?: string;
      iconUrl?: string;
    } | null;
  }> {
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

  // Update the note on an existing share (empty string clears it).
  async updateShareNote(rkey: string, note: string): Promise<{ success: boolean; uri: string }> {
    return this.fetch(`/api/shares/${rkey}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    });
  }

  // Linkblog — sharing as a portable site.standard.document (Phase 1)
  async createLinkblogShare(data: {
    rkey: string;
    articleUrl: string;
    articleTitle?: string;
    articleAuthor?: string;
    excerpt?: string;
    articleImage?: string;
    articlePublishedAt?: string;
    note?: string;
    tags?: string[];
    // Quote-reshare: the AT URI of the original link post being quoted.
    repostUri?: string;
  }): Promise<{ uri: string; cid: string; rkey: string; publication: string }> {
    return this.fetch('/api/linkblog/share', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteLinkblogShare(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/linkblog/share/${rkey}`, {
      method: 'DELETE',
    });
  }

  // Update the note on an existing linkblog share (empty string clears it).
  async updateLinkblogShareNote(
    rkey: string,
    note: string
  ): Promise<{ uri: string; cid: string; rkey: string }> {
    return this.fetch(`/api/linkblog/share/${rkey}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    });
  }

  // Boost — a bare recommend of someone's link post (no commentary).
  async createBoost(data: {
    rkey: string;
    document: string;
  }): Promise<{ uri: string; cid: string; rkey: string }> {
    return this.fetch('/api/linkblog/boost', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteBoost(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/linkblog/boost/${rkey}`, {
      method: 'DELETE',
    });
  }

  // Social context (Constellation) for link posts — recommend/quote counts +
  // "who else linked this article". Best-effort adornment; degrades to empty.
  async fetchSocialContext(
    items: Array<{ key?: string; docUri?: string; articleUrl?: string; excludeDid?: string }>
  ): Promise<{ items: SocialContextResult[] }> {
    return this.fetch('/api/v2/social-context', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  async getLinkblogPublication(): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication');
  }

  async updateLinkblogPublication(data: {
    name?: string;
    description?: string;
  }): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication', {
      method: 'PATCH',
      body: JSON.stringify(data),
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
      labels?: string[];
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
      // Tombstone marker: set (unix seconds) when the label was deleted; only
      // appears in delta (`since`) responses. Live snapshots never include it.
      deletedAt?: number | null;
    }>;
    cursor?: string;
  }> {
    const params = new URLSearchParams();
    if (options.label) params.set('label', options.label);
    if (options.labels?.length) params.set('labels', options.labels.join(','));
    if (options.itemType) params.set('itemType', options.itemType);
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.since !== undefined) params.set('since', String(options.since));
    const query = params.toString();
    return this.fetch(`/api/labels${query ? `?${query}` : ''}`);
  }

  async getAllLabels(
    options: { label?: string; labels?: string[]; itemType?: ItemLabelType; since?: number } = {}
  ): Promise<
    Array<{
      itemKey: string;
      itemType: string;
      label: string;
      props: Record<string, unknown>;
      rkey?: string;
      createdAt: number;
      updatedAt: number;
      deletedAt?: number | null;
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
      deletedAt?: number | null;
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

  // Extract article content via the proxy (fetch + Defuddle, cached proxy-side).
  // Routes through this.fetch so it shares the 503-retry / 401-logout handling
  // (previously a raw fetch here logged users out on any 401, bypassing that logic).
  async extract(url: string): Promise<ExtractedArticle> {
    return this.fetch<ExtractedArticle>('/api/extract', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
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
