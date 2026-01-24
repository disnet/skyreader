import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import { readingStore } from './reading.svelte';
import { shareReadingStore } from './shareReading.svelte';
import { sharesStore } from './shares.svelte';
import { socialStore } from './social.svelte';
import { api } from '$lib/services/api';
import type { Article, FeedItem, SocialShare, CombinedFeedItem, UserShare } from '$lib/types';

export type ViewMode = 'articles' | 'shares' | 'userShares' | 'combined';

/**
 * Unified feed item type for rendering - wraps all item types with common metadata
 */
export type FeedDisplayItem =
	| { type: 'article'; item: Article; key: string }
	| { type: 'share'; item: SocialShare; key: string }
	| { type: 'userShare'; item: UserShare; article: Article; key: string };

const DEFAULT_PAGE_SIZE = 50;

/**
 * Feed View Store - Manages the unified feed view display
 *
 * Simplified to use articlesStore for article data.
 * Focuses on filtering, view mode, and display logic.
 */
function createFeedViewStore() {
	// UI state
	let showOnlyUnread = $state(true);
	let selectedIndex = $state(-1);
	let expandedIndex = $state(-1);
	let loadedArticleCount = $state(DEFAULT_PAGE_SIZE);

	// Cache for fetched articles (from backend, for shares not in local DB)
	let fetchedArticles = $state<Map<string, FeedItem>>(new Map());
	let fetchingArticles = $state<Set<string>>(new Set());

	// URL filters (set by component from $page store)
	let feedFilter = $state<string | null>(null);
	let starredFilter = $state<string | null>(null);
	let sharedFilter = $state<string | null>(null);
	let sharerFilter = $state<string | null>(null);
	let followingFilter = $state<string | null>(null);
	let feedsFilter = $state<string | null>(null);

	// Derived: view mode
	let viewMode = $derived.by((): ViewMode => {
		if (sharedFilter) return 'userShares';
		if (sharerFilter || followingFilter) return 'shares';
		if (feedFilter || starredFilter || feedsFilter) return 'articles';
		return 'combined';
	});

	// Derived: filtered articles based on current filters
	let filteredArticles = $derived.by((): Article[] => {
		// Access articlesStore version for reactivity
		const allArticles = articlesStore.allArticles;
		const positions = readingStore.readPositions;

		if (starredFilter) {
			// Starred view
			return allArticles.filter((a) => positions.get(a.guid)?.starred === true);
		}

		let articles = allArticles;

		// Filter by subscription
		if (feedFilter) {
			const feedId = parseInt(feedFilter);
			articles = articles.filter((a) => a.subscriptionId === feedId);
		}

		// Filter to unread only
		if (showOnlyUnread) {
			articles = articles.filter((a) => !positions.has(a.guid));
		}

		// Deduplicate by GUID
		const seen = new Set<string>();
		return articles.filter((a) => {
			if (seen.has(a.guid)) return false;
			seen.add(a.guid);
			return true;
		});
	});

	// Derived: paginated articles (limited to loadedArticleCount)
	let displayedArticles = $derived(filteredArticles.slice(0, loadedArticleCount));

	// Derived: filtered shares
	let displayedShares = $derived.by((): SocialShare[] => {
		const shares = socialStore.shares;
		const positions = shareReadingStore.shareReadPositions;

		let filtered: SocialShare[];
		if (sharerFilter) {
			filtered = shares.filter((s) => s.authorDid === sharerFilter);
		} else {
			filtered = [...shares];
		}

		if (showOnlyUnread) {
			filtered = filtered.filter((s) => !positions.has(s.recordUri));
		}

		return filtered;
	});

	// Derived: user's own shares
	let displayedUserShares = $derived.by((): UserShare[] => {
		if (!sharedFilter) return [];

		const shares = Array.from(sharesStore.userShares.values());
		shares.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return shares;
	});

	// Derived: combined view (articles + shares merged by date)
	let displayedCombined = $derived.by((): CombinedFeedItem[] => {
		if (viewMode !== 'combined') return [];

		const combined: CombinedFeedItem[] = [
			...displayedArticles.map((item) => ({
				type: 'article' as const,
				item,
				date: item.publishedAt,
			})),
			...displayedShares.map((item) => ({
				type: 'share' as const,
				item,
				date: item.itemPublishedAt || item.createdAt,
			})),
		];

		combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
		return combined;
	});

	// Derived: article lookup by guid
	let articlesByGuid = $derived(articlesStore.articlesByGuid);

	// Derived: unified current items for the active view mode
	let currentItems = $derived.by((): FeedDisplayItem[] => {
		const mode = viewMode;

		if (mode === 'combined') {
			return displayedCombined.map((item) =>
				item.type === 'article'
					? { type: 'article' as const, item: item.item, key: item.item.guid }
					: { type: 'share' as const, item: item.item, key: item.item.recordUri }
			);
		}

		if (mode === 'shares') {
			return displayedShares.map((item) => ({
				type: 'share' as const,
				item,
				key: item.recordUri,
			}));
		}

		if (mode === 'userShares') {
			return displayedUserShares.map((share) => {
				const localArticle = articlesByGuid.get(share.articleGuid);
				const article: Article = localArticle || {
					guid: share.articleGuid,
					url: share.articleUrl,
					title: share.articleTitle || share.articleUrl,
					author: share.articleAuthor,
					summary: share.articleDescription,
					imageUrl: share.articleImage,
					publishedAt: share.articlePublishedAt || share.createdAt,
					subscriptionId: 0,
					fetchedAt: Date.now(),
				};
				return {
					type: 'userShare' as const,
					item: share,
					article,
					key: share.articleGuid,
				};
			});
		}

		// articles mode
		return displayedArticles.map((item) => ({
			type: 'article' as const,
			item,
			key: item.guid,
		}));
	});

	// Derived: unified pagination state
	let hasMore = $derived.by(() => {
		const mode = viewMode;
		if (mode === 'combined') {
			return loadedArticleCount < filteredArticles.length || socialStore.hasMore;
		}
		if (mode === 'shares') return socialStore.hasMore;
		if (mode === 'userShares') return false;
		return loadedArticleCount < filteredArticles.length;
	});

	let isLoadingMore = $derived.by(() => {
		const mode = viewMode;
		if (mode === 'combined') return socialStore.isLoading;
		if (mode === 'shares') return socialStore.isLoading;
		return false;
	});

	// Actions
	async function loadArticles() {
		// Reset pagination
		loadedArticleCount = DEFAULT_PAGE_SIZE;

		// For unread view, load more articles until we have enough unread ones
		if (showOnlyUnread && !starredFilter) {
			const targetCount = DEFAULT_PAGE_SIZE;
			const maxCount = DEFAULT_PAGE_SIZE * 10;

			while (loadedArticleCount < maxCount) {
				const unreadCount = displayedArticles.length;
				if (unreadCount >= targetCount || loadedArticleCount >= filteredArticles.length) {
					break;
				}
				loadedArticleCount += DEFAULT_PAGE_SIZE;
			}
		}
	}

	async function loadMore() {
		const mode = viewMode;

		if (mode === 'combined') {
			await Promise.all([
				socialStore.hasMore ? socialStore.loadFeed(false) : Promise.resolve(),
				Promise.resolve().then(() => {
					if (loadedArticleCount < filteredArticles.length) {
						loadedArticleCount += DEFAULT_PAGE_SIZE;
					}
				}),
			]);
		} else if (mode === 'shares') {
			await socialStore.loadFeed(false);
		} else if (mode === 'articles') {
			if (loadedArticleCount < filteredArticles.length) {
				loadedArticleCount += DEFAULT_PAGE_SIZE;
			}
		}
	}

	async function fetchArticleContent(feedUrl: string, guid: string, itemUrl?: string) {
		if (fetchedArticles.has(guid) || fetchingArticles.has(guid)) return;

		fetchingArticles.add(guid);
		fetchingArticles = new Set(fetchingArticles);

		try {
			const article = await api.fetchArticle(feedUrl, guid, itemUrl);
			if (article) {
				fetchedArticles.set(guid, article);
				fetchedArticles = new Map(fetchedArticles);
			}
		} catch (e) {
			console.error('Failed to fetch article:', e);
		} finally {
			fetchingArticles.delete(guid);
			fetchingArticles = new Set(fetchingArticles);
		}
	}

	function select(index: number) {
		if (index === selectedIndex) return;

		const items = currentItems;
		const item = items[index];
		if (!item) return;

		// Mark as read when selecting
		if (item.type === 'article') {
			const article = item.item;
			const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
			if (sub && !readingStore.isRead(article.guid)) {
				readingStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
			}
		} else if (item.type === 'share') {
			const share = item.item;
			if (!shareReadingStore.isRead(share.recordUri)) {
				shareReadingStore.markAsRead(
					share.recordUri,
					share.authorDid,
					share.itemUrl,
					share.itemTitle
				);
			}
		}
		// userShare items don't auto-mark as read

		selectedIndex = index;
		expandedIndex = -1;
	}

	function deselect() {
		selectedIndex = -1;
		expandedIndex = -1;
	}

	function expand(index: number) {
		expandedIndex = index;
	}

	function collapse() {
		expandedIndex = -1;
	}

	function resetSelection() {
		selectedIndex = -1;
		expandedIndex = -1;
	}

	function toggleUnreadFilter() {
		showOnlyUnread = !showOnlyUnread;
	}

	function getArticleForShare(share: SocialShare): Article | undefined {
		if (!share.itemGuid) return undefined;
		return articlesByGuid.get(share.itemGuid);
	}

	function getFetchedArticle(guid: string): FeedItem | undefined {
		return fetchedArticles.get(guid);
	}

	function isFetchingArticle(guid: string): boolean {
		return fetchingArticles.has(guid);
	}

	return {
		// State
		get viewMode() {
			return viewMode;
		},
		get currentItems() {
			return currentItems;
		},
		get selectedIndex() {
			return selectedIndex;
		},
		get expandedIndex() {
			return expandedIndex;
		},
		get showOnlyUnread() {
			return showOnlyUnread;
		},
		get hasMore() {
			return hasMore;
		},
		get isLoadingMore() {
			return isLoadingMore;
		},

		// Filters
		get feedFilter() {
			return feedFilter;
		},
		get starredFilter() {
			return starredFilter;
		},
		get sharedFilter() {
			return sharedFilter;
		},
		get sharerFilter() {
			return sharerFilter;
		},
		get followingFilter() {
			return followingFilter;
		},
		get feedsFilter() {
			return feedsFilter;
		},

		// Article lookup
		getArticleForShare,
		getFetchedArticle,
		isFetchingArticle,

		// Actions
		loadArticles,
		loadMore,
		fetchArticleContent,
		select,
		deselect,
		expand,
		collapse,
		resetSelection,
		toggleUnreadFilter,
		setShowOnlyUnread(value: boolean) {
			showOnlyUnread = value;
		},
		setFilters(filters: {
			feed: string | null;
			starred: string | null;
			shared: string | null;
			sharer: string | null;
			following: string | null;
			feeds: string | null;
		}) {
			feedFilter = filters.feed;
			starredFilter = filters.starred;
			sharedFilter = filters.shared;
			sharerFilter = filters.sharer;
			followingFilter = filters.following;
			feedsFilter = filters.feeds;
			// Reset pagination when filters change
			loadedArticleCount = DEFAULT_PAGE_SIZE;
		},
	};
}

export const feedViewStore = createFeedViewStore();
