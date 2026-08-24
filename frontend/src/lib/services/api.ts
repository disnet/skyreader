import type {
  FeedItem,
  IntegrationStatus,
  ItemLabel,
  ItemLabelType,
  LinkblogPerson,
  LinkblogPublication,
  Magazine,
  MagazineItemSnapshot,
  MagazineParams,
  MagazinePosition,
  MarginCollection,
  ParsedFeed,
  SaveBacking,
  SembleCollection,
  SocialContextResult,
  ArticleMentions,
  MentionLaneEntry,
  SocialDocument,
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

// A non-2xx the client may want to branch on by status (the feed path uses it to
// detect a backend that predates /api/v2/timeline and fall back). `message` is
// unchanged from the generic error path, so existing `e.message` handling still
// works.
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
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

// One page of GET /api/v2/timeline. Items carry their archive `seq` and the feed
// they belong to; `cursor`/`generation` are stored and echoed on the next poll.
export interface TimelineResponse {
  items: Array<FeedItem & { seq: number; feedUrl: string; read: boolean }>;
  cursor: number;
  generation: string;
  hasMore: boolean;
  // Server time (unix seconds) at annotation — seeds the forward read delta.
  readCursor?: number;
  // True when the server served a per-feed newest slice instead of draining from
  // a cursor (no cursor sent, or the generation no longer matches).
  coldStart: boolean;
  // Continuation index for a paged cold start; echo it back as `cold_offset`.
  nextColdOffset?: number;
  // Whether this deployment's crawler is actually pushing into the archive.
  // Absent on a backend that predates the flag.
  ingestActive?: boolean;
  // Feed-level metadata for the caller's subscriptions; present only on a page
  // that carried items.
  feeds?: Record<string, { title?: string; siteUrl?: string; imageUrl?: string }>;
  // Revision of the server's unhealthy-feed set. Echoed back as `health_rev` so
  // the payload below is only re-sent when it actually changed.
  healthRev?: string;
  // Per-feed crawl health for the caller's subscriptions — ONLY the broken ones.
  // A subscribed feed missing from this map is healthy, which is how recovery is
  // communicated. Present on every cold start and whenever `healthRev` moved.
  // Absent entirely on a backend that predates feed-health reporting.
  feedHealth?: Record<string, TimelineFeedHealth>;
}

/** One broken feed as the timeline reports it. Timestamps are unix ms. */
export interface TimelineFeedHealth {
  errorCount: number;
  error?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
  lastFetchedAt?: number;
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
          const b = body as {
            message: string;
            limit: number;
            current: number;
            resetsAt: string;
          };
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
      throw new ApiError(
        (error as { error: string }).error || `HTTP ${response.status}`,
        response.status
      );
    }

    return response.json() as Promise<T>;
  }

  // Auth
  async login(handle: string, returnUrl?: string): Promise<{ authUrl: string }> {
    const params = new URLSearchParams({ handle });
    if (returnUrl) params.set('returnUrl', returnUrl);
    return this.fetch(`/api/auth/login?${params}`);
  }

  // Server-first sign-up: start OAuth against a provider's PDS/entryway host with
  // no account yet. The provider offers account creation, then redirects back here.
  async signup(pds: string, returnUrl?: string): Promise<{ authUrl: string }> {
    const params = new URLSearchParams({ pds });
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
  // One feed's newest slice from the server-side archive. `refresh` forces the
  // backend to re-fetch it through the crawler first (the per-feed retry action).
  async fetchFeedV2(
    url: string,
    sinceGuids?: string[],
    limit?: number,
    refresh = false
  ): Promise<ParsedFeed> {
    const params = new URLSearchParams({ url });
    if (sinceGuids && sinceGuids.length > 0) {
      params.set('since_guids', sinceGuids.join(','));
    }
    if (limit) {
      params.set('limit', limit.toString());
    }
    if (refresh) {
      params.set('refresh', '1');
    }
    return this.fetch(`/api/v2/feeds/fetch?${params}`);
  }

  /**
   * The whole feed refresh in one request: every new item across every
   * subscription, with read state already stamped on. `since_seq` + `generation`
   * are the client's global cursor into the server-side archive; `hasMore` drives
   * the drain loop. Replaces the per-subscription batch calls below.
   */
  async fetchTimeline(params: {
    since_seq?: number;
    generation?: string;
    limit?: number;
    cold_offset?: number;
    health_rev?: string;
  }): Promise<TimelineResponse> {
    const search = new URLSearchParams();
    if (params.since_seq !== undefined) search.set('since_seq', String(params.since_seq));
    if (params.generation) search.set('generation', params.generation);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.cold_offset) search.set('cold_offset', String(params.cold_offset));
    if (params.health_rev) search.set('health_rev', params.health_rev);
    const query = search.toString();
    return this.fetch(`/api/v2/timeline${query ? `?${query}` : ''}`);
  }

  async fetchFeedsBatchV2(
    feeds: Array<{
      url: string;
      since_guids?: string[];
      since_seq?: number;
      generation?: string;
      limit?: number;
    }>
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
        // Durable-log cursor contract (RETENTION_SYNC_PLAN.md).
        cursor?: number;
        generation?: string;
        hasMore?: boolean;
      }
    >;
    // Server time (unix seconds) the response was read-annotated. The client
    // seeds its forward-read-delta cursor from this on its first annotated fetch.
    readCursor?: number;
  }> {
    return this.fetch('/api/v2/feeds/batch', {
      method: 'POST',
      body: JSON.stringify({ feeds }),
    });
  }

  async fetchDocumentsBatchV2(
    documents: Array<{ did: string; siteUri?: string; since_digest?: string }>
  ): Promise<{
    authors: Array<{
      did: string;
      siteUri?: string;
      // Present only on `ready`; absent on `unchanged` (bodyless) and `error`.
      documents?: SocialDocument[];
      status: 'ready' | 'unchanged' | 'error';
      error?: string;
      errorCount?: number;
      nextRetryAt?: number;
      // Per-scope content hash to store and echo as `since_digest` next poll.
      digest?: string;
      // True when `documents` is the author's complete set (fit under the proxy's
      // per-author cap) — lets a client treat an absent record as deleted.
      complete?: boolean;
    }>;
    // See fetchFeedsBatchV2 — documents ride the identical read delta.
    readCursor?: number;
  }> {
    return this.fetch('/api/v2/documents/batch', {
      method: 'POST',
      body: JSON.stringify({ documents }),
    });
  }

  // On-demand fetch of a single standard.site document by at:// URI — the in-app
  // reader path for a curated Collection piece the user doesn't subscribe to.
  // Returns null when the proxy can't resolve it.
  async fetchDocumentV2(uri: string): Promise<SocialDocument | null> {
    const res = await this.fetch<{ document?: SocialDocument }>(
      `/api/v2/documents/get?uri=${encodeURIComponent(uri)}`
    );
    return res.document ?? null;
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
  }> {
    return this.fetch(`/api/social/detect-content?did=${encodeURIComponent(did)}`);
  }

  // Linkblog discovery (Phase 6)
  // Friends with linkblogs: people you follow on Bluesky who have one.
  async getLinkblogFriends(): Promise<{ people: LinkblogPerson[] }> {
    return this.fetch('/api/linkblog/discover/friends');
  }

  // The whole linkblog registry for /discover — friends first, then others.
  async getLinkblogDiscover(): Promise<{ people: LinkblogPerson[] }> {
    return this.fetch('/api/linkblog/discover');
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
    // `parked` lists rkeys held over the plan's active capacity — mirrored to the
    // account + PDS but not serviced. `skipped` lists rkeys dropped as duplicates
    // of a feed the user already has (active or parked). `dropped` lists rkeys over
    // the plan's mirror ceiling — not stored at all (but still on the PDS). Callers
    // should not add any of these to the reader's local cache.
  ): Promise<{
    results: Array<{ rkey: string; uri: string }>;
    parked?: string[];
    skipped?: string[];
    dropped?: string[];
  }> {
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

  // Parked feeds — PDS records over the plan's active capacity. Mirrored to the
  // account but not serviced or shown in the reader; listed/reactivated here.
  async getParkedSubscriptions(): Promise<{
    records: Array<{
      uri: string;
      cid: string;
      value: {
        $type: string;
        feedUrl: string;
        title: string | null;
        createdAt: string;
        sourceType?: string;
        subjectDid?: string;
        customTitle?: string;
        customIconUrl?: string;
        category?: string;
      };
    }>;
  }> {
    return this.fetch('/api/subscriptions/parked');
  }

  // Flip a subscription's local servicing state. Activating can 403 with
  // `subscription_limit_reached` when the plan's active slots are full.
  async activateSubscription(rkey: string): Promise<{ success: boolean; active: boolean }> {
    return this.fetch(`/api/subscriptions/${rkey}/activate`, { method: 'POST' });
  }

  async parkSubscription(rkey: string): Promise<{ success: boolean; active: boolean }> {
    return this.fetch(`/api/subscriptions/${rkey}/park`, { method: 'POST' });
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

  // Social context (Constellation) for link posts — how many posts quote this
  // one. Best-effort adornment; degrades to empty.
  async fetchSocialContext(
    items: Array<{ key?: string; docUri?: string }>
  ): Promise<{ items: SocialContextResult[] }> {
    return this.fetch('/api/v2/social-context', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  // Network-wide article mentions (Phase 5) — per-lane breakdown of who across
  // the Atmosphere referenced these URLs. Best-effort adornment; degrades to
  // empty per URL.
  async fetchArticleMentions(urls: string[]): Promise<{ items: ArticleMentions[] }> {
    return this.fetch('/api/v2/mentions', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    });
  }

  // The people inside one lane (Phase 5 "see existing items") — who referenced
  // this URL via that lane, with their note + a link out. Lazily fetched when a
  // lane is expanded. Best-effort adornment; degrades to an empty list.
  async fetchMentionLaneItems(url: string, lane: string): Promise<{ entries: MentionLaneEntry[] }> {
    return this.fetch('/api/v2/mention-lane', {
      method: 'POST',
      body: JSON.stringify({ url, lane }),
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

  async deleteLinkblog(): Promise<{ success: true; deletedPosts: number }> {
    return this.fetch('/api/linkblog/publication', { method: 'DELETE' });
  }

  async restoreLinkblog(): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication', { method: 'POST' });
  }

  async listLinkblogPublications(): Promise<{
    publications: import('$lib/types').LinkblogPublicationChoice[];
  }> {
    return this.fetch('/api/linkblog/publications');
  }

  async connectLinkblogPublication(
    publicationUri: string,
    format: LinkblogPublication['format']
  ): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication/connect', {
      method: 'PUT',
      body: JSON.stringify({ publicationUri, format }),
    });
  }

  async disconnectLinkblogPublication(): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication/connect', { method: 'DELETE' });
  }

  // Whether Skyreader serves the public linkblog page. Only accepted while a
  // publication is connected — otherwise that page is the only public address the
  // links have, and the backend refuses.
  async setLinkblogPageHidden(pageHidden: boolean): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication/visibility', {
      method: 'PUT',
      body: JSON.stringify({ pageHidden }),
    });
  }

  // Subscribe via the Atmosphere — writes/reads/deletes only the portable
  // site.standard.graph.subscription record (no Skyreader subscription).
  async getAtmosphereSubscription(publication: string): Promise<{ subscribed: boolean }> {
    return this.fetch(
      `/api/atmosphere/subscription?publication=${encodeURIComponent(publication)}`
    );
  }

  async subscribeAtmosphere(publication: string): Promise<{ subscribed: boolean; uri?: string }> {
    return this.fetch('/api/atmosphere/subscription', {
      method: 'POST',
      body: JSON.stringify({ publication }),
    });
  }

  async unsubscribeAtmosphere(publication: string): Promise<{ subscribed: boolean }> {
    return this.fetch('/api/atmosphere/subscription', {
      method: 'DELETE',
      body: JSON.stringify({ publication }),
    });
  }

  // List records (still used for syncFromBackend)
  async listRecords<T>(collection: string): Promise<{
    records: Array<{ uri: string; cid: string; value: T }>;
  }> {
    return this.fetch(`/api/records/list?collection=${encodeURIComponent(collection)}`);
  }

  // Reading (forward read delta)
  // Pass `since` (a previously returned cursor) for an incremental delta fetch.
  // The response carries every `read` row changed since the cursor — live rows
  // AND tombstones (deleted=true) — across articles and documents. Bootstrap read
  // state arrives via inline annotation on the fetch response, not here, so this
  // is always a delta. Returns the new cursor to send next time.
  async getReadPositions(since?: number): Promise<{
    positions: Array<{
      item_guid: string;
      item_type: 'article' | 'document';
      read_at: number | string | null;
      rkey: string | null;
      deleted: boolean;
    }>;
    cursor: number;
  }> {
    const params = since ? `?since=${since}` : '';
    return this.fetch(`/api/reading/positions${params}`);
  }

  async markAsRead(data: {
    itemGuid: string;
    itemType?: 'article' | 'document';
    itemUrl?: string;
    itemTitle?: string;
    rkey?: string;
    authorDid?: string;
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
      itemType?: 'article' | 'document';
      itemUrl?: string;
      itemTitle?: string;
      rkey?: string;
      authorDid?: string;
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
    options: {
      label?: string;
      labels?: string[];
      itemType?: ItemLabelType;
      since?: number;
    } = {}
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

  // Magazines (durable, cross-device reading issues)
  async getMagazines(
    options: { since?: number; cursor?: string; limit?: number } = {}
  ): Promise<{ magazines: Magazine[]; cursor?: string }> {
    const params = new URLSearchParams();
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.fetch(`/api/magazines${query ? `?${query}` : ''}`);
  }

  // Paginate the full magazine set (or delta when `since` is given).
  async getAllMagazines(options: { since?: number } = {}): Promise<Magazine[]> {
    const all: Magazine[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.getMagazines({ ...options, cursor, limit: 500 });
      all.push(...response.magazines);
      cursor = response.cursor;
    } while (cursor);
    return all;
  }

  async upsertMagazine(data: {
    rkey: string;
    params: MagazineParams;
    items: MagazineItemSnapshot[];
    position?: MagazinePosition | null;
    title?: string | null;
  }): Promise<{ success: boolean; rkey: string }> {
    return this.fetch('/api/magazines', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateMagazinePosition(
    rkey: string,
    position: MagazinePosition | null
  ): Promise<{ success: boolean }> {
    return this.fetch('/api/magazines/position', {
      method: 'PATCH',
      body: JSON.stringify({ rkey, position }),
    });
  }

  async deleteMagazine(rkey: string): Promise<{ success: boolean }> {
    return this.fetch('/api/magazines', {
      method: 'DELETE',
      body: JSON.stringify({ rkey }),
    });
  }

  // Settings
  async getSettings(): Promise<{
    pdsSyncEnabled: boolean;
    lastPdsSyncSubscriptions: number | null;
    backing: SaveBacking;
    linkblogDisabled: boolean;
    createdAt: number;
    updatedAt: number;
  }> {
    return this.fetch('/api/settings');
  }

  async updateSettings(settings: { pdsSyncEnabled?: boolean }): Promise<{
    pdsSyncEnabled: boolean;
    lastPdsSyncSubscriptions: number | null;
    backing: SaveBacking;
    createdAt: number;
    updatedAt: number;
  }> {
    return this.fetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  /**
   * Turn external-backed saves on or off (Phase 5). Enable backs the Saved list
   * with a Semble/Margin collection (creating a default "Skyreader Saves" if no
   * collectionUri is given) and optionally exports existing saves into it. A 403
   * scope_upgrade_required (caught by the fetch wrapper) means the provider scopes
   * must be re-granted via login.
   */
  async setBacking(
    body:
      | {
          action: 'enable';
          provider: 'semble' | 'margin';
          collectionUri?: string;
          exportExisting?: boolean;
        }
      | { action: 'disable' }
  ): Promise<{ backing: SaveBacking; exported?: number }> {
    return this.fetch('/api/saved/backing', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Export one slice of the user's existing saves into their (already-on) backing
   * collection. Returns `exported` (records created this call), `scanned` (rows
   * examined — advance `offset` by this), and `total` (candidate count, for a
   * progress denominator). Loop with `offset += scanned` until `scanned === 0` or
   * `offset >= total` so a large library uploads with a live progress bar.
   */
  async exportSavesBatch(
    offset: number,
    limit?: number
  ): Promise<{ exported: number; scanned: number; total: number }> {
    return this.fetch('/api/saved/backing', {
      method: 'POST',
      body: JSON.stringify({ action: 'exportBatch', offset, limit }),
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

  async createMarginNote(data: {
    source: string;
    title?: string;
    exact: string;
    prefix?: string;
    suffix?: string;
    note?: string;
  }): Promise<{ uri: string; cid: string; rkey: string }> {
    return this.fetch('/api/integrations/margin/notes', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateMarginNote(
    rkey: string,
    data: {
      source: string;
      title?: string;
      exact: string;
      prefix?: string;
      suffix?: string;
      note?: string;
    }
  ): Promise<{ uri: string; cid: string; rkey: string }> {
    return this.fetch(`/api/integrations/margin/notes/${encodeURIComponent(rkey)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteMarginNote(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/integrations/margin/notes/${encodeURIComponent(rkey)}`, {
      method: 'DELETE',
    });
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
      source?: 'url' | 'feed' | 'document';
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
    source?: 'url' | 'feed' | 'document';
    itemGuid?: string;
  }> {
    return this.fetch('/api/saved', {
      method: 'POST',
      body: JSON.stringify({ url, rkey, ...options }),
    });
  }

  async getSaved(opts?: { limit?: number; cursor?: string | null }): Promise<{
    // Metadata only — `content` (the article body) is omitted; hydrate it for
    // unseen rkeys via getSavedBodies. The body is ~20-50× the rest of a row and
    // the client already caches it, so re-sending it every refresh is the bulk
    // of the "excessive data" this endpoint used to ship.
    articles: Array<{
      rkey: string;
      uri: string;
      url: string;
      title: string | null;
      author: string | null;
      description: string | null;
      contentType: string | null;
      domain: string | null;
      image: string | null;
      wordCount: number | null;
      publishedAt: string | null;
      savedAt: string;
      source?: 'url' | 'feed' | 'document';
      itemGuid?: string;
    }>;
    // Keyset cursor for the next (older) page; null at the end of the list.
    cursor: string | null;
    // True when the response is a full snapshot that must replace the cache
    // wholesale (external-backed saves) rather than being merged incrementally.
    full: boolean;
  }> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return this.fetch(`/api/saved${qs ? `?${qs}` : ''}`);
  }

  // Hydrate article bodies for the given rkeys. Returns a map rkey → body (null
  // when the row has no stored content yet, e.g. a backed stub awaiting
  // extraction). The client calls this only for saves it hasn't cached locally.
  async getSavedBodies(rkeys: string[]): Promise<{ bodies: Record<string, string | null> }> {
    return this.fetch('/api/saved/bodies', {
      method: 'POST',
      body: JSON.stringify({ rkeys }),
    });
  }

  // Patch mutable fields on an existing saved item (currently just the
  // precomputed word count, used to backfill old saves that lack one).
  async updateSaved(rkey: string, fields: { wordCount?: number }): Promise<{ success: boolean }> {
    return this.fetch(`/api/saved/${rkey}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
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
    /** Set when the user's PDS moved and they must reconnect to resume sync. */
    needsReauth?: boolean;
    subscriptions?: {
      success: boolean;
      pulledFromPds: number;
      pushedToPds: number;
      skipped: number;
      warnings: string[];
      hasMore?: boolean;
      needsReauth?: boolean;
    };
    atmosphere?: {
      success: boolean;
      imported: number;
      removed: number;
      pushed: number;
      skipped: number;
      warnings: string[];
      hasMore?: boolean;
      error?: string;
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
    data: {
      name: string;
      config: string;
      position: number;
      createdAt: number;
      updatedAt: number;
    }
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
