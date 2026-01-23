<script lang="ts">
	import { tick } from 'svelte';
	import ArticleCard from '$lib/components/ArticleCard.svelte';
	import ShareCard from '$lib/components/ShareCard.svelte';
	import LoadingState from '$lib/components/LoadingState.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { readingStore } from '$lib/stores/reading.svelte';
	import { shareReadingStore } from '$lib/stores/shareReading.svelte';
	import { sharesStore } from '$lib/stores/shares.svelte';
	import type { Article, FeedItem, SocialShare, CombinedFeedItem, UserShare } from '$lib/types';

	interface Props {
		viewMode: 'articles' | 'shares' | 'userShares' | 'combined';
		displayedArticles: Article[];
		displayedShares: SocialShare[];
		displayedUserShares: UserShare[];
		displayedCombined: CombinedFeedItem[];
		articlesByGuid: Map<string, Article>;
		fetchedArticles: Map<string, FeedItem>;
		fetchingArticles: Set<string>;
		selectedIndex: number;
		expandedIndex: number;

		// Pagination state
		articlesHasMore: boolean;
		articlesIsLoadingMore: boolean;
		sharesHasMore: boolean;
		sharesIsLoading: boolean;
		combinedHasMore: boolean;
		combinedIsLoadingMore: boolean;

		// Callbacks
		onSelect: (index: number) => void;
		onDeselect: () => void;
		onExpand: (index: number) => Promise<void>;
		onCollapse: () => Promise<void>;
		onToggleStar: (article: Article) => void;
		onShare: (article: Article, sub: (typeof subscriptionsStore.subscriptions)[0]) => void;
		onUnshare: (guid: string) => void;
		onFetchContent: (feedUrl: string, guid: string, itemUrl?: string) => void;
		onLoadMoreArticles: () => Promise<void>;
		onLoadMoreShares: () => Promise<void>;
		onLoadMoreCombined: () => Promise<void>;
	}

	let {
		viewMode,
		displayedArticles,
		displayedShares,
		displayedUserShares,
		displayedCombined,
		articlesByGuid,
		fetchedArticles,
		fetchingArticles,
		selectedIndex,
		expandedIndex,
		articlesHasMore,
		articlesIsLoadingMore,
		sharesHasMore,
		sharesIsLoading,
		combinedHasMore,
		combinedIsLoadingMore,
		onSelect,
		onDeselect,
		onExpand,
		onCollapse,
		onToggleStar,
		onShare,
		onUnshare,
		onFetchContent,
		onLoadMoreArticles,
		onLoadMoreShares,
		onLoadMoreCombined,
	}: Props = $props();

	// Bindable element refs for scroll observation
	let articleElements = $state<HTMLElement[]>([]);

	function scrollToCenter() {
		const el = articleElements[selectedIndex];
		if (!el) return;

		const rect = el.getBoundingClientRect();
		const targetY = window.innerHeight / 3;
		const offset = rect.top - targetY;

		window.scrollBy({ top: offset, behavior: 'instant' });
	}

	async function handleExpand(index: number) {
		if (expandedIndex === index) {
			await onCollapse();
			await tick();
			scrollToCenter();
		} else {
			await onExpand(index);
			await tick();
			scrollToCenter();
		}
	}

	function handleSelect(index: number) {
		if (selectedIndex === index) {
			onDeselect();
		} else {
			onSelect(index);
		}
	}

	export function getArticleElements(): HTMLElement[] {
		return articleElements;
	}
</script>

{#if viewMode === 'combined'}
	<!-- Combined view (articles + shares) -->
	<div class="article-list">
		{#each displayedCombined as feedItem, index (feedItem.type === 'article' ? feedItem.item.guid : feedItem.item.recordUri)}
			<div bind:this={articleElements[index]}>
				{#if feedItem.type === 'article'}
					{@const article = feedItem.item}
					{@const sub = subscriptionsStore.subscriptions.find(
						(s) => s.id === article.subscriptionId
					)}
					<ArticleCard
						{article}
						siteUrl={sub?.siteUrl}
						isRead={readingStore.isRead(article.guid)}
						isStarred={readingStore.isStarred(article.guid)}
						isShared={sharesStore.isShared(article.guid)}
						shareNote={sharesStore.getShareNote(article.guid)}
						selected={selectedIndex === index}
						expanded={expandedIndex === index}
						onToggleStar={() => onToggleStar(article)}
						onShare={() => sub && onShare(article, sub)}
						onUnshare={() => onUnshare(article.guid)}
						onSelect={() => handleSelect(index)}
						onExpand={() => handleExpand(index)}
					/>
				{:else}
					{@const share = feedItem.item}
					{@const localArticle = share.itemGuid ? articlesByGuid.get(share.itemGuid) : undefined}
					{@const remoteArticle = share.itemGuid ? fetchedArticles.get(share.itemGuid) : undefined}
					{@const isFetching = share.itemGuid ? fetchingArticles.has(share.itemGuid) : false}
					<ShareCard
						{share}
						{localArticle}
						{remoteArticle}
						{isFetching}
						isRead={shareReadingStore.isRead(share.recordUri)}
						selected={selectedIndex === index}
						expanded={expandedIndex === index}
						onSelect={() => handleSelect(index)}
						onExpand={() => handleExpand(index)}
						onFetchContent={() => {
							const hasLocalContent = localArticle?.content || localArticle?.summary;
							const hasRemoteContent = remoteArticle?.content || remoteArticle?.summary;
							if (share.feedUrl && share.itemGuid && !hasLocalContent && !hasRemoteContent) {
								onFetchContent(share.feedUrl, share.itemGuid, share.itemUrl);
							}
						}}
					/>
				{/if}
			</div>
		{/each}

		{#if combinedHasMore && !combinedIsLoadingMore}
			<button class="btn btn-secondary load-more" onclick={onLoadMoreCombined}> Load More </button>
		{/if}

		{#if combinedIsLoadingMore}
			<LoadingState message="Loading more..." />
		{/if}
	</div>
{:else if viewMode === 'shares'}
	<!-- Social shares view -->
	<div class="article-list">
		{#each displayedShares as share, index (share.recordUri)}
			{@const localArticle = share.itemGuid ? articlesByGuid.get(share.itemGuid) : undefined}
			{@const remoteArticle = share.itemGuid ? fetchedArticles.get(share.itemGuid) : undefined}
			{@const isFetching = share.itemGuid ? fetchingArticles.has(share.itemGuid) : false}
			<div bind:this={articleElements[index]}>
				<ShareCard
					{share}
					{localArticle}
					{remoteArticle}
					{isFetching}
					isRead={shareReadingStore.isRead(share.recordUri)}
					selected={selectedIndex === index}
					expanded={expandedIndex === index}
					onSelect={() => handleSelect(index)}
					onExpand={() => handleExpand(index)}
					onFetchContent={() => {
						const hasLocalContent = localArticle?.content || localArticle?.summary;
						const hasRemoteContent = remoteArticle?.content || remoteArticle?.summary;
						if (share.feedUrl && share.itemGuid && !hasLocalContent && !hasRemoteContent) {
							onFetchContent(share.feedUrl, share.itemGuid, share.itemUrl);
						}
					}}
				/>
			</div>
		{/each}

		{#if sharesHasMore && !sharesIsLoading}
			<button class="btn btn-secondary load-more" onclick={onLoadMoreShares}> Load More </button>
		{/if}

		{#if sharesIsLoading && displayedShares.length > 0}
			<LoadingState message="Loading more shares..." />
		{/if}
	</div>
{:else if viewMode === 'userShares'}
	<!-- User's own shares view -->
	<div class="article-list">
		{#each displayedUserShares as share, index (share.articleGuid)}
			{@const localArticle = articlesByGuid.get(share.articleGuid)}
			{@const article = localArticle || {
				guid: share.articleGuid,
				url: share.articleUrl,
				title: share.articleTitle || share.articleUrl,
				author: share.articleAuthor,
				summary: share.articleDescription,
				imageUrl: share.articleImage,
				publishedAt: share.articlePublishedAt || share.createdAt,
				subscriptionId: 0,
				fetchedAt: Date.now(),
			}}
			{@const sub = localArticle
				? subscriptionsStore.subscriptions.find((s) => s.id === localArticle.subscriptionId)
				: undefined}
			<div bind:this={articleElements[index]}>
				<ArticleCard
					{article}
					siteUrl={sub?.siteUrl}
					isRead={readingStore.isRead(article.guid)}
					isStarred={readingStore.isStarred(article.guid)}
					isShared={true}
					shareNote={share.note}
					selected={selectedIndex === index}
					expanded={expandedIndex === index}
					onToggleStar={() => onToggleStar(article)}
					onUnshare={() => onUnshare(share.articleGuid)}
					onSelect={() => handleSelect(index)}
					onExpand={() => handleExpand(index)}
				/>
			</div>
		{/each}
	</div>
{:else}
	<!-- Articles view -->
	<div class="article-list">
		{#each displayedArticles as article, index (article.guid)}
			{@const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId)}
			<div bind:this={articleElements[index]}>
				<ArticleCard
					{article}
					siteUrl={sub?.siteUrl}
					isRead={readingStore.isRead(article.guid)}
					isStarred={readingStore.isStarred(article.guid)}
					isShared={sharesStore.isShared(article.guid)}
					shareNote={sharesStore.getShareNote(article.guid)}
					selected={selectedIndex === index}
					expanded={expandedIndex === index}
					onToggleStar={() => onToggleStar(article)}
					onShare={() => sub && onShare(article, sub)}
					onUnshare={() => onUnshare(article.guid)}
					onSelect={() => handleSelect(index)}
					onExpand={() => handleExpand(index)}
				/>
			</div>
		{/each}

		{#if articlesHasMore && !articlesIsLoadingMore}
			<button class="btn btn-secondary load-more" onclick={onLoadMoreArticles}> Load More </button>
		{/if}

		{#if articlesIsLoadingMore}
			<LoadingState message="Loading more articles..." />
		{/if}
	</div>
{/if}

<style>
	.article-list {
		display: flex;
		flex-direction: column;
	}

	.article-list > div {
		border-bottom: 1px solid var(--color-border);
	}

	.article-list > div:last-child {
		border-bottom: none;
	}

	.load-more {
		width: 100%;
		margin: 1rem 0;
	}
</style>
