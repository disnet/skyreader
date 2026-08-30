/**
 * Feed Status Store - Tracks per-feed error state and circuit breaker status
 *
 * Integrates with the V2 batch API response format which includes:
 * - status: 'ready' | 'error'
 * - error?: string
 * - errorCount?: number
 * - nextRetryAt?: number (Unix timestamp)
 */

import {
  isCircuitOpen,
  reconcileFeedHealth,
  type TimelineFeedHealth,
} from '$lib/services/timelineSync';

/**
 * There is deliberately no 'pending' state. A refresh is one archive-wide
 * `GET /api/v2/timeline` request, not a per-feed fetch, so nothing ever arrives
 * to settle a per-feed "loading": the crawler's health report is the only
 * per-feed signal, and it says either "broken" or — by omission — "not broken".
 * Seeding every subscription 'pending' at boot therefore left a spinner next to
 * every source in the sidebar that never settled.
 */
export type FeedStatusType = 'ready' | 'error' | 'circuit-open';
export type ErrorType = 'transient' | 'permanent';

export interface ErrorDetails {
  title: string;
  description: string;
  isPermanent: boolean;
  errorCount: number;
  errorCode?: string;
  nextRetryAt?: number;
  rawError?: string;
}

export interface FeedStatus {
  status: FeedStatusType;
  errorCount: number;
  errorMessage?: string;
  errorType?: ErrorType;
  nextRetryAt?: number; // Unix timestamp in ms
  lastFetchedAt?: number;
  lastCheckedAt?: number;
}

// Error codes that indicate permanent failures (feed is gone/unauthorized)
const PERMANENT_ERROR_PATTERNS = [
  '401',
  '403',
  '404',
  '410',
  'not found',
  'unauthorized',
  'forbidden',
  'gone',
];

// Error codes that indicate transient failures (server issues, rate limiting)
const TRANSIENT_ERROR_PATTERNS = ['429', '5', 'timeout', 'network', 'econnrefused', 'dns'];

/**
 * Classify an error message as transient or permanent
 */
function classifyError(errorMessage?: string): ErrorType {
  if (!errorMessage) return 'transient';
  const lower = errorMessage.toLowerCase();

  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (lower.includes(pattern)) return 'permanent';
  }

  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (lower.includes(pattern)) return 'transient';
  }

  // Default to transient for unknown errors
  return 'transient';
}

/**
 * V2 API batch response format for a single feed
 */
export interface V2FeedResult {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: Array<{
    guid: string;
    url: string;
    title: string;
    author?: string;
    content?: string;
    summary?: string;
    imageUrl?: string;
    publishedAt: string;
    // Per-user read state stamped by the backend (inline read annotation).
    read?: boolean;
  }>;
  status: 'ready' | 'error';
  error?: string;
  errorCount?: number;
  nextRetryAt?: number;
  lastFetchedAt?: number;
  // Durable-log cursor contract (RETENTION_SYNC_PLAN.md): max seq seen, the DB
  // generation token, and whether the feed's backlog still has more to drain.
  cursor?: number;
  generation?: string;
  hasMore?: boolean;
}

/**
 * One broken feed as the timeline reports it (`feedHealth` on the response).
 * Timestamps are unix ms.
 */
export type FeedHealthSnapshot = TimelineFeedHealth;

function createFeedStatusStore() {
  let statuses = $state<Map<string, FeedStatus>>(new Map());

  // Derived: feeds with errors
  let errorFeeds = $derived.by(() => {
    const errors: Array<{ feedUrl: string; status: FeedStatus }> = [];
    for (const [feedUrl, status] of statuses) {
      if (status.status === 'error' || status.status === 'circuit-open') {
        errors.push({ feedUrl, status });
      }
    }
    return errors;
  });

  // Derived: feeds that can be fetched (not in circuit-breaker cooldown)
  let fetchableFeeds = $derived.by(() => {
    const now = Date.now();
    const fetchable: string[] = [];
    for (const [feedUrl, status] of statuses) {
      if (status.status === 'circuit-open' && status.nextRetryAt && status.nextRetryAt > now) {
        continue; // Skip feeds in cooldown
      }
      fetchable.push(feedUrl);
    }
    return fetchable;
  });

  // Derived: feeds with permanent errors
  let permanentErrorFeeds = $derived.by(() => {
    const permanent: Array<{ feedUrl: string; status: FeedStatus }> = [];
    for (const [feedUrl, status] of statuses) {
      if (status.errorType === 'permanent') {
        permanent.push({ feedUrl, status });
      }
    }
    return permanent;
  });

  /**
   * Update status for a feed from V2 batch response
   */
  function updateFromV2Result(feedUrl: string, result: V2FeedResult): void {
    const now = Date.now();

    if (result.status === 'ready') {
      statuses.set(feedUrl, {
        status: 'ready',
        errorCount: 0,
        lastFetchedAt: result.lastFetchedAt || now,
        lastCheckedAt: now,
      });
    } else {
      // Error response. `nextRetryAt` is already unix MILLISECONDS — the proxy
      // computes it as `Date.now() + backoff` and passes it through untouched.
      // It used to be re-scaled by 1000 here, which put every retry ~50,000 years
      // out: `canFetch` then refused the feed forever and the popover offered an
      // absurd countdown, so a feed that hit one transient error was never
      // retried again for the life of the tab.
      statuses.set(
        feedUrl,
        buildErrorStatus(feedUrl, now, {
          errorCount: result.errorCount || 1,
          error: result.error,
          nextRetryAt: result.nextRetryAt,
          lastFetchedAt: result.lastFetchedAt,
        })
      );
    }

    // Trigger reactivity
    statuses = new Map(statuses);
  }

  /**
   * Shared shape for "this feed is broken", from either the legacy batch
   * response or the timeline's health payload.
   */
  function buildErrorStatus(feedUrl: string, now: number, health: FeedHealthSnapshot): FeedStatus {
    return {
      status: isCircuitOpen(health.nextRetryAt, now) ? 'circuit-open' : 'error',
      errorCount: health.errorCount || 1,
      errorMessage: health.error,
      errorType: classifyError(health.error),
      nextRetryAt: health.nextRetryAt,
      lastFetchedAt: health.lastFetchedAt ?? statuses.get(feedUrl)?.lastFetchedAt,
      lastCheckedAt: now,
    };
  }

  /**
   * Apply the timeline's per-feed health for a whole subscription set.
   *
   * The timeline path has no per-request feed status to report — reads are served
   * from the archive and never touch the crawler — so the server sends the set of
   * feeds it currently considers broken and this reconciles against it. Only the
   * broken ones are listed, so a subscribed feed that is ABSENT is healthy: that
   * is what clears an error once a feed starts working again, including one
   * inherited from the legacy batch path.
   *
   * Feeds the crawler hasn't reached yet are simply not in `subscribedFeedUrls`'s
   * intersection with any known status, so they keep whatever state they had
   * (usually 'pending') rather than being asserted healthy.
   */
  function applyHealthSnapshot(
    unhealthy: Record<string, FeedHealthSnapshot>,
    subscribedFeedUrls: Iterable<string>
  ): void {
    const now = Date.now();
    const decisions = reconcileFeedHealth(unhealthy, subscribedFeedUrls, (feedUrl) => {
      const status = statuses.get(feedUrl)?.status;
      return status === 'error' || status === 'circuit-open';
    });
    if (decisions.length === 0) return;

    for (const decision of decisions) {
      if (decision.kind === 'error') {
        statuses.set(decision.feedUrl, buildErrorStatus(decision.feedUrl, now, decision.health));
      } else {
        // Recovered. Keep the last known fetch time rather than stamping one:
        // the report says the feed is no longer broken, not that we just read it.
        statuses.set(decision.feedUrl, {
          status: 'ready',
          errorCount: 0,
          lastFetchedAt: statuses.get(decision.feedUrl)?.lastFetchedAt,
          lastCheckedAt: now,
        });
      }
    }

    statuses = new Map(statuses);
  }

  /**
   * Mark a feed as ready
   */
  function markReady(feedUrl: string): void {
    statuses.set(feedUrl, {
      status: 'ready',
      errorCount: 0,
      lastFetchedAt: Date.now(),
      lastCheckedAt: Date.now(),
    });
    statuses = new Map(statuses);
  }

  /**
   * Mark a feed as having an error
   */
  function markError(feedUrl: string, errorMessage: string): void {
    const existing = statuses.get(feedUrl);
    const errorType = classifyError(errorMessage);

    statuses.set(feedUrl, {
      status: 'error',
      errorCount: (existing?.errorCount || 0) + 1,
      errorMessage,
      errorType,
      lastFetchedAt: existing?.lastFetchedAt,
      lastCheckedAt: Date.now(),
    });
    statuses = new Map(statuses);
  }

  /**
   * Clear status for a feed
   */
  function clearStatus(feedUrl: string): void {
    statuses.delete(feedUrl);
    statuses = new Map(statuses);
  }

  /**
   * Clear all statuses
   */
  function clearAll(): void {
    statuses = new Map();
  }

  /**
   * Get status for a specific feed
   */
  function getStatus(feedUrl: string): FeedStatus | undefined {
    return statuses.get(feedUrl);
  }

  /**
   * Check if a feed can be fetched (not in circuit-breaker cooldown)
   */
  function canFetch(feedUrl: string): boolean {
    const status = statuses.get(feedUrl);
    if (!status) return true;

    if (status.status === 'circuit-open' && status.nextRetryAt) {
      return Date.now() >= status.nextRetryAt;
    }

    return true;
  }

  /**
   * Get human-readable status message for a feed
   */
  function getStatusMessage(feedUrl: string): string {
    const status = statuses.get(feedUrl);
    if (!status) return '';

    switch (status.status) {
      case 'ready':
        return '';
      case 'error':
        if (status.errorMessage?.toLowerCase().includes('blocking automated access')) {
          return 'Blocked by site';
        }
        if (status.errorType === 'permanent') {
          return 'Feed unavailable';
        }
        return 'Temporarily unavailable';
      case 'circuit-open':
        if (status.nextRetryAt) {
          const retryIn = Math.max(0, Math.ceil((status.nextRetryAt - Date.now()) / 60000));
          return `Retry in ${retryIn} min`;
        }
        return 'Temporarily unavailable';
      default:
        return '';
    }
  }

  /**
   * Get human-readable error details for display in the error popover
   */
  function getErrorDetails(feedUrl: string): ErrorDetails | null {
    const status = statuses.get(feedUrl);
    if (!status || (status.status !== 'error' && status.status !== 'circuit-open')) {
      return null;
    }

    const errorMsg = status.errorMessage?.toLowerCase() || '';
    const isPermanent = status.errorType === 'permanent';

    let title: string;
    let description: string;
    let errorCode: string | undefined;

    // Extract HTTP status code if present
    const httpMatch = status.errorMessage?.match(/\b([45]\d{2})\b/);
    if (httpMatch) {
      errorCode = `HTTP ${httpMatch[1]}`;
    }

    // Parse HTTP status codes and common error patterns.
    // The "blocked" case must come before the generic 403 branch — its message
    // contains "(HTTP 403)" but warrants a more specific explanation.
    if (errorMsg.includes('blocking automated access')) {
      title = 'Blocked by site';
      description =
        "This site blocks Skyreader's feed fetcher, likely through a bot filter or CDN (e.g. Cloudflare, Akamai). The feed can't be fetched automatically.";
    } else if (errorMsg.includes('401')) {
      title = 'Authentication Required';
      description = 'This feed requires login credentials that Skyreader cannot provide.';
    } else if (errorMsg.includes('403')) {
      title = 'Access Denied';
      description = 'The server is blocking access to this feed.';
    } else if (errorMsg.includes('404') || errorMsg.includes('not found')) {
      title = 'Feed Not Found';
      description =
        'This feed could not be found. The URL may have changed or the feed may no longer exist.';
    } else if (errorMsg.includes('410') || errorMsg.includes('gone')) {
      title = 'Feed Removed';
      description = 'This feed has been permanently removed by its owner.';
    } else if (errorMsg.includes('429')) {
      title = 'Rate Limited';
      description =
        "The feed's server is limiting requests. Skyreader will automatically retry later.";
    } else if (errorMsg.includes('500')) {
      title = 'Server Error';
      description = "The feed's server is experiencing internal issues.";
    } else if (errorMsg.includes('502')) {
      title = 'Bad Gateway';
      description = "Unable to reach the feed's server through its gateway.";
    } else if (errorMsg.includes('503')) {
      title = 'Service Unavailable';
      description = "The feed's server is temporarily unavailable for maintenance.";
    } else if (errorMsg.includes('504') || errorMsg.includes('timeout')) {
      title = 'Connection Timeout';
      description = "The feed's server took too long to respond.";
    } else if (
      errorMsg.includes('network') ||
      errorMsg.includes('econnrefused') ||
      errorMsg.includes('econnreset')
    ) {
      title = 'Connection Failed';
      description = "Unable to establish a connection to the feed's server.";
    } else if (errorMsg.includes('dns') || errorMsg.includes('enotfound')) {
      title = 'DNS Error';
      description = "Could not resolve the feed's domain name. The domain may no longer exist.";
    } else if (errorMsg.includes('ssl') || errorMsg.includes('certificate')) {
      title = 'SSL/TLS Error';
      description = "The feed's security certificate is invalid or expired.";
    } else if (errorMsg.includes('parse') || errorMsg.includes('invalid')) {
      title = 'Invalid Feed';
      description =
        'The feed content could not be parsed. It may be malformed or not a valid RSS/Atom feed.';
    } else if (isPermanent) {
      title = 'Feed Unavailable';
      description = 'This feed is no longer accessible and may need to be removed.';
    } else {
      title = 'Temporarily Unavailable';
      description = 'There was a problem loading this feed. Skyreader will automatically retry.';
    }

    return {
      title,
      description,
      isPermanent,
      errorCount: status.errorCount,
      errorCode,
      nextRetryAt: status.nextRetryAt,
      rawError: status.errorMessage,
    };
  }

  return {
    get statuses() {
      return statuses;
    },
    get errorFeeds() {
      return errorFeeds;
    },
    get fetchableFeeds() {
      return fetchableFeeds;
    },
    get permanentErrorFeeds() {
      return permanentErrorFeeds;
    },
    updateFromV2Result,
    applyHealthSnapshot,
    markReady,
    markError,
    clearStatus,
    clearAll,
    getStatus,
    canFetch,
    getStatusMessage,
    getErrorDetails,
  };
}

export const feedStatusStore = createFeedStatusStore();
