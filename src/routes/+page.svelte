<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import { page } from '$app/stores';
	import { auth } from '$lib/stores/auth.svelte';
	import { sidebarStore } from '$lib/stores/sidebar.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { readingStore } from '$lib/stores/reading.svelte';
	import { shareReadingStore } from '$lib/stores/shareReading.svelte';
	import { sharesStore } from '$lib/stores/shares.svelte';
	import { socialStore } from '$lib/stores/social.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { api } from '$lib/services/api';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import LoadingState from '$lib/components/LoadingState.svelte';
	import WelcomePage from '$lib/components/feed/WelcomePage.svelte';
	import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
	import FeedListView from '$lib/components/feed/FeedListView.svelte';
	import { useScrollMarkAsRead } from '$lib/hooks/useScrollMarkAsRead.svelte';
	import { useFeedKeyboardShortcuts } from '$lib/hooks/useFeedKeyboardShortcuts.svelte';
	import { goto } from '$app/navigation';
	import type { Article, FeedItem, SocialShare, CombinedFeedItem, UserShare } from '$lib/types';

	let allArticles = $state<Article[]>([]);
	let isLoading = $state(true);

	// Centralized article loading function
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

	let selectedIndex = $state(-1);
	let expandedIndex = $state(-1);
	let showOnlyUnread = $state(true);

	// Snapshot of displayed items
	let displayedArticles = $state<Article[]>([]);
	let displayedShares = $state<SocialShare[]>([]);
	let displayedUserShares = $state<UserShare[]>([]);
	let displayedCombined = $state<CombinedFeedItem[]>([]);

	let articlesByGuid = $derived(new Map(allArticles.map((a) => [a.guid, a])));

	// Cache for fetched articles (from backend, for shares not in local DB)
	let fetchedArticles = $state<Map<string, FeedItem>>(new Map());
	let fetchingArticles = $state<Set<string>>(new Set());

	// Tab visibility state
	let lastVisibleTime = $state(Date.now());
	const STALE_THRESHOLD_MS = 5 * 60 * 1000;

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

	// Get filter params from URL
	let feedFilter = $derived($page.url.searchParams.get('feed'));
	let starredFilter = $derived($page.url.searchParams.get('starred'));
	let sharedFilter = $derived($page.url.searchParams.get('shared'));
	let sharerFilter = $derived($page.url.searchParams.get('sharer'));
	let followingFilter = $derived($page.url.searchParams.get('following'));
	let feedsFilter = $derived($page.url.searchParams.get('feeds'));

	// Determine current view mode
	let viewMode = $derived.by((): 'articles' | 'shares' | 'userShares' | 'combined' => {
		if (sharedFilter) return 'userShares';
		if (sharerFilter || followingFilter) return 'shares';
		if (feedFilter || starredFilter || feedsFilter) return 'articles';
		return 'combined';
	});

	// Build a filter key to detect when we need to recompute the snapshot
	let filterKey = $derived(
		`${feedFilter || ''}-${starredFilter || ''}-${sharedFilter || ''}-${sharerFilter || ''}-${followingFilter || ''}-${feedsFilter || ''}-${showOnlyUnread}`
	);

	// Track the last filter key and articles version to know when to snapshot
	let lastFilterKey = $state('');
	let lastSharesFilterKey = $state('');
	let lastArticlesVersion = $state(-1);
	let lastArticlesLength = $state(-1);
	let lastSharesLength = $state(-1);

	// Snapshot articles when filter or source data changes
	$effect(() => {
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
	});

	// Snapshot shares when filter or source data changes
	$effect(() => {
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
	});

	// Snapshot user's own shares when filter changes
	$effect(() => {
		const userShares = sharesStore.userShares;
		const currentKey = filterKey;

		if (sharedFilter) {
			const shares = Array.from(userShares.values());
			shares.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
			displayedUserShares = shares;
		} else {
			displayedUserShares = [];
		}
	});

	// Combine articles and shares for the "all" view
	$effect(() => {
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
	});

	// Get page title based on filter
	let pageTitle = $derived.by(() => {
		if (feedFilter) {
			const sub = subscriptionsStore.subscriptions.find((s) => s.id === parseInt(feedFilter));
			return sub?.title || 'Feed';
		}
		if (starredFilter) return 'Starred';
		if (sharedFilter) return 'Shared';
		if (followingFilter) return 'Following';
		if (sharerFilter) {
			const user = socialStore.followedUsers.find((u) => u.did === sharerFilter);
			return user?.displayName || user?.handle || 'Shared';
		}
		if (feedsFilter) return 'Feeds';
		return 'All';
	});

	// Get current items based on view mode
	let currentItems = $derived.by(() => {
		const mode = viewMode;
		if (mode === 'combined') return displayedCombined;
		if (mode === 'shares') return displayedShares;
		if (mode === 'userShares') return displayedUserShares;
		return displayedArticles;
	});

	let combinedHasMore = $derived(subscriptionsStore.articlesHasMore || socialStore.hasMore);
	let combinedIsLoadingMore = $derived(
		subscriptionsStore.articlesIsLoadingMore || socialStore.isLoading
	);

	// Reference to FeedListView component for accessing article elements
	let feedListView = $state<ReturnType<typeof FeedListView> | null>(null);

	function getArticleElements(): HTMLElement[] {
		return feedListView?.getArticleElements() ?? [];
	}

	// Mark an item as read by its index
	function markItemAsReadByIndex(index: number) {
		const mode = viewMode;
		if (mode === 'userShares') return;

		if (mode === 'articles') {
			const article = displayedArticles[index];
			if (!article || readingStore.isRead(article.guid)) return;

			const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
			if (sub) {
				readingStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
			}
		} else if (mode === 'shares') {
			const share = displayedShares[index];
			if (!share || shareReadingStore.isRead(share.recordUri)) return;

			shareReadingStore.markAsRead(
				share.recordUri,
				share.authorDid,
				share.itemUrl,
				share.itemTitle
			);
		} else if (mode === 'combined') {
			const feedItem = displayedCombined[index];
			if (!feedItem) return;

			if (feedItem.type === 'article') {
				const article = feedItem.item;
				if (readingStore.isRead(article.guid)) return;

				const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
				if (sub) {
					readingStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
				}
			} else {
				const share = feedItem.item;
				if (shareReadingStore.isRead(share.recordUri)) return;

				shareReadingStore.markAsRead(
					share.recordUri,
					share.authorDid,
					share.itemUrl,
					share.itemTitle
				);
			}
		}
	}

	// Initialize hooks
	const scrollMarkAsRead = useScrollMarkAsRead({
		getArticleElements,
		enabled: preferences.scrollToMarkAsRead,
		onMarkAsRead: markItemAsReadByIndex,
	});

	// Setup/teardown scroll-to-mark-as-read observer when preference or content changes
	$effect(() => {
		const _articles = displayedArticles;
		const _shares = displayedShares;
		const _combined = displayedCombined;
		const _mode = viewMode;
		const _enabled = preferences.scrollToMarkAsRead;

		tick().then(() => {
			scrollMarkAsRead.setupObserver();
		});
	});

	function scrollToCenter() {
		const elements = getArticleElements();
		const el = elements[selectedIndex];
		if (!el) return;

		const rect = el.getBoundingClientRect();
		const targetY = window.innerHeight / 3;
		const offset = rect.top - targetY;

		window.scrollBy({ top: offset, behavior: 'instant' });
	}

	async function selectItem(index: number) {
		if (index === selectedIndex) return;

		const mode = viewMode;
		if (mode === 'articles') {
			const article = displayedArticles[index];
			const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
			if (sub && !readingStore.isRead(article.guid)) {
				readingStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
			}
		} else if (mode === 'shares') {
			const share = displayedShares[index];
			if (!shareReadingStore.isRead(share.recordUri)) {
				shareReadingStore.markAsRead(
					share.recordUri,
					share.authorDid,
					share.itemUrl,
					share.itemTitle
				);
			}
		} else if (mode === 'combined') {
			const feedItem = displayedCombined[index];
			if (feedItem.type === 'article') {
				const article = feedItem.item;
				const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
				if (sub && !readingStore.isRead(article.guid)) {
					readingStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
				}
			} else {
				const share = feedItem.item;
				if (!shareReadingStore.isRead(share.recordUri)) {
					shareReadingStore.markAsRead(
						share.recordUri,
						share.authorDid,
						share.itemUrl,
						share.itemTitle
					);
				}
			}
		}

		selectedIndex = index;
		expandedIndex = -1;

		await tick();
		scrollToCenter();
	}

	async function loadMoreArticles() {
		const feedId = feedFilter ? parseInt(feedFilter) : undefined;
		const newArticles = await subscriptionsStore.loadMoreArticles(feedId);
		if (newArticles.length > 0) {
			allArticles = [...allArticles, ...newArticles];
		}
	}

	async function loadMoreCombined() {
		const [, newArticles] = await Promise.all([
			socialStore.hasMore ? socialStore.loadFeed(false) : Promise.resolve(),
			subscriptionsStore.articlesHasMore
				? subscriptionsStore.loadMoreArticles()
				: Promise.resolve([]),
		]);

		if (newArticles && newArticles.length > 0) {
			allArticles = [...allArticles, ...newArticles];
		}
	}

	async function markAllAsReadInCurrentFeed() {
		if (!feedFilter) return;

		const feedId = parseInt(feedFilter);
		const sub = subscriptionsStore.subscriptions.find((s) => s.id === feedId);
		if (!sub) return;

		const allFeedArticles = await subscriptionsStore.getArticles(feedId);

		const articlesToMark = allFeedArticles
			.filter((a) => !readingStore.isRead(a.guid))
			.map((a) => ({
				subscriptionRkey: sub.rkey,
				articleGuid: a.guid,
				articleUrl: a.url,
				articleTitle: a.title,
			}));

		if (articlesToMark.length > 0) {
			await readingStore.markAllAsRead(articlesToMark);
		}
	}

	// Keyboard shortcuts hook
	const keyboardShortcuts = useFeedKeyboardShortcuts({
		getCurrentItems: () => currentItems,
		getSelectedIndex: () => selectedIndex,
		getExpandedIndex: () => expandedIndex,
		getViewMode: () => viewMode,
		getDisplayedArticles: () => displayedArticles,
		getDisplayedShares: () => displayedShares,
		getDisplayedCombined: () => displayedCombined,
		getDisplayedUserShares: () => displayedUserShares,
		getSubscriptions: () => subscriptionsStore.subscriptions,
		getArticlesByGuid: () => articlesByGuid,
		getCombinedHasMore: () => combinedHasMore,
		getArticlesHasMore: () => subscriptionsStore.articlesHasMore,
		getSharesHasMore: () => socialStore.hasMore,
		hasFeedFilter: () => !!feedFilter,
		hasStarredFilter: () => !!starredFilter,
		hasSharedFilter: () => !!sharedFilter,
		selectItem,
		setExpandedIndex: (index: number) => {
			expandedIndex = index;
		},
		scrollToCenter,
		loadMoreCombined,
		loadMoreArticles,
		loadMoreShares: () => socialStore.loadFeed(false),
		toggleStar: (guid, url, title) => readingStore.toggleStar(guid, url, title),
		share: (rkey, feedUrl, guid, url, title, author, summary, imageUrl, publishedAt) =>
			sharesStore.share(rkey, feedUrl, guid, url, title, author, summary, imageUrl, publishedAt),
		unshare: (guid) => sharesStore.unshare(guid),
		isShared: (guid) => sharesStore.isShared(guid),
		markAsRead: (rkey, guid, url, title) => readingStore.markAsRead(rkey, guid, url, title),
		markAsUnread: (guid) => readingStore.markAsUnread(guid),
		isRead: (guid) => readingStore.isRead(guid),
		shareMarkAsRead: (uri, authorDid, url, title) =>
			shareReadingStore.markAsRead(uri, authorDid, url, title),
		shareMarkAsUnread: (uri) => shareReadingStore.markAsUnread(uri),
		shareIsRead: (uri) => shareReadingStore.isRead(uri),
		markAllAsReadInCurrentFeed,
		toggleUnreadFilter: () => {
			showOnlyUnread = !showOnlyUnread;
		},
	});

	async function removeFeed(id: number) {
		if (confirm('Are you sure you want to remove this subscription?')) {
			await subscriptionsStore.remove(id);
			goto('/');
		}
	}

	async function handleVisibilityChange() {
		if (document.visibilityState === 'visible' && auth.isAuthenticated) {
			const timeSinceVisible = Date.now() - lastVisibleTime;

			if (timeSinceVisible > STALE_THRESHOLD_MS) {
				console.log('Tab was hidden for a while, checking for updates...');
				await subscriptionsStore.fetchAllNewFeeds();
				subscriptionsStore.resetArticlesPagination();
				allArticles = await subscriptionsStore.getArticlesPaginated(
					feedFilter ? parseInt(feedFilter) : undefined
				);
			}
		}
		lastVisibleTime = Date.now();
	}

	onMount(async () => {
		if (auth.isAuthenticated) {
			await subscriptionsStore.load();
			await readingStore.load();
			await shareReadingStore.load();
			await sharesStore.load();
			await socialStore.loadFollowedUsers();
			await socialStore.loadFeed(true);

			await loadArticles();

			if (subscriptionsStore.subscriptions.length > 0) {
				const feedUrls = subscriptionsStore.subscriptions.map((s) => s.feedUrl);
				await subscriptionsStore.checkFeedStatuses(feedUrls);
				await subscriptionsStore.fetchAllNewFeeds();

				await loadArticles();
			}
		}
		isLoading = false;

		lastLoadedFilter = feedFilter;
		lastLoadedStarredFilter = starredFilter;
		lastLoadedVersion = subscriptionsStore.articlesVersion;

		scrollMarkAsRead.init();
		keyboardShortcuts.register();

		document.addEventListener('visibilitychange', handleVisibilityChange);
		lastVisibleTime = Date.now();
	});

	// Reset selection when any filter changes
	$effect(() => {
		feedFilter;
		starredFilter;
		sharedFilter;
		sharerFilter;
		followingFilter;
		feedsFilter;
		selectedIndex = -1;
		expandedIndex = -1;
	});

	// Reload articles when filters change or new articles arrive
	let lastLoadedFilter = $state<string | null | undefined>(undefined);
	let lastLoadedStarredFilter = $state<string | null | undefined>(undefined);
	let lastLoadedVersion = $state(-1);

	$effect(() => {
		const currentFilter = feedFilter;
		const currentStarredFilter = starredFilter;
		const currentVersion = subscriptionsStore.articlesVersion;

		const prevFilter = untrack(() => lastLoadedFilter);
		const prevStarredFilter = untrack(() => lastLoadedStarredFilter);
		const prevVersion = untrack(() => lastLoadedVersion);

		if (prevFilter === undefined) return;

		if (
			currentFilter !== prevFilter ||
			currentStarredFilter !== prevStarredFilter ||
			currentVersion !== prevVersion
		) {
			lastLoadedFilter = currentFilter;
			lastLoadedStarredFilter = currentStarredFilter;
			lastLoadedVersion = currentVersion;
			loadArticles();
		}
	});

	onDestroy(() => {
		document.removeEventListener('visibilitychange', handleVisibilityChange);
	});
</script>

{#if !auth.isAuthenticated}
	<WelcomePage />
{:else}
	<div class="feed-page">
		<FeedPageHeader
			title={pageTitle}
			feedId={feedFilter ? parseInt(feedFilter) : undefined}
			showViewToggle={!starredFilter && !sharedFilter}
			{showOnlyUnread}
			onToggleUnread={(value) => (showOnlyUnread = value)}
			onMarkAllAsRead={feedFilter ? markAllAsReadInCurrentFeed : undefined}
			onDelete={feedFilter ? () => removeFeed(parseInt(feedFilter)) : undefined}
			onMobileMenuToggle={() => sidebarStore.toggleMobile()}
		/>

		{#if isLoading && currentItems.length === 0}
			<LoadingState />
		{:else if currentItems.length === 0}
			{#if starredFilter}
				<EmptyState
					title="No starred articles"
					description="Star articles to save them for later"
				/>
			{:else if sharedFilter}
				<EmptyState title="No shared articles" description="Share articles to see them here" />
			{:else if followingFilter}
				{#if showOnlyUnread}
					<EmptyState
						title="No unread shares"
						description="You're all caught up on shares from people you follow"
					/>
				{:else}
					<EmptyState
						title="No shared articles"
						description="People you follow haven't shared any articles yet"
					/>
				{/if}
			{:else if sharerFilter}
				{#if showOnlyUnread}
					<EmptyState
						title="No unread shares"
						description="You're all caught up on shares from this user"
					/>
				{:else}
					<EmptyState
						title="No shares from this user"
						description="This user hasn't shared any articles yet"
					/>
				{/if}
			{:else if feedFilter}
				{#if showOnlyUnread}
					<EmptyState title="No unread articles" description="You're all caught up on this feed" />
				{:else}
					<EmptyState title="No articles" description="This feed has no articles" />
				{/if}
			{:else if feedsFilter}
				<EmptyState title="No unread articles" description="You're all caught up on your feeds" />
			{:else if showOnlyUnread}
				<EmptyState title="No unread articles" description="You're all caught up!" />
			{:else}
				<EmptyState
					title="No articles"
					description="Add some subscriptions using the + button in the sidebar"
				/>
			{/if}
		{:else}
			<FeedListView
				bind:this={feedListView}
				{viewMode}
				{displayedArticles}
				{displayedShares}
				{displayedUserShares}
				{displayedCombined}
				{articlesByGuid}
				{fetchedArticles}
				{fetchingArticles}
				{selectedIndex}
				{expandedIndex}
				articlesHasMore={subscriptionsStore.articlesHasMore}
				articlesIsLoadingMore={subscriptionsStore.articlesIsLoadingMore}
				sharesHasMore={socialStore.hasMore}
				sharesIsLoading={socialStore.isLoading}
				{combinedHasMore}
				{combinedIsLoadingMore}
				onSelect={selectItem}
				onDeselect={() => {
					selectedIndex = -1;
					expandedIndex = -1;
				}}
				onExpand={async (index) => {
					expandedIndex = index;
				}}
				onCollapse={async () => {
					expandedIndex = -1;
				}}
				onToggleStar={(article) =>
					readingStore.toggleStar(article.guid, article.url, article.title)}
				onShare={(article, sub) =>
					sharesStore.share(
						sub.rkey,
						sub.feedUrl,
						article.guid,
						article.url,
						article.title,
						article.author,
						article.summary,
						article.imageUrl,
						article.publishedAt
					)}
				onUnshare={(guid) => sharesStore.unshare(guid)}
				onFetchContent={fetchArticleContent}
				onLoadMoreArticles={loadMoreArticles}
				onLoadMoreShares={() => socialStore.loadFeed(false)}
				onLoadMoreCombined={loadMoreCombined}
			/>
		{/if}
	</div>
{/if}

<style>
	.feed-page {
		max-width: 800px;
		margin: 0 auto;
	}
</style>
