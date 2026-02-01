<script lang="ts">
	import { tick } from 'svelte';
	import ArticleCard from '$lib/components/ArticleCard.svelte';
	import LoadingState from '$lib/components/LoadingState.svelte';
	import { feedViewStore } from '$lib/stores/feedView.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { readingStore } from '$lib/stores/reading.svelte';
	import { shareReadingStore } from '$lib/stores/shareReading.svelte';
	import { sharesStore } from '$lib/stores/shares.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import type { Article } from '$lib/types';

	interface Props {
		onToggleStar: (article: Article) => void;
		onShare: (article: Article, sub: (typeof subscriptionsStore.subscriptions)[0]) => void;
		onUnshare: (guid: string) => void;
	}

	let { onToggleStar, onShare, onUnshare }: Props = $props();

	// Element refs for scroll observation
	let articleElements = $state<HTMLElement[]>([]);

	function scrollToCenter(index?: number) {
		const targetIndex = index ?? feedViewStore.selectedIndex;
		const el = articleElements[targetIndex];
		if (!el) return;

		const rect = el.getBoundingClientRect();
		const targetY = window.innerHeight / 4;
		const offset = rect.top - targetY;

		window.scrollBy({ top: offset, behavior: 'instant' });
	}

	async function handleExpand(index: number) {
		if (feedViewStore.expandedIndex === index) {
			feedViewStore.collapse();
		} else {
			feedViewStore.select(index);
			feedViewStore.expand(index);
		}
		await tick();
		scrollToCenter(index);
	}

	function handleSelect(index: number) {
		if (feedViewStore.selectedIndex === index) {
			feedViewStore.deselect();
		} else {
			feedViewStore.select(index);
		}
	}

	function handleToggleRead(article: Article) {
		if (readingStore.isRead(article.guid)) {
			readingStore.markAsUnread(article.guid);
		} else {
			// Track item to keep it visible in unread filter for this session
			feedViewStore.trackSeenThisSession({ type: 'article', item: article, key: article.guid });
			const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
			readingStore.markAsRead(sub?.rkey || '', article.guid, article.url, article.title);
		}
	}

	export function getArticleElements(): HTMLElement[] {
		return articleElements;
	}

	export { scrollToCenter };
</script>

<div class="article-list">
	{#each feedViewStore.currentItems as displayItem, index (displayItem.key)}
		<div bind:this={articleElements[index]}>
			{#if displayItem.type === 'article'}
				{@const article = displayItem.item}
				{@const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId)}
				<ArticleCard
					{article}
					siteUrl={sub?.siteUrl || sub?.feedUrl}
					isRead={readingStore.isRead(article.guid)}
					isStarred={readingStore.isStarred(article.guid)}
					isShared={sharesStore.isShared(article.guid)}
					shareNote={sharesStore.getShareNote(article.guid)}
					selected={preferences.expandAllItems || feedViewStore.selectedIndex === index}
					expanded={feedViewStore.expandedIndex === index}
					highlighted={feedViewStore.selectedIndex === index}
					onToggleStar={() => onToggleStar(article)}
					onToggleRead={() => handleToggleRead(article)}
					onShare={() => sub && onShare(article, sub)}
					onUnshare={() => onUnshare(article.guid)}
					onSelect={() => handleSelect(index)}
					onExpand={() => handleExpand(index)}
				/>
			{:else if displayItem.type === 'share'}
				{@const share = displayItem.item}
				{@const localArticle = feedViewStore.getArticleForShare(share)}
				<ArticleCard
					{share}
					{localArticle}
					isRead={shareReadingStore.isRead(share.recordUri)}
					selected={preferences.expandAllItems || feedViewStore.selectedIndex === index}
					expanded={feedViewStore.expandedIndex === index}
					highlighted={feedViewStore.selectedIndex === index}
					onToggleRead={() => {
						if (shareReadingStore.isRead(share.recordUri)) {
							shareReadingStore.markAsUnread(share.recordUri);
						} else {
							shareReadingStore.markAsRead(
								share.recordUri,
								share.authorDid,
								share.itemUrl,
								share.itemTitle
							);
						}
					}}
					onSelect={() => handleSelect(index)}
					onExpand={() => handleExpand(index)}
				/>
			{:else if displayItem.type === 'userShare'}
				{@const share = displayItem.item}
				{@const article = displayItem.article}
				{@const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId)}
				<ArticleCard
					{article}
					siteUrl={sub?.siteUrl || sub?.feedUrl}
					isRead={readingStore.isRead(article.guid)}
					isStarred={readingStore.isStarred(article.guid)}
					isShared={true}
					shareNote={share.note}
					reshareCount={share.reshareCount || 0}
					selected={preferences.expandAllItems || feedViewStore.selectedIndex === index}
					expanded={feedViewStore.expandedIndex === index}
					highlighted={feedViewStore.selectedIndex === index}
					onToggleStar={() => onToggleStar(article)}
					onToggleRead={() => handleToggleRead(article)}
					onUnshare={() => onUnshare(share.articleGuid)}
					onSelect={() => handleSelect(index)}
					onExpand={() => handleExpand(index)}
				/>
			{/if}
		</div>
	{/each}

	{#if feedViewStore.hasMore && !feedViewStore.isLoadingMore}
		<button class="btn btn-secondary load-more" onclick={() => feedViewStore.loadMore()}>
			Load More
		</button>
	{/if}

	{#if feedViewStore.isLoadingMore}
		<LoadingState message="Loading more..." />
	{/if}
</div>

<style>
	.article-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.load-more {
		width: 100%;
		margin: 1rem 0;
	}
</style>
