import { api } from './api';
import { liveDb } from './liveDb.svelte';
import { feedStatusStore, type V2FeedResult } from '$lib/stores/feedStatus.svelte';
import type { Subscription } from '$lib/types';

const BATCH_SIZE = 5;
const GUIDS_PER_FEED = 10;

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
 * @param starredGuids - Set of starred article GUIDs (to preserve during cleanup)
 */
export async function fetchAllFeeds(
	subscriptions: Subscription[],
	starredGuids: Set<string> = new Set()
): Promise<FetchResult> {
	const result: FetchResult = {
		totalFeeds: subscriptions.length,
		successfulFeeds: 0,
		failedFeeds: 0,
		newArticles: 0,
	};

	if (subscriptions.length === 0) return result;

	// Build feed requests with since_guids
	const feedRequests: Array<{ url: string; since_guids?: string[]; subscriptionId: number }> = [];

	for (const sub of subscriptions) {
		if (!sub.id) continue;

		// Skip feeds in circuit-breaker cooldown
		if (!feedStatusStore.canFetch(sub.feedUrl)) {
			continue;
		}

		const recentGuids = liveDb.getRecentGuids(sub.id, GUIDS_PER_FEED);
		feedRequests.push({
			url: sub.feedUrl,
			since_guids: recentGuids.length > 0 ? recentGuids : undefined,
			subscriptionId: sub.id,
		});
	}

	if (feedRequests.length === 0) return result;

	// Process in batches
	for (let i = 0; i < feedRequests.length; i += BATCH_SIZE) {
		const batch = feedRequests.slice(i, i + BATCH_SIZE);

		try {
			const { feeds } = await api.fetchFeedsBatchV2(
				batch.map((req) => ({
					url: req.url,
					since_guids: req.since_guids,
				}))
			);

			// Process results
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

				// Merge new articles
				if (feedResult.items && feedResult.items.length > 0) {
					const newCount = await liveDb.mergeArticles(
						req.subscriptionId,
						feedResult.items,
						starredGuids
					);
					result.newArticles += newCount;
				}

				result.successfulFeeds++;
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
 * @param starredGuids - Set of starred article GUIDs
 */
export async function fetchSingleFeed(
	subscription: Subscription,
	force = false,
	starredGuids: Set<string> = new Set()
): Promise<FetchSingleFeedResult> {
	if (!subscription.id) {
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

		// Merge articles
		let newArticles = 0;
		if (feed.items && feed.items.length > 0) {
			newArticles = await liveDb.mergeArticles(subscription.id, feed.items, starredGuids);
		}

		return {
			success: true,
			newArticles,
			title: feed.title,
			siteUrl: feed.siteUrl,
		};
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : 'Failed to fetch feed';
		feedStatusStore.markError(subscription.feedUrl, errorMessage);
		return { success: false, newArticles: 0 };
	}
}

/**
 * Fetch feeds for newly added subscriptions
 * These are fetched one by one since they don't have any cached content yet
 *
 * @param subscriptions - New subscriptions to fetch
 * @param starredGuids - Set of starred article GUIDs
 * @param onProgress - Progress callback (current, total)
 */
export async function fetchNewSubscriptionFeeds(
	subscriptions: Subscription[],
	starredGuids: Set<string> = new Set(),
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

		const fetchResult = await fetchSingleFeed(sub, true, starredGuids);
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
 * @param starredGuids - Set of starred article GUIDs
 * @param concurrency - Number of concurrent requests
 * @param delayMs - Delay between batches
 */
export async function forceRefreshAllFeeds(
	subscriptions: Subscription[],
	starredGuids: Set<string> = new Set(),
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
			batch.map((sub) => fetchSingleFeed(sub, true, starredGuids))
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
