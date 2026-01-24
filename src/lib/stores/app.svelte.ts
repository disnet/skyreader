import { liveDb } from '$lib/services/liveDb.svelte';
import { readingStore } from './reading.svelte';
import { shareReadingStore } from './shareReading.svelte';
import { sharesStore } from './shares.svelte';
import { socialStore } from './social.svelte';
import { feedStatusStore } from './feedStatus.svelte';
import { articlesStore } from './articles.svelte';
import { fetchAllFeeds, fetchNewSubscriptionFeeds } from '$lib/services/feedFetcher';
import { api } from '$lib/services/api';
import type { Subscription } from '$lib/types';

export type AppPhase = 'idle' | 'hydrating' | 'refreshing' | 'ready' | 'error';

/**
 * App Manager - Central orchestrator for data loading
 *
 * Coordinates the cache-first loading strategy:
 * 1. Hydrate: Load from IndexedDB immediately for instant UI
 * 2. Refresh: Sync with backend in background
 *
 * This replaces the scattered initialization logic in +page.svelte
 */
function createAppManager() {
	let phase = $state<AppPhase>('idle');
	let error = $state<string | null>(null);
	let lastRefreshAt = $state<number | null>(null);

	// Derived: is the app initialized?
	let isInitialized = $derived(phase === 'ready' || phase === 'refreshing');
	let isHydrating = $derived(phase === 'hydrating');
	let isRefreshing = $derived(phase === 'refreshing');
	let hasError = $derived(phase === 'error');

	/**
	 * Initialize the app with cache-first loading
	 *
	 * Phase 1 (Hydrate): Load from IndexedDB for instant display
	 * Phase 2 (Refresh): Sync with backend in background
	 */
	async function initialize(): Promise<void> {
		if (phase !== 'idle') return;

		phase = 'hydrating';
		error = null;

		try {
			// Phase 1: Hydrate from cache (parallel)
			await Promise.all([
				liveDb.loadSubscriptions(),
				liveDb.loadArticles(),
				readingStore.load(),
				shareReadingStore.load(),
				sharesStore.load(),
			]);

			// Initialize feed statuses for existing subscriptions
			const feedUrls = liveDb.subscriptions.map((s) => s.feedUrl);
			feedStatusStore.initializeFeeds(feedUrls);

			// Phase 2: Refresh from backend (background)
			phase = 'refreshing';

			await refreshFromBackend();

			phase = 'ready';
			lastRefreshAt = Date.now();
		} catch (e) {
			console.error('App initialization failed:', e);
			error = e instanceof Error ? e.message : 'Initialization failed';
			phase = 'error';
		}
	}

	/**
	 * Refresh data from backend
	 *
	 * - Syncs subscriptions from PDS
	 * - Fetches feed content via V2 batch API
	 * - Loads social feed
	 */
	async function refreshFromBackend(): Promise<void> {
		const wasPhase = phase;
		if (phase === 'idle') {
			phase = 'refreshing';
		}

		try {
			// Sync subscriptions and fetch feeds in parallel
			const [syncResult] = await Promise.all([
				syncSubscriptions(),
				socialStore.loadFollowedUsers(),
				socialStore.loadFeed(true),
			]);

			// Fetch feeds for existing subscriptions
			const existingSubs = liveDb.subscriptions.filter(
				(s) => !syncResult.added.includes(s.feedUrl)
			);
			if (existingSubs.length > 0) {
				await fetchAllFeeds(existingSubs, articlesStore.starredGuids);
			}

			// Fetch newly added subscriptions (they need full content)
			if (syncResult.addedSubs.length > 0) {
				await fetchNewSubscriptionFeeds(syncResult.addedSubs, articlesStore.starredGuids);
			}

			lastRefreshAt = Date.now();
		} catch (e) {
			console.error('Background refresh failed:', e);
			// Don't set error phase for background refresh failures
			// The app can still work with cached data
		} finally {
			if (wasPhase === 'idle') {
				phase = 'ready';
			}
		}
	}

	/**
	 * Sync subscriptions from backend PDS
	 *
	 * Returns lists of added and removed feed URLs for follow-up actions
	 */
	async function syncSubscriptions(): Promise<{
		added: string[];
		removed: string[];
		addedSubs: Subscription[];
	}> {
		const result = {
			added: [] as string[],
			removed: [] as string[],
			addedSubs: [] as Subscription[],
		};

		try {
			const response = await api.listRecords<{
				feedUrl: string;
				title?: string;
				siteUrl?: string;
				category?: string;
				tags?: string[];
				createdAt: string;
				updatedAt?: string;
			}>('app.skyreader.feed.subscription');

			// Build maps for comparison
			const localByRkey = new Map(liveDb.subscriptions.map((s) => [s.rkey, s]));
			const remoteByRkey = new Map(response.records.map((r) => [r.uri.split('/').pop() || '', r]));

			// Find added subscriptions (in remote but not local)
			for (const [rkey, record] of remoteByRkey) {
				if (!localByRkey.has(rkey)) {
					const subscription: Subscription = {
						rkey,
						feedUrl: record.value.feedUrl,
						title: record.value.title || record.value.feedUrl,
						siteUrl: record.value.siteUrl,
						category: record.value.category,
						tags: record.value.tags || [],
						createdAt: record.value.createdAt,
						updatedAt: record.value.updatedAt,
						localUpdatedAt: Date.now(),
						fetchStatus: 'pending',
					};

					const id = await liveDb.addSubscription(subscription);
					result.added.push(subscription.feedUrl);
					result.addedSubs.push({ ...subscription, id });
					feedStatusStore.markPending(subscription.feedUrl);
				}
			}

			// Find removed subscriptions (in local but not remote)
			for (const [rkey, sub] of localByRkey) {
				if (!remoteByRkey.has(rkey)) {
					if (sub.id) {
						await liveDb.deleteSubscription(sub.id);
					}
					result.removed.push(sub.feedUrl);
					feedStatusStore.clearStatus(sub.feedUrl);
				}
			}

			// Update existing subscriptions with any remote changes
			for (const [rkey, record] of remoteByRkey) {
				const local = localByRkey.get(rkey);
				if (local?.id) {
					// Check if anything changed
					const hasChanges =
						local.title !== (record.value.title || record.value.feedUrl) ||
						local.siteUrl !== record.value.siteUrl ||
						local.category !== record.value.category;

					if (hasChanges) {
						await liveDb.updateSubscription(local.id, {
							title: record.value.title || record.value.feedUrl,
							siteUrl: record.value.siteUrl,
							category: record.value.category,
							tags: record.value.tags || [],
							updatedAt: record.value.updatedAt,
							localUpdatedAt: Date.now(),
						});
					}
				}
			}

			return result;
		} catch (e) {
			console.error('Failed to sync subscriptions:', e);
			return result;
		}
	}

	/**
	 * Force refresh all feeds (bypass cache)
	 */
	async function forceRefresh(): Promise<void> {
		phase = 'refreshing';

		try {
			const { forceRefreshAllFeeds } = await import('$lib/services/feedFetcher');
			await forceRefreshAllFeeds(liveDb.subscriptions, articlesStore.starredGuids);
			lastRefreshAt = Date.now();
		} catch (e) {
			console.error('Force refresh failed:', e);
		} finally {
			phase = 'ready';
		}
	}

	/**
	 * Reset app state (for logout)
	 */
	async function reset(): Promise<void> {
		phase = 'idle';
		error = null;
		lastRefreshAt = null;
		feedStatusStore.clearAll();
		articlesStore.resetPagination();
	}

	/**
	 * Check if a refresh is needed (stale data)
	 */
	function isStale(thresholdMs: number = 5 * 60 * 1000): boolean {
		if (!lastRefreshAt) return true;
		return Date.now() - lastRefreshAt > thresholdMs;
	}

	return {
		// State
		get phase() {
			return phase;
		},
		get error() {
			return error;
		},
		get lastRefreshAt() {
			return lastRefreshAt;
		},

		// Derived
		get isInitialized() {
			return isInitialized;
		},
		get isHydrating() {
			return isHydrating;
		},
		get isRefreshing() {
			return isRefreshing;
		},
		get hasError() {
			return hasError;
		},

		// Actions
		initialize,
		refreshFromBackend,
		syncSubscriptions,
		forceRefresh,
		reset,
		isStale,
	};
}

export const appManager = createAppManager();
