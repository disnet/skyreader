import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import { readingStore } from './reading.svelte';
import { shareReadingStore } from './shareReading.svelte';
import { socialReadingStore } from './socialReading.svelte';
import { sharesStore } from './shares.svelte';
import { socialStore } from './social.svelte';
import { preferences } from './preferences.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
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

export interface EffectiveFilters {
	showArticles: boolean;
	showShares: boolean;
	showDocuments: boolean;
	feedMode: 'all' | 'include' | 'exclude';
	feedIds: number[];
	accountMode: 'all' | 'include' | 'exclude';
	accountDids: string[];
	readFilter: 'all' | 'unread' | 'read';
	sortOrder: 'newest' | 'oldest';
}

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

	// Toolbar filter state
	let filterToolbarOpen = $state(false);
	let toolbarShowArticles = $state(true);
	let toolbarShowShares = $state(true);
	let toolbarShowDocuments = $state(true);
	let toolbarFeedMode = $state<'all' | 'include' | 'exclude'>('all');
	let toolbarFeedIds = $state<number[]>([]);
	let toolbarAccountMode = $state<'all' | 'include' | 'exclude'>('all');
	let toolbarAccountDids = $state<string[]>([]);

	// URL filters (set by component from $page store)
	let feedFilter = $state<string | null>(null);
	let starredFilter = $state<string | null>(null);
	let sharedFilter = $state<string | null>(null);
	let sharerFilter = $state<string | null>(null);
	let followingFilter = $state<string | null>(null);
	let feedsFilter = $state<string | null>(null);
	let contentTypeFilter = $state<'shares' | 'documents' | null>(null);
	let viewFilter = $state<string | null>(null);

	// Derived: active filtered view (looked up from store)
	let activeFilteredView = $derived.by(() => {
		if (!viewFilter) return null;
		return filteredViewsStore.getById(parseInt(viewFilter)) ?? null;
	});

	// Derived: effective filters (prefer activeFilteredView for reactivity + persistence)
	let effectiveFilters = $derived.by((): EffectiveFilters => {
		if (activeFilteredView) {
			return {
				showArticles: activeFilteredView.showArticles,
				showShares: activeFilteredView.showShares,
				showDocuments: activeFilteredView.showDocuments,
				feedMode: activeFilteredView.feedMode,
				feedIds: activeFilteredView.feedIds,
				accountMode: activeFilteredView.accountMode,
				accountDids: activeFilteredView.accountDids,
				readFilter: activeFilteredView.readFilter,
				sortOrder: activeFilteredView.sortOrder,
			};
		}
		return {
			showArticles: toolbarShowArticles,
			showShares: toolbarShowShares,
			showDocuments: toolbarShowDocuments,
			feedMode: toolbarFeedMode,
			feedIds: toolbarFeedIds,
			accountMode: toolbarAccountMode,
			accountDids: toolbarAccountDids,
			readFilter: showOnlyUnread ? 'unread' : 'all',
			sortOrder: preferences.sortOrder,
		};
	});

	// Derived: whether any toolbar filter differs from defaults
	let hasActiveFilters = $derived.by(() => {
		if (activeFilteredView) return true;
		return (
			!toolbarShowArticles ||
			!toolbarShowShares ||
			!toolbarShowDocuments ||
			toolbarFeedMode !== 'all' ||
			toolbarAccountMode !== 'all'
		);
	});

	// Derived: view mode
	let viewMode = $derived.by((): ViewMode => {
		if (activeFilteredView) return 'combined';
		if (sharedFilter) return 'userShares';
		if (sharerFilter || followingFilter) return 'shares';
		if (feedFilter || starredFilter || feedsFilter) return 'articles';
		// If any content type is toggled off via toolbar, use combined mode
		if (!toolbarShowArticles || !toolbarShowShares || !toolbarShowDocuments) return 'combined';
		return 'combined';
	});

	// Track items that were read during this view session to keep them visible
	// These are cleared when switching views/feeds
	let readArticleGuidsThisSession = $state<Set<string>>(new Set());
	let readShareUrisThisSession = $state<Set<string>>(new Set());
	let readDocumentUrisThisSession = $state<Set<string>>(new Set());

	// Derived: filtered articles based on current filters
	let filteredArticles = $derived.by((): Article[] => {
		const fv = effectiveFilters;

		// If articles are disabled, return empty
		if (!fv.showArticles) return [];

		// Access articlesStore version for reactivity
		const allArticles = articlesStore.allArticles;
		const positions = readingStore.readPositions;
		const sortOrder = fv.sortOrder;

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

			// Apply feed inclusion/exclusion
			if (fv.feedMode !== 'all' && fv.feedIds.length > 0) {
				const feedIdSet = new Set(fv.feedIds);
				if (fv.feedMode === 'include') {
					articles = articles.filter((a) => feedIdSet.has(a.subscriptionId));
				} else {
					articles = articles.filter((a) => !feedIdSet.has(a.subscriptionId));
				}
			}

			// Apply read filter
			if (fv.readFilter === 'unread') {
				articles = articles.filter(
					(a) => !positions.has(a.guid) || readArticleGuidsThisSession.has(a.guid)
				);
			} else if (fv.readFilter === 'read') {
				articles = articles.filter((a) => positions.has(a.guid));
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
		const fv = effectiveFilters;

		// If shares are disabled, return empty
		if (!fv.showShares) return [];

		// Return empty if contentTypeFilter is 'documents'
		if (contentTypeFilter === 'documents') return [];

		const shares = socialStore.shares;
		const sortOrder = fv.sortOrder;

		let filtered: SocialShare[];
		if (sharerFilter) {
			filtered = shares.filter((s) => s.authorDid === sharerFilter);
		} else {
			filtered = [...shares];
		}

		// Apply account inclusion/exclusion
		if (fv.accountMode !== 'all' && fv.accountDids.length > 0) {
			const didSet = new Set(fv.accountDids);
			if (fv.accountMode === 'include') {
				filtered = filtered.filter((s) => didSet.has(s.authorDid));
			} else {
				filtered = filtered.filter((s) => !didSet.has(s.authorDid));
			}
		}

		// Apply read filter
		if (fv.readFilter === 'unread') {
			filtered = filtered.filter(
				(s) => !socialReadingStore.isRead(s.recordUri) || readShareUrisThisSession.has(s.recordUri)
			);
		} else if (fv.readFilter === 'read') {
			filtered = filtered.filter((s) => socialReadingStore.isRead(s.recordUri));
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
		const fv = effectiveFilters;

		// If documents are disabled, return empty
		if (!fv.showDocuments) return [];

		// Return empty if contentTypeFilter is 'shares'
		if (contentTypeFilter === 'shares') return [];

		const docs = socialStore.documents;
		const sortOrder = fv.sortOrder;

		let filtered = [...docs];

		// Filter by author if sharerFilter is set
		if (sharerFilter) {
			filtered = filtered.filter((d) => d.authorDid === sharerFilter);
		}

		// Apply account inclusion/exclusion
		if (fv.accountMode !== 'all' && fv.accountDids.length > 0) {
			const didSet = new Set(fv.accountDids);
			if (fv.accountMode === 'include') {
				filtered = filtered.filter((d) => didSet.has(d.authorDid));
			} else {
				filtered = filtered.filter((d) => !didSet.has(d.authorDid));
			}
		}

		// Apply read filter
		if (fv.readFilter === 'unread') {
			filtered = filtered.filter(
				(d) =>
					!socialReadingStore.isRead(d.recordUri) || readDocumentUrisThisSession.has(d.recordUri)
			);
		} else if (fv.readFilter === 'read') {
			filtered = filtered.filter((d) => socialReadingStore.isRead(d.recordUri));
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

		const fv = effectiveFilters;
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

		const sortOrder = fv.sortOrder;
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
		} else if (item.type === 'document') {
			readDocumentUrisThisSession.add(item.item.recordUri);
			readDocumentUrisThisSession = new Set(readDocumentUrisThisSession);
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
			if (!socialReadingStore.isRead(share.recordUri)) {
				socialReadingStore.markAsRead(
					'share',
					share.recordUri,
					share.authorDid,
					share.itemUrl,
					share.itemTitle
				);
			}
		} else if (item.type === 'document') {
			const doc = item.item;
			if (!socialReadingStore.isRead(doc.recordUri)) {
				socialReadingStore.markAsRead(
					'document',
					doc.recordUri,
					doc.authorDid,
					doc.canonicalUrl || '',
					doc.title
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
		readDocumentUrisThisSession = new Set();
	}

	function syncToolbarToSavedView() {
		if (!viewFilter) return;
		const id = parseInt(viewFilter);
		const fv = filteredViewsStore.getById(id);
		if (!fv) return;
		filteredViewsStore.update(id, {
			showArticles: toolbarShowArticles,
			showShares: toolbarShowShares,
			showDocuments: toolbarShowDocuments,
			feedMode: toolbarFeedMode,
			feedIds: [...toolbarFeedIds],
			accountMode: toolbarAccountMode,
			accountDids: [...toolbarAccountDids],
			readFilter: showOnlyUnread ? 'unread' : 'all',
			sortOrder: preferences.sortOrder,
		});
	}

	function resetToolbarFilters() {
		toolbarShowArticles = true;
		toolbarShowShares = true;
		toolbarShowDocuments = true;
		toolbarFeedMode = 'all';
		toolbarFeedIds = [];
		toolbarAccountMode = 'all';
		toolbarAccountDids = [];
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
		} else if (item.type === 'document') {
			readDocumentUrisThisSession.add(item.item.recordUri);
			readDocumentUrisThisSession = new Set(readDocumentUrisThisSession);
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
		get viewFilter() {
			return viewFilter;
		},
		get activeFilteredView() {
			return activeFilteredView;
		},
		get effectiveFilters() {
			return effectiveFilters;
		},
		get filterToolbarOpen() {
			return filterToolbarOpen;
		},
		get hasActiveFilters() {
			return hasActiveFilters;
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
			syncToolbarToSavedView();
		},
		setFilterToolbarOpen(open: boolean) {
			filterToolbarOpen = open;
		},
		setToolbarContentTypes(articles: boolean, shares: boolean, docs: boolean) {
			toolbarShowArticles = articles;
			toolbarShowShares = shares;
			toolbarShowDocuments = docs;
			syncToolbarToSavedView();
		},
		setToolbarFeedFilter(mode: 'all' | 'include' | 'exclude', feedIds: number[]) {
			toolbarFeedMode = mode;
			toolbarFeedIds = feedIds;
			syncToolbarToSavedView();
		},
		setToolbarAccountFilter(mode: 'all' | 'include' | 'exclude', dids: string[]) {
			toolbarAccountMode = mode;
			toolbarAccountDids = dids;
			syncToolbarToSavedView();
		},
		resetToolbarFilters,
		syncToolbarToSavedView,
		setFilters(filters: {
			feed: string | null;
			starred: string | null;
			shared: string | null;
			sharer: string | null;
			following: string | null;
			feeds: string | null;
			contentType?: 'shares' | 'documents' | null;
			view?: string | null;
		}) {
			feedFilter = filters.feed;
			starredFilter = filters.starred;
			sharedFilter = filters.shared;
			sharerFilter = filters.sharer;
			followingFilter = filters.following;
			feedsFilter = filters.feeds;
			contentTypeFilter = filters.contentType ?? null;
			viewFilter = filters.view ?? null;
			// Reset pagination when filters change
			loadedArticleCount = DEFAULT_PAGE_SIZE;
			// Populate toolbar from saved view, or reset to defaults
			if (filters.view) {
				const fv = filteredViewsStore.getById(parseInt(filters.view));
				if (fv) {
					toolbarShowArticles = fv.showArticles;
					toolbarShowShares = fv.showShares;
					toolbarShowDocuments = fv.showDocuments;
					toolbarFeedMode = fv.feedMode;
					toolbarFeedIds = [...fv.feedIds];
					toolbarAccountMode = fv.accountMode;
					toolbarAccountDids = [...fv.accountDids];
					showOnlyUnread = fv.readFilter === 'unread';
				} else {
					resetToolbarFilters();
				}
			} else {
				resetToolbarFilters();
			}
		},
	};
}

export const feedViewStore = createFeedViewStore();
