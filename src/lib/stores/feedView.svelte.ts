import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import { readingStore } from './reading.svelte';
import { shareReadingStore } from './shareReading.svelte';
import { sharesStore } from './shares.svelte';
import { socialStore } from './social.svelte';
import { preferences } from './preferences.svelte';
import type { Article, SocialShare, SocialDocument, CombinedFeedItem, UserShare } from '$lib/types';

export type ViewMode = 'articles' | 'shares' | 'userShares' | 'combined';

/**
 * Unified feed item type for rendering - wraps all item types with common metadata
 */
export type FeedDisplayItem =
	| { type: 'article'; item: Article; key: string }
	| { type: 'share'; item: SocialShare; key: string }
	| { type: 'userShare'; item: UserShare; article: Article; key: string }
	| { type: 'document'; item: SocialDocument; key: string };

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

	// URL filters (set by component from $page store)
	let feedFilter = $state<string | null>(null);
	let starredFilter = $state<string | null>(null);
	let sharedFilter = $state<string | null>(null);
	let sharerFilter = $state<string | null>(null);
	let followingFilter = $state<string | null>(null);
	let feedsFilter = $state<string | null>(null);
	let contentTypeFilter = $state<'shares' | 'documents' | null>(null);

	// Derived: view mode
	let viewMode = $derived.by((): ViewMode => {
		if (sharedFilter) return 'userShares';
		if (sharerFilter || followingFilter) return 'shares';
		if (feedFilter || starredFilter || feedsFilter) return 'articles';
		return 'combined';
	});

	// Track items that were read during this view session to keep them visible
	// These are cleared when switching views/feeds
	let readArticleGuidsThisSession = $state<Set<string>>(new Set());
	let readShareUrisThisSession = $state<Set<string>>(new Set());

	// Derived: filtered articles based on current filters
	let filteredArticles = $derived.by((): Article[] => {
		// Access articlesStore version for reactivity
		const allArticles = articlesStore.allArticles;
		const positions = readingStore.readPositions;
		const sortOrder = preferences.sortOrder;

		let articles: Article[];

		if (starredFilter) {
			// Starred view
			articles = allArticles.filter((a) => positions.get(a.guid)?.starred === true);
		} else {
			articles = allArticles;

			// Filter by subscription
			if (feedFilter) {
				const feedId = parseInt(feedFilter);
				articles = articles.filter((a) => a.subscriptionId === feedId);
			}

			// Filter to unread only, but keep articles read this session visible
			if (showOnlyUnread) {
				articles = articles.filter(
					(a) => !positions.has(a.guid) || readArticleGuidsThisSession.has(a.guid)
				);
			}
		}

		// Deduplicate by GUID
		const seen = new Set<string>();
		articles = articles.filter((a) => {
			if (seen.has(a.guid)) return false;
			seen.add(a.guid);
			return true;
		});

		// Apply sort order (articles come from liveDb sorted newest first)
		if (sortOrder === 'oldest') {
			articles = [...articles].reverse();
		}

		return articles;
	});

	// Derived: paginated articles (limited to loadedArticleCount)
	let displayedArticles = $derived(filteredArticles.slice(0, loadedArticleCount));

	// Derived: filtered shares
	let displayedShares = $derived.by((): SocialShare[] => {
		// Return empty if contentTypeFilter is 'documents'
		if (contentTypeFilter === 'documents') return [];

		const shares = socialStore.shares;
		const positions = shareReadingStore.shareReadPositions;
		const sortOrder = preferences.sortOrder;

		let filtered: SocialShare[];
		if (sharerFilter) {
			filtered = shares.filter((s) => s.authorDid === sharerFilter);
		} else {
			filtered = [...shares];
		}

		// Filter to unread only, but keep shares read this session visible
		if (showOnlyUnread) {
			filtered = filtered.filter(
				(s) => !positions.has(s.recordUri) || readShareUrisThisSession.has(s.recordUri)
			);
		}

		// Apply sort order
		filtered.sort((a, b) => {
			const dateA = new Date(a.itemPublishedAt || a.createdAt).getTime();
			const dateB = new Date(b.itemPublishedAt || b.createdAt).getTime();
			return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
		});

		return filtered;
	});

	// Derived: user's own shares
	let displayedUserShares = $derived.by((): UserShare[] => {
		if (!sharedFilter) return [];

		const sortOrder = preferences.sortOrder;
		const shares = Array.from(sharesStore.userShares.values());
		shares.sort((a, b) => {
			const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
			return sortOrder === 'newest' ? diff : -diff;
		});
		return shares;
	});

	// Derived: filtered documents
	let displayedDocuments = $derived.by((): SocialDocument[] => {
		// Return empty if contentTypeFilter is 'shares'
		if (contentTypeFilter === 'shares') return [];

		const docs = socialStore.documents;
		const sortOrder = preferences.sortOrder;

		let filtered = [...docs];

		// Filter by author if sharerFilter is set
		if (sharerFilter) {
			filtered = filtered.filter((d) => d.authorDid === sharerFilter);
		}

		// Apply sort order
		filtered.sort((a, b) => {
			const dateA = new Date(a.publishedAt).getTime();
			const dateB = new Date(b.publishedAt).getTime();
			return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
		});

		return filtered;
	});

	// Derived: combined view (articles + shares + documents merged by date)
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
			...displayedDocuments.map((item) => ({
				type: 'document' as const,
				item,
				date: item.publishedAt,
			})),
		];

		const sortOrder = preferences.sortOrder;
		combined.sort((a, b) => {
			const diff = new Date(b.date).getTime() - new Date(a.date).getTime();
			return sortOrder === 'newest' ? diff : -diff;
		});
		return combined;
	});

	// Derived: article lookup by guid
	let articlesByGuid = $derived(articlesStore.articlesByGuid);

	// Derived: unified current items for the active view mode
	let currentItems = $derived.by((): FeedDisplayItem[] => {
		const mode = viewMode;

		if (mode === 'combined') {
			return displayedCombined.map((item) => {
				if (item.type === 'article') {
					return { type: 'article' as const, item: item.item, key: item.item.guid };
				} else if (item.type === 'share') {
					return { type: 'share' as const, item: item.item, key: item.item.recordUri };
				} else {
					return { type: 'document' as const, item: item.item, key: item.item.recordUri };
				}
			});
		}

		if (mode === 'shares') {
			// Combine shares and documents, sorted by date
			const sortOrder = preferences.sortOrder;
			type ItemWithDate = FeedDisplayItem & { date: number };
			const items: ItemWithDate[] = [
				...displayedShares.map((item) => ({
					type: 'share' as const,
					item,
					key: item.recordUri,
					date: new Date(item.itemPublishedAt || item.createdAt).getTime(),
				})),
				...displayedDocuments.map((item) => ({
					type: 'document' as const,
					item,
					key: item.recordUri,
					date: new Date(item.publishedAt).getTime(),
				})),
			];

			items.sort((a, b) => {
				const diff = b.date - a.date;
				return sortOrder === 'newest' ? diff : -diff;
			});

			return items.map(({ type, item, key }) => ({ type, item, key }) as FeedDisplayItem);
		}

		if (mode === 'userShares') {
			return displayedUserShares.map((share) => {
				const localArticle = articlesByGuid.get(share.articleGuid);
				const article: Article = localArticle || {
					guid: share.articleGuid,
					url: share.articleUrl,
					title: share.articleTitle || share.articleUrl,
					author: share.articleAuthor,
					content: share.articleContent,
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

	function select(index: number) {
		if (index === selectedIndex) return;

		const items = currentItems;
		const item = items[index];
		if (!item) return;

		// Set selectedIndex first
		selectedIndex = index;
		expandedIndex = -1;

		// Track the item to keep it visible in unread filter for this session
		if (item.type === 'article') {
			readArticleGuidsThisSession.add(item.item.guid);
			readArticleGuidsThisSession = new Set(readArticleGuidsThisSession);
		} else if (item.type === 'share') {
			readShareUrisThisSession.add(item.item.recordUri);
			readShareUrisThisSession = new Set(readShareUrisThisSession);
		}

		// Mark as read when selecting (after updating selection state)
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
	}

	function deselect() {
		selectedIndex = -1;
		expandedIndex = -1;
		// Don't clear session sets - items should stay visible until view changes
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
		// Clear session sets when switching views/feeds
		readArticleGuidsThisSession = new Set();
		readShareUrisThisSession = new Set();
	}

	function toggleUnreadFilter() {
		showOnlyUnread = !showOnlyUnread;
	}

	// Track an item as "seen this session" so it stays visible after being marked read
	function trackSeenThisSession(item: FeedDisplayItem) {
		if (item.type === 'article') {
			readArticleGuidsThisSession.add(item.item.guid);
			readArticleGuidsThisSession = new Set(readArticleGuidsThisSession);
		} else if (item.type === 'share') {
			readShareUrisThisSession.add(item.item.recordUri);
			readShareUrisThisSession = new Set(readShareUrisThisSession);
		}
	}

	function getArticleForShare(share: SocialShare): Article | undefined {
		if (!share.itemGuid) return undefined;
		return articlesByGuid.get(share.itemGuid);
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
		get contentTypeFilter() {
			return contentTypeFilter;
		},

		// Article lookup
		getArticleForShare,

		// Actions
		loadArticles,
		loadMore,
		select,
		deselect,
		expand,
		collapse,
		resetSelection,
		toggleUnreadFilter,
		trackSeenThisSession,
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
			contentType?: 'shares' | 'documents' | null;
		}) {
			feedFilter = filters.feed;
			starredFilter = filters.starred;
			sharedFilter = filters.shared;
			sharerFilter = filters.sharer;
			followingFilter = filters.following;
			feedsFilter = filters.feeds;
			contentTypeFilter = filters.contentType ?? null;
			// Reset pagination when filters change
			loadedArticleCount = DEFAULT_PAGE_SIZE;
		},
	};
}

export const feedViewStore = createFeedViewStore();
