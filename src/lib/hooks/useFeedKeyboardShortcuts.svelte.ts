import { onDestroy } from 'svelte';
import { tick } from 'svelte';
import { keyboardStore } from '$lib/stores/keyboard.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
import { readingStore } from '$lib/stores/reading.svelte';
import { shareReadingStore } from '$lib/stores/shareReading.svelte';
import { sharesStore } from '$lib/stores/shares.svelte';
import type { Article, Subscription } from '$lib/types';

interface KeyboardShortcutsParams {
	scrollToCenter: () => void;
	markAllAsReadInCurrentFeed: () => Promise<void>;
}

/**
 * Hook for feed keyboard shortcuts.
 * Registers and unregisters keyboard shortcuts for the feed page.
 */
export function useFeedKeyboardShortcuts(params: KeyboardShortcutsParams) {
	// Helper to get the article from a FeedDisplayItem
	function getArticleFromItem(item: FeedDisplayItem): Article | null {
		if (item.type === 'article') {
			return item.item;
		} else if (item.type === 'userShare') {
			return item.article;
		}
		return null;
	}

	// Helper to get subscription for an article
	function getSubscriptionForArticle(article: Article): Subscription | undefined {
		return subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
	}

	// Helper to get selected article info
	function getSelectedArticle(): {
		article: Article;
		sub: Subscription;
	} | null {
		const selectedIndex = feedViewStore.selectedIndex;
		if (selectedIndex < 0) return null;

		const items = feedViewStore.currentItems;
		const item = items[selectedIndex];
		if (!item) return null;

		const article = getArticleFromItem(item);
		if (!article) return null;

		const sub = getSubscriptionForArticle(article);
		if (!sub) {
			// For userShares without local subscription, create a minimal sub
			if (item.type === 'userShare') {
				return {
					article,
					sub: {
						rkey: '',
						feedUrl: item.item.feedUrl || '',
						id: 0,
						title: '',
						tags: [],
						createdAt: '',
						localUpdatedAt: 0,
					} as Subscription,
				};
			}
			return null;
		}

		return { article, sub };
	}

	// Open selected item in new tab
	function openSelectedItem() {
		const selectedIndex = feedViewStore.selectedIndex;
		if (selectedIndex < 0) return;

		const items = feedViewStore.currentItems;
		const item = items[selectedIndex];
		if (!item) return;

		let url: string;
		if (item.type === 'article') {
			url = item.item.url;
		} else if (item.type === 'share') {
			url = item.item.itemUrl;
		} else {
			url = item.item.articleUrl;
		}
		window.open(url, '_blank');
	}

	// Toggle star on selected item
	function toggleSelectedStar() {
		const selected = getSelectedArticle();
		if (selected) {
			readingStore.toggleStar(selected.article.guid, selected.article.url, selected.article.title);
		}
	}

	// Share/unshare selected item
	function toggleSelectedShare() {
		const selected = getSelectedArticle();
		if (!selected) return;

		const { article, sub } = selected;
		if (sharesStore.isShared(article.guid)) {
			sharesStore.unshare(article.guid);
		} else {
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
			);
		}
	}

	// Toggle read/unread on selected item
	function toggleSelectedRead() {
		const selectedIndex = feedViewStore.selectedIndex;
		if (selectedIndex < 0) return;

		const items = feedViewStore.currentItems;
		const item = items[selectedIndex];
		if (!item) return;

		if (item.type === 'article' || item.type === 'userShare') {
			const article = item.type === 'article' ? item.item : item.article;
			const sub = getSubscriptionForArticle(article);
			if (!sub) return;

			if (readingStore.isRead(article.guid)) {
				readingStore.markAsUnread(article.guid);
			} else {
				readingStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
			}
		} else if (item.type === 'share') {
			const share = item.item;
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
		}
	}

	// Navigation actions
	async function selectNextItem() {
		const currentItems = feedViewStore.currentItems;
		const selectedIndex = feedViewStore.selectedIndex;
		if (currentItems.length === 0) return;

		const nextIndex = Math.min(selectedIndex + 1, currentItems.length - 1);
		feedViewStore.select(nextIndex);

		// If we're at the last item, try to load more
		if (nextIndex === currentItems.length - 1 && feedViewStore.hasMore) {
			await feedViewStore.loadMore();
		}
	}

	function selectPreviousItem() {
		const currentItems = feedViewStore.currentItems;
		const selectedIndex = feedViewStore.selectedIndex;
		if (currentItems.length === 0) return;

		feedViewStore.select(Math.max(selectedIndex - 1, 0));
	}

	function hasItems() {
		return auth.isAuthenticated && feedViewStore.currentItems.length > 0;
	}

	function hasSelected() {
		return auth.isAuthenticated && feedViewStore.selectedIndex >= 0;
	}

	// Toggle expand action
	async function toggleExpand() {
		const selectedIndex = feedViewStore.selectedIndex;
		const expandedIndex = feedViewStore.expandedIndex;
		if (selectedIndex < 0) return;

		if (expandedIndex === selectedIndex) {
			feedViewStore.collapse();
		} else {
			feedViewStore.expand(selectedIndex);
		}
		await tick();
		params.scrollToCenter();
	}

	function register() {
		// Navigation shortcuts
		keyboardStore.register({
			key: 'j',
			description: 'Next item',
			category: 'Navigation',
			action: selectNextItem,
			condition: hasItems,
		});

		keyboardStore.register({
			key: 'ArrowDown',
			description: 'Next item',
			category: 'Navigation',
			action: selectNextItem,
			condition: hasItems,
		});

		keyboardStore.register({
			key: 'k',
			description: 'Previous item',
			category: 'Navigation',
			action: selectPreviousItem,
			condition: hasItems,
		});

		keyboardStore.register({
			key: 'ArrowUp',
			description: 'Previous item',
			category: 'Navigation',
			action: selectPreviousItem,
			condition: hasItems,
		});

		keyboardStore.register({
			key: 'o',
			description: 'Open in new tab',
			category: 'Navigation',
			action: openSelectedItem,
			condition: hasSelected,
		});

		keyboardStore.register({
			key: 'Enter',
			description: 'Toggle expand',
			category: 'Navigation',
			action: toggleExpand,
			condition: hasSelected,
		});

		// Article action shortcuts
		keyboardStore.register({
			key: 's',
			description: 'Toggle star',
			category: 'Article',
			action: toggleSelectedStar,
			condition: hasSelected,
		});

		keyboardStore.register({
			key: 'S',
			shift: true,
			description: 'Share/unshare',
			category: 'Article',
			action: toggleSelectedShare,
			condition: hasSelected,
		});

		keyboardStore.register({
			key: 'm',
			description: 'Mark read/unread',
			category: 'Article',
			action: toggleSelectedRead,
			condition: hasSelected,
		});

		// Other shortcuts
		keyboardStore.register({
			key: 'u',
			description: 'Toggle unread filter',
			category: 'Other',
			action: () => feedViewStore.toggleUnreadFilter(),
			condition: () =>
				auth.isAuthenticated && !feedViewStore.starredFilter && !feedViewStore.sharedFilter,
		});

		keyboardStore.register({
			key: 'A',
			shift: true,
			description: 'Mark all as read',
			category: 'Article',
			action: params.markAllAsReadInCurrentFeed,
			condition: () => auth.isAuthenticated && !!feedViewStore.feedFilter,
		});
	}

	function unregister() {
		keyboardStore.unregister('j');
		keyboardStore.unregister('k');
		keyboardStore.unregister('ArrowDown');
		keyboardStore.unregister('ArrowUp');
		keyboardStore.unregister('o');
		keyboardStore.unregister('Enter');
		keyboardStore.unregister('s');
		keyboardStore.unregister('S', true);
		keyboardStore.unregister('m');
		keyboardStore.unregister('u');
		keyboardStore.unregister('A', true);
	}

	// Auto-cleanup on component destroy
	onDestroy(unregister);

	return {
		register,
		unregister,
	};
}
