import { liveDb } from '$lib/services/liveDb.svelte';
import { readingStore } from './reading.svelte';
import type { Article } from '$lib/types';

const DEFAULT_PAGE_SIZE = 50;

/**
 * Articles Store - Provides reactive article queries and pagination
 *
 * Built on top of liveDb, provides filtering, pagination, and derived views.
 * All data is reactive via Svelte 5 runes.
 */
function createArticlesStore() {
	// Pagination state
	let pageSize = $state(DEFAULT_PAGE_SIZE);
	let loadedCount = $state(0);

	// Derived: all articles sorted by date (uses liveDb's articlesVersion for reactivity)
	let allArticles = $derived.by(() => {
		// Access version to trigger reactivity
		const _version = liveDb.articlesVersion;
		return liveDb.articles;
	});

	// Derived: article lookup by guid
	let articlesByGuid = $derived(new Map(allArticles.map((a) => [a.guid, a])));

	// Derived: articles by subscription
	let articlesBySubscription = $derived.by(() => {
		const bySubId = new Map<number, Article[]>();
		for (const article of allArticles) {
			const existing = bySubId.get(article.subscriptionId) || [];
			existing.push(article);
			bySubId.set(article.subscriptionId, existing);
		}
		return bySubId;
	});

	// Derived: unread articles (excluding those in readPositions)
	let unreadArticles = $derived.by(() => {
		const positions = readingStore.readPositions;
		return allArticles.filter((a) => !positions.has(a.guid));
	});

	// Derived: starred articles
	let starredArticles = $derived.by(() => {
		const positions = readingStore.readPositions;
		return allArticles.filter((a) => positions.get(a.guid)?.starred === true);
	});

	// Derived: set of starred GUIDs (useful for article retention)
	let starredGuids = $derived.by(() => {
		const positions = readingStore.readPositions;
		const starred = new Set<string>();
		for (const [guid, pos] of positions) {
			if (pos.starred) starred.add(guid);
		}
		return starred;
	});

	/**
	 * Get articles for a specific subscription
	 */
	function getForSubscription(subscriptionId: number): Article[] {
		return articlesBySubscription.get(subscriptionId) || [];
	}

	/**
	 * Get unread articles for a specific subscription
	 */
	function getUnreadForSubscription(subscriptionId: number): Article[] {
		const positions = readingStore.readPositions;
		const subArticles = getForSubscription(subscriptionId);
		return subArticles.filter((a) => !positions.has(a.guid));
	}

	/**
	 * Get unread count for a subscription
	 */
	function getUnreadCount(subscriptionId: number): number {
		return getUnreadForSubscription(subscriptionId).length;
	}

	/**
	 * Get total unread count across all subscriptions
	 */
	function getTotalUnreadCount(): number {
		return unreadArticles.length;
	}

	/**
	 * Get paginated articles (for initial load and infinite scroll)
	 *
	 * @param subscriptionId - Filter by subscription (optional)
	 * @param showOnlyUnread - Filter to unread articles only
	 * @param showOnlyStarred - Filter to starred articles only
	 * @param count - Number of articles to return
	 */
	function getPaginated(options: {
		subscriptionId?: number;
		showOnlyUnread?: boolean;
		showOnlyStarred?: boolean;
		count?: number;
	}): Article[] {
		const { subscriptionId, showOnlyUnread, showOnlyStarred, count = pageSize } = options;
		const positions = readingStore.readPositions;

		let filtered: Article[];

		// Start with base filter
		if (subscriptionId !== undefined) {
			filtered = getForSubscription(subscriptionId);
		} else {
			filtered = allArticles;
		}

		// Apply starred filter
		if (showOnlyStarred) {
			filtered = filtered.filter((a) => positions.get(a.guid)?.starred === true);
		}
		// Apply unread filter (mutually exclusive with starred for now)
		else if (showOnlyUnread) {
			filtered = filtered.filter((a) => !positions.has(a.guid));
		}

		// Return first N articles
		return filtered.slice(0, count);
	}

	/**
	 * Load more articles (for infinite scroll)
	 * Increases loadedCount and returns the next batch
	 */
	function loadMore(options: {
		subscriptionId?: number;
		showOnlyUnread?: boolean;
		showOnlyStarred?: boolean;
	}): Article[] {
		const newCount = loadedCount + pageSize;
		loadedCount = newCount;

		return getPaginated({
			...options,
			count: newCount,
		});
	}

	/**
	 * Reset pagination state
	 */
	function resetPagination(): void {
		loadedCount = pageSize;
	}

	/**
	 * Check if there are more articles to load
	 */
	function hasMore(options: {
		subscriptionId?: number;
		showOnlyUnread?: boolean;
		showOnlyStarred?: boolean;
	}): boolean {
		const { subscriptionId, showOnlyUnread, showOnlyStarred } = options;
		const positions = readingStore.readPositions;

		let total: number;

		if (subscriptionId !== undefined) {
			const subArticles = getForSubscription(subscriptionId);
			if (showOnlyStarred) {
				total = subArticles.filter((a) => positions.get(a.guid)?.starred === true).length;
			} else if (showOnlyUnread) {
				total = subArticles.filter((a) => !positions.has(a.guid)).length;
			} else {
				total = subArticles.length;
			}
		} else if (showOnlyStarred) {
			total = starredArticles.length;
		} else if (showOnlyUnread) {
			total = unreadArticles.length;
		} else {
			total = allArticles.length;
		}

		return loadedCount < total;
	}

	/**
	 * Get an article by GUID
	 */
	function getByGuid(guid: string): Article | undefined {
		return articlesByGuid.get(guid);
	}

	/**
	 * Get multiple articles by GUIDs
	 */
	function getByGuids(guids: string[]): Article[] {
		const result: Article[] = [];
		for (const guid of guids) {
			const article = articlesByGuid.get(guid);
			if (article) result.push(article);
		}
		return result;
	}

	/**
	 * Set the page size for pagination
	 */
	function setPageSize(size: number): void {
		pageSize = size;
	}

	return {
		// Reactive state
		get allArticles() {
			return allArticles;
		},
		get unreadArticles() {
			return unreadArticles;
		},
		get starredArticles() {
			return starredArticles;
		},
		get starredGuids() {
			return starredGuids;
		},
		get loadedCount() {
			return loadedCount;
		},
		get pageSize() {
			return pageSize;
		},

		// Lookups
		articlesByGuid,
		articlesBySubscription,

		// Methods
		getForSubscription,
		getUnreadForSubscription,
		getUnreadCount,
		getTotalUnreadCount,
		getPaginated,
		loadMore,
		resetPagination,
		hasMore,
		getByGuid,
		getByGuids,
		setPageSize,
	};
}

export const articlesStore = createArticlesStore();
