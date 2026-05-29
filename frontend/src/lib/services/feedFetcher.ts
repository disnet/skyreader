import { api } from './api';
import { liveDb } from './liveDb.svelte';
import { feedStatusStore, type V2FeedResult } from '$lib/stores/feedStatus.svelte';
import type { Subscription } from '$lib/types';

const BATCH_SIZE = 50;
// Small first batch so the initial feeds land and the UI paints quickly;
// later batches use the full BATCH_SIZE for throughput.
const FIRST_BATCH_SIZE = 8;
const GUIDS_PER_FEED = 10;

// On a cold fetch (no cached GUIDs for a feed) the proxy returns its full
// backlog — up to ~100 items per feed. With many subscriptions that's a lot
// of data to download and write to IndexedDB before the first paint, most of
// which the user will never scroll to. Cap the initial backlog; subsequent
// incremental syncs (which send since_guids) return only new items and ignore
// this limit, so steady-state behaviour is unchanged.
const COLD_START_LIMIT = 30;

/**
 * Check if a subscription's title should be updated from feed metadata.
 * Returns true when the current title is a fallback (URL, hostname, etc.)
 * and the feed provides a real title.
 */
function shouldUpdateTitle(
  currentTitle: string,
  feedUrl: string | undefined,
  fetchedTitle: string
): boolean {
  if (!fetchedTitle || fetchedTitle === 'Untitled Feed') return false;
  if (currentTitle === fetchedTitle) return false;

  // Update if current title is the feed URL
  if (feedUrl && currentTitle === feedUrl) return true;

  // Update if current title is just a hostname
  try {
    const hostname = feedUrl ? new URL(feedUrl).hostname : '';
    if (currentTitle === hostname) return true;
  } catch {
    // ignore invalid URL
  }

  return false;
}

export interface FetchResult {
  totalFeeds: number;
  successfulFeeds: number;
  failedFeeds: number;
  newArticles: number;
}

/**
 * Fetch all subscribed feeds using V2 batch API
 *
 * - Chunks feeds into batches of 50
 * - Uses GUID-based incremental sync (last 10 GUIDs per feed)
 * - Updates feedStatusStore with results
 * - Merges new articles into liveDb
 *
 * @param subscriptions - Array of subscriptions to fetch
 * @param savedGuids - Set of starred article GUIDs (to preserve during cleanup)
 */
export async function fetchAllFeeds(
  subscriptions: Subscription[],
  savedGuids: Set<string> = new Set()
): Promise<FetchResult> {
  const result: FetchResult = {
    totalFeeds: subscriptions.length,
    successfulFeeds: 0,
    failedFeeds: 0,
    newArticles: 0,
  };

  if (subscriptions.length === 0) return result;

  // Skip network requests when offline - cached articles are already loaded
  if (typeof navigator !== 'undefined' && !navigator.onLine) return result;

  // Build feed requests with since_guids
  const feedRequests: Array<{
    url: string;
    since_guids?: string[];
    limit?: number;
    subscriptionId: number;
  }> = [];

  for (const sub of subscriptions) {
    if (!sub.id || !sub.feedUrl) continue;

    // Skip AT Proto subscriptions (they don't have RSS feeds)
    if (sub.sourceType && sub.sourceType.startsWith('atproto.')) continue;

    // Skip feeds in circuit-breaker cooldown
    if (!feedStatusStore.canFetch(sub.feedUrl)) {
      continue;
    }

    const recentGuids = liveDb.getRecentGuids(sub.id, GUIDS_PER_FEED);
    const hasGuids = recentGuids.length > 0;
    feedRequests.push({
      url: sub.feedUrl,
      since_guids: hasGuids ? recentGuids : undefined,
      // Cap the backlog only on a cold fetch; with since_guids the proxy
      // returns just the new items and ignores limit anyway.
      limit: hasGuids ? undefined : COLD_START_LIMIT,
      subscriptionId: sub.id,
    });
  }

  if (feedRequests.length === 0) return result;

  // Process in batches. Each batch is merged (and repaints the UI) as it lands,
  // so use a small first batch to get content on screen fast, then ramp to full
  // batches for throughput on the rest.
  let offset = 0;
  let isFirstBatch = true;
  while (offset < feedRequests.length) {
    const batchSize = isFirstBatch ? FIRST_BATCH_SIZE : BATCH_SIZE;
    const batch = feedRequests.slice(offset, offset + batchSize);
    offset += batchSize;
    isFirstBatch = false;

    try {
      const { feeds } = await api.fetchFeedsBatchV2(
        batch.map((req) => ({
          url: req.url,
          since_guids: req.since_guids,
          limit: req.limit,
        }))
      );

      // Process results. Articles are collected and merged once per batch
      // (rather than once per feed) so the in-memory article array is rebuilt
      // and re-sorted a single time — a big win on cold start with many feeds.
      const toMerge: Array<{ subscriptionId: number; items: V2FeedResult['items'] }> = [];

      for (const req of batch) {
        const feedResult = feeds[req.url] as V2FeedResult | undefined;

        if (!feedResult) {
          // No result for this feed (shouldn't happen)
          feedStatusStore.markError(req.url, 'No response from server');
          result.failedFeeds++;
          continue;
        }

        // Update feed status
        feedStatusStore.updateFromV2Result(req.url, feedResult);

        if (feedResult.status === 'error') {
          result.failedFeeds++;
          continue;
        }

        // Update subscription title/siteUrl from feed metadata
        if (feedResult.title) {
          const sub = liveDb.getSubscriptionById(req.subscriptionId);
          if (sub && shouldUpdateTitle(sub.title, sub.feedUrl, feedResult.title)) {
            await liveDb.updateSubscription(req.subscriptionId, {
              title: feedResult.title,
              siteUrl: feedResult.siteUrl ?? sub.siteUrl,
              localUpdatedAt: Date.now(),
            });
          }
        }

        // Queue new articles for a single batched merge below
        if (feedResult.items && feedResult.items.length > 0) {
          toMerge.push({ subscriptionId: req.subscriptionId, items: feedResult.items });
        }

        result.successfulFeeds++;
      }

      // Merge this batch's articles in one pass
      if (toMerge.length > 0) {
        result.newArticles += await liveDb.mergeArticlesBatch(toMerge, savedGuids);
      }
    } catch (e) {
      // Batch request failed - mark all feeds in batch as error
      const errorMessage = e instanceof Error ? e.message : 'Batch request failed';
      for (const req of batch) {
        feedStatusStore.markError(req.url, errorMessage);
        result.failedFeeds++;
      }
    }
  }

  return result;
}

export interface FetchSingleFeedResult {
  success: boolean;
  newArticles: number;
  title?: string;
  siteUrl?: string;
}

/**
 * Fetch a single feed using V2 API
 *
 * @param subscription - Subscription to fetch
 * @param force - If true, fetch from source ignoring cache
 * @param savedGuids - Set of starred article GUIDs
 */
export async function fetchSingleFeed(
  subscription: Subscription,
  force = false,
  savedGuids: Set<string> = new Set()
): Promise<FetchSingleFeedResult> {
  if (!subscription.id || !subscription.feedUrl) {
    return { success: false, newArticles: 0 };
  }

  // Skip if in circuit-breaker cooldown (unless forcing)
  if (!force && !feedStatusStore.canFetch(subscription.feedUrl)) {
    return { success: false, newArticles: 0 };
  }

  try {
    const recentGuids = force ? undefined : liveDb.getRecentGuids(subscription.id, GUIDS_PER_FEED);

    const feed = await api.fetchFeedV2(subscription.feedUrl, recentGuids);

    // Mark as ready
    feedStatusStore.markReady(subscription.feedUrl);

    // Update subscription title/siteUrl from feed metadata
    if (feed.title && shouldUpdateTitle(subscription.title, subscription.feedUrl, feed.title)) {
      await liveDb.updateSubscription(subscription.id, {
        title: feed.title,
        siteUrl: feed.siteUrl ?? subscription.siteUrl,
        localUpdatedAt: Date.now(),
      });
    }

    // Merge articles
    let newArticles = 0;
    if (feed.items && feed.items.length > 0) {
      newArticles = await liveDb.mergeArticles(subscription.id, feed.items, savedGuids);
    }

    return {
      success: true,
      newArticles,
      title: feed.title,
      siteUrl: feed.siteUrl,
    };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Failed to fetch feed';
    if (subscription.feedUrl) feedStatusStore.markError(subscription.feedUrl, errorMessage);
    return { success: false, newArticles: 0 };
  }
}

/**
 * Fetch feeds for newly added subscriptions
 * These are fetched one by one since they don't have any cached content yet
 *
 * @param subscriptions - New subscriptions to fetch
 * @param savedGuids - Set of starred article GUIDs
 * @param onProgress - Progress callback (current, total)
 */
export async function fetchNewSubscriptionFeeds(
  subscriptions: Subscription[],
  savedGuids: Set<string> = new Set(),
  onProgress?: (current: number, total: number) => void
): Promise<FetchResult> {
  const result: FetchResult = {
    totalFeeds: subscriptions.length,
    successfulFeeds: 0,
    failedFeeds: 0,
    newArticles: 0,
  };

  for (let i = 0; i < subscriptions.length; i++) {
    const sub = subscriptions[i];
    onProgress?.(i, subscriptions.length);

    const fetchResult = await fetchSingleFeed(sub, true, savedGuids);
    if (fetchResult.success) {
      result.successfulFeeds++;
      result.newArticles += fetchResult.newArticles;
    } else {
      result.failedFeeds++;
    }
  }

  onProgress?.(subscriptions.length, subscriptions.length);
  return result;
}

/**
 * Force refresh all feeds from source (bypass cache)
 *
 * @param subscriptions - Subscriptions to refresh
 * @param savedGuids - Set of starred article GUIDs
 * @param concurrency - Number of concurrent requests
 * @param delayMs - Delay between batches
 */
export async function forceRefreshAllFeeds(
  subscriptions: Subscription[],
  savedGuids: Set<string> = new Set(),
  concurrency = 3,
  delayMs = 1000
): Promise<FetchResult> {
  const result: FetchResult = {
    totalFeeds: subscriptions.length,
    successfulFeeds: 0,
    failedFeeds: 0,
    newArticles: 0,
  };

  if (subscriptions.length === 0) return result;

  // Process in batches with rate limiting
  for (let i = 0; i < subscriptions.length; i += concurrency) {
    const batch = subscriptions.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map((sub) => fetchSingleFeed(sub, true, savedGuids))
    );

    for (const batchResult of batchResults) {
      if (batchResult.status === 'fulfilled' && batchResult.value.success) {
        result.successfulFeeds++;
        result.newArticles += batchResult.value.newArticles;
      } else {
        result.failedFeeds++;
      }
    }

    // Delay between batches
    if (i + concurrency < subscriptions.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return result;
}
