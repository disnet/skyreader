<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { page } from '$app/stores';
	import { auth } from '$lib/stores/auth.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { readingStore } from '$lib/stores/reading.svelte';
	import { shareReadingStore } from '$lib/stores/shareReading.svelte';
	import { sharesStore } from '$lib/stores/shares.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { feedViewStore } from '$lib/stores/feedView.svelte';
	import { appManager } from '$lib/stores/app.svelte';
	import { articlesStore } from '$lib/stores/articles.svelte';
	import { profileService } from '$lib/services/profiles';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import LoadingState from '$lib/components/LoadingState.svelte';
	import WelcomePage from '$lib/components/feed/WelcomePage.svelte';
	import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
	import FeedListView from '$lib/components/feed/FeedListView.svelte';
	import EditFeedModal from '$lib/components/EditFeedModal.svelte';
	import type { Subscription, BlueskyProfile } from '$lib/types';
	import { useScrollMarkAsRead } from '$lib/hooks/useScrollMarkAsRead.svelte';
	import { useFeedKeyboardShortcuts } from '$lib/hooks/useFeedKeyboardShortcuts.svelte';
	import { goto } from '$app/navigation';

	// Profile for sharer filter title
	let sharerProfile = $state<BlueskyProfile | null>(null);

	// Fetch sharer profile when filter changes
	$effect(() => {
		const sharerDid = feedViewStore.sharerFilter;
		if (sharerDid) {
			profileService.getProfile(sharerDid).then((p) => {
				sharerProfile = p;
			});
		} else {
			sharerProfile = null;
		}
	});

	// Sync URL filters to feedViewStore
	$effect(() => {
		const url = $page.url;
		feedViewStore.setFilters({
			feed: url.searchParams.get('feed'),
			starred: url.searchParams.get('starred'),
			shared: url.searchParams.get('shared'),
			sharer: url.searchParams.get('sharer'),
			following: url.searchParams.get('following'),
			feeds: url.searchParams.get('feeds'),
		});
	});

	// Tab visibility state
	let lastVisibleTime = $state(Date.now());
	const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

	// Reference to FeedListView component for accessing article elements
	let feedListView = $state<ReturnType<typeof FeedListView> | null>(null);

	function getArticleElements(): HTMLElement[] {
		return feedListView?.getArticleElements() ?? [];
	}

	// Edit modal state
	let editingSubscription = $state<Subscription | null>(null);
	let editModalOpen = $state(false);

	function handleEditFeed() {
		if (!feedViewStore.feedFilter) return;
		const feedId = parseInt(feedViewStore.feedFilter);
		const sub = subscriptionsStore.subscriptions.find((s) => s.id === feedId);
		if (sub) {
			editingSubscription = sub;
			editModalOpen = true;
		}
	}

	function closeEditModal() {
		editModalOpen = false;
		editingSubscription = null;
	}

	// Get page title based on filter
	let pageTitle = $derived.by(() => {
		if (feedViewStore.feedFilter) {
			const sub = subscriptionsStore.subscriptions.find(
				(s) => s.id === parseInt(feedViewStore.feedFilter!)
			);
			return sub?.customTitle || sub?.title || 'Feed';
		}
		if (feedViewStore.starredFilter) return 'Starred';
		if (feedViewStore.sharedFilter) return 'Shared';
		if (feedViewStore.followingFilter) return 'Following';
		if (feedViewStore.sharerFilter) {
			return sharerProfile?.displayName || sharerProfile?.handle || 'Shared';
		}
		if (feedViewStore.feedsFilter) return 'Feeds';
		return 'All';
	});

	// Mark an item as read by its stable key
	function markItemAsReadByKey(key: string) {
		const items = feedViewStore.currentItems;
		const item = items.find((i) => i.key === key);
		if (!item) return;

		// Track the item so it stays visible in unread filter until view changes
		feedViewStore.trackSeenThisSession(item);

		if (item.type === 'article') {
			const article = item.item;
			if (readingStore.isRead(article.guid)) return;

			const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
			if (sub) {
				readingStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
			}
		} else if (item.type === 'share') {
			const share = item.item;
			if (shareReadingStore.isRead(share.recordUri)) return;

			shareReadingStore.markAsRead(
				share.recordUri,
				share.authorDid,
				share.itemUrl,
				share.itemTitle
			);
		}
		// userShare items don't auto-mark as read from scroll
	}

	// Initialize scroll-to-mark-as-read hook
	const scrollMarkAsRead = useScrollMarkAsRead({
		getArticleElements,
		getItemKey: (index) => feedViewStore.currentItems[index]?.key,
		enabled: preferences.scrollToMarkAsRead,
		onMarkAsRead: markItemAsReadByKey,
	});

	// Setup/teardown scroll-to-mark-as-read observer when content changes
	$effect(() => {
		const _items = feedViewStore.currentItems;
		const _enabled = preferences.scrollToMarkAsRead;

		tick().then(() => {
			scrollMarkAsRead.setupObserver();
		});
	});

	function scrollToCenter() {
		const elements = getArticleElements();
		const el = elements[feedViewStore.selectedIndex];
		if (!el) return;

		const rect = el.getBoundingClientRect();
		const targetY = window.innerHeight / 3;
		const offset = rect.top - targetY;

		window.scrollBy({ top: offset, behavior: 'instant' });
	}

	async function markAllAsReadInCurrentFeed() {
		if (!feedViewStore.feedFilter) return;

		const feedId = parseInt(feedViewStore.feedFilter);
		const sub = subscriptionsStore.subscriptions.find((s) => s.id === feedId);
		if (!sub) return;

		const allFeedArticles = articlesStore.getForSubscription(feedId);

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
		scrollToCenter,
		markAllAsReadInCurrentFeed,
	});

	async function removeFeed(id: number) {
		if (confirm('Are you sure you want to remove this subscription?')) {
			await subscriptionsStore.remove(id);
			goto('/');
		}
	}

	async function handleVisibilityChange() {
		if (document.visibilityState === 'visible' && auth.isAuthenticated) {
			// Check if data is actually stale using persisted lastRefreshAt
			if (appManager.isStale(STALE_THRESHOLD_MS)) {
				console.log('Data is stale, refreshing...');
				await appManager.refreshFromBackend();
			}
		}
		lastVisibleTime = Date.now();
	}

	onMount(async () => {
		if (auth.isAuthenticated) {
			// Use the new centralized app initialization
			await appManager.initialize();
		}

		scrollMarkAsRead.init();
		keyboardShortcuts.register();

		document.addEventListener('visibilitychange', handleVisibilityChange);
		lastVisibleTime = Date.now();
	});

	// Reset selection when any filter changes
	$effect(() => {
		const _ = [
			feedViewStore.feedFilter,
			feedViewStore.starredFilter,
			feedViewStore.sharedFilter,
			feedViewStore.sharerFilter,
			feedViewStore.followingFilter,
			feedViewStore.feedsFilter,
		];
		feedViewStore.resetSelection();
	});

	onDestroy(() => {
		document.removeEventListener('visibilitychange', handleVisibilityChange);
	});
</script>

<EditFeedModal open={editModalOpen} subscription={editingSubscription} onclose={closeEditModal} />

{#if !auth.isAuthenticated}
	<WelcomePage />
{:else}
	<div class="feed-page">
		<FeedPageHeader
			title={pageTitle}
			feedId={feedViewStore.feedFilter ? parseInt(feedViewStore.feedFilter) : undefined}
			showViewToggle={!feedViewStore.starredFilter && !feedViewStore.sharedFilter}
			showOnlyUnread={feedViewStore.showOnlyUnread}
			lastRefreshAt={appManager.lastRefreshAt}
			isRefreshing={appManager.isRefreshing}
			onToggleUnread={(value) => feedViewStore.setShowOnlyUnread(value)}
			onRefresh={() => appManager.refreshFromBackend()}
			onMarkAllAsRead={feedViewStore.feedFilter ? markAllAsReadInCurrentFeed : undefined}
			onEdit={feedViewStore.feedFilter ? handleEditFeed : undefined}
			onDelete={feedViewStore.feedFilter
				? () => removeFeed(parseInt(feedViewStore.feedFilter!))
				: undefined}
		/>

		{#if (appManager.isHydrating || appManager.isRefreshing) && feedViewStore.currentItems.length === 0}
			<LoadingState />
		{:else if feedViewStore.currentItems.length === 0}
			{#if feedViewStore.starredFilter}
				<EmptyState
					title="No starred articles"
					description="Star articles to save them for later"
				/>
			{:else if feedViewStore.sharedFilter}
				<EmptyState title="No shared articles" description="Share articles to see them here" />
			{:else if feedViewStore.followingFilter}
				{#if feedViewStore.showOnlyUnread}
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
			{:else if feedViewStore.sharerFilter}
				{#if feedViewStore.showOnlyUnread}
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
			{:else if feedViewStore.feedFilter}
				{#if feedViewStore.showOnlyUnread}
					<EmptyState title="No unread articles" description="You're all caught up on this feed" />
				{:else}
					<EmptyState title="No articles" description="This feed has no articles" />
				{/if}
			{:else if feedViewStore.feedsFilter}
				<EmptyState title="No unread articles" description="You're all caught up on your feeds" />
			{:else if feedViewStore.showOnlyUnread}
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
						article.content,
						article.summary,
						article.imageUrl,
						article.publishedAt
					)}
				onUnshare={(guid) => sharesStore.unshare(guid)}
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
