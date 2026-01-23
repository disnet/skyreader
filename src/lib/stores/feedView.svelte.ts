import { untrack } from 'svelte';
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

function createFeedViewStore() {
	// Source data
	let allArticles = $state<Article[]>([]);

	// UI state
	let showOnlyUnread = $state(true);
	let selectedIndex = $state(-1);
	let expandedIndex = $state(-1);

	// Cache for fetched articles (from backend, for shares not in local DB)
	let fetchedArticles = $state<Map<string, FeedItem>>(new Map());
	let fetchingArticles = $state<Set<string>>(new Set());

	// Snapshot tracking
	let lastFilterKey = $state('');
	let lastSharesFilterKey = $state('');
	let lastArticlesVersion = $state(-1);
	let lastArticlesLength = $state(-1);
	let lastSharesLength = $state(-1);

	// Snapshots of displayed items
	let displayedArticles = $state<Article[]>([]);
	let displayedShares = $state<SocialShare[]>([]);
	let displayedUserShares = $state<UserShare[]>([]);
	let displayedCombined = $state<CombinedFeedItem[]>([]);

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

	// Derived: filter key for snapshot detection
	let filterKey = $derived(
		`${feedFilter || ''}-${starredFilter || ''}-${sharedFilter || ''}-${sharerFilter || ''}-${followingFilter || ''}-${feedsFilter || ''}-${showOnlyUnread}`
	);

	// Derived: article lookup by guid
	let articlesByGuid = $derived(new Map(allArticles.map((a) => [a.guid, a])));

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

		// articles
		return displayedArticles.map((item) => ({
			type: 'article' as const,
			item,
			key: item.guid,
		}));
	});

	// Derived: unified pagination state
	let hasMore = $derived.by(() => {
		const mode = viewMode;
		if (mode === 'combined') return subscriptionsStore.articlesHasMore || socialStore.hasMore;
		if (mode === 'shares') return socialStore.hasMore;
		if (mode === 'userShares') return false;
		return subscriptionsStore.articlesHasMore;
	});

	let isLoadingMore = $derived.by(() => {
		const mode = viewMode;
		if (mode === 'combined')
			return subscriptionsStore.articlesIsLoadingMore || socialStore.isLoading;
		if (mode === 'shares') return socialStore.isLoading;
		if (mode === 'userShares') return false;
		return subscriptionsStore.articlesIsLoadingMore;
	});

	// Snapshot articles when filter or source data changes
	function updateArticlesSnapshot() {
		const currentKey = filterKey;
		const currentVersion = subscriptionsStore.articlesVersion;
		const currentArticles = allArticles;
		const currentLength = currentArticles.length;
		const currentReadPositions = starredFilter ? readingStore.readPositions : null;

		const prevKey = untrack(() => lastFilterKey);
		const prevVersion = untrack(() => lastArticlesVersion);
		const prevLength = untrack(() => lastArticlesLength);

		if (
			currentKey !== prevKey ||
			currentVersion !== prevVersion ||
			currentLength !== prevLength ||
			currentReadPositions
		) {
			const readPositions = starredFilter
				? currentReadPositions!
				: untrack(() => readingStore.readPositions);

			let filtered: Article[];
			if (feedFilter) {
				const feedId = parseInt(feedFilter);
				let feedArticles = currentArticles.filter((a) => a.subscriptionId === feedId);
				const onlyUnread = untrack(() => showOnlyUnread);
				if (onlyUnread) {
					feedArticles = feedArticles.filter((a) => !readPositions.has(a.guid));
				}
				filtered = feedArticles;
			} else if (starredFilter) {
				filtered = currentArticles.filter((a) => readPositions.get(a.guid)?.starred ?? false);
			} else {
				const onlyUnread = untrack(() => showOnlyUnread);
				if (onlyUnread) {
					filtered = currentArticles.filter((a) => !readPositions.has(a.guid));
				} else {
					filtered = [...currentArticles];
				}
			}

			const seen = new Set<string>();
			const deduped = filtered.filter((a) => {
				if (seen.has(a.guid)) return false;
				seen.add(a.guid);
				return true;
			});

			displayedArticles = deduped;
			lastFilterKey = currentKey;
			lastArticlesVersion = currentVersion;
			lastArticlesLength = currentLength;
		}
	}

	// Snapshot shares when filter or source data changes
	function updateSharesSnapshot() {
		const shares = socialStore.shares;
		const currentKey = filterKey;

		const prevKey = untrack(() => lastSharesFilterKey);
		const prevLength = untrack(() => lastSharesLength);

		if (currentKey !== prevKey || shares.length !== prevLength) {
			let filtered: SocialShare[];
			if (followingFilter) {
				filtered = [...shares];
			} else if (sharerFilter) {
				filtered = shares.filter((s) => s.authorDid === sharerFilter);
			} else {
				filtered = [...shares];
			}

			const onlyUnread = untrack(() => showOnlyUnread);
			const readPositions = untrack(() => shareReadingStore.shareReadPositions);
			if (onlyUnread && (followingFilter || sharerFilter)) {
				filtered = filtered.filter((s) => !readPositions.has(s.recordUri));
			}

			displayedShares = filtered;
			lastSharesFilterKey = currentKey;
			lastSharesLength = shares.length;
		}
	}

	// Snapshot user's own shares
	function updateUserSharesSnapshot() {
		const userShares = sharesStore.userShares;

		if (sharedFilter) {
			const shares = Array.from(userShares.values());
			shares.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
			displayedUserShares = shares;
		} else {
			displayedUserShares = [];
		}
	}

	// Combine articles and shares for "all" view
	function updateCombinedSnapshot() {
		const articles = displayedArticles;
		const shares = displayedShares;
		const mode = viewMode;

		if (mode === 'combined') {
			const combined: CombinedFeedItem[] = [
				...articles.map((item) => ({
					type: 'article' as const,
					item,
					date: item.publishedAt,
				})),
				...shares.map((item) => ({
					type: 'share' as const,
					item,
					date: item.itemPublishedAt || item.createdAt,
				})),
			];
			combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
			displayedCombined = combined;
		} else {
			displayedCombined = [];
		}
	}

	// Actions
	async function loadArticles() {
		allArticles = [];

		if (starredFilter) {
			const starredGuids = Array.from(readingStore.readPositions.entries())
				.filter(([, pos]) => pos.starred)
				.map(([guid]) => guid);
			const articles = await subscriptionsStore.getArticlesByGuids(starredGuids);
			allArticles = articles;
			return;
		}

		subscriptionsStore.resetArticlesPagination();
		const feedId = feedFilter ? parseInt(feedFilter) : undefined;
		const targetCount = 50;
		const maxIterations = 10;

		let articles = await subscriptionsStore.getArticlesPaginated(feedId);

		if (showOnlyUnread && !starredFilter) {
			let iterations = 0;
			while (subscriptionsStore.articlesHasMore && iterations < maxIterations) {
				const unreadCount = articles.filter((a) => !readingStore.isRead(a.guid)).length;

				if (unreadCount >= targetCount) {
					break;
				}

				const moreArticles = await subscriptionsStore.loadMoreArticles(feedId);
				if (moreArticles.length === 0) {
					break;
				}

				articles = [...articles, ...moreArticles];
				iterations++;
			}
		}

		allArticles = articles;
	}

	async function loadMore() {
		const mode = viewMode;

		if (mode === 'combined') {
			const [, newArticles] = await Promise.all([
				socialStore.hasMore ? socialStore.loadFeed(false) : Promise.resolve(),
				subscriptionsStore.articlesHasMore
					? subscriptionsStore.loadMoreArticles()
					: Promise.resolve([]),
			]);
			if (newArticles && newArticles.length > 0) {
				allArticles = [...allArticles, ...newArticles];
			}
		} else if (mode === 'shares') {
			await socialStore.loadFeed(false);
		} else if (mode === 'articles') {
			const feedId = feedFilter ? parseInt(feedFilter) : undefined;
			const newArticles = await subscriptionsStore.loadMoreArticles(feedId);
			if (newArticles.length > 0) {
				allArticles = [...allArticles, ...newArticles];
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

		// Snapshot updates (call from $effect in page)
		updateArticlesSnapshot,
		updateSharesSnapshot,
		updateUserSharesSnapshot,
		updateCombinedSnapshot,

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
		},
	};
}

export const feedViewStore = createFeedViewStore();
