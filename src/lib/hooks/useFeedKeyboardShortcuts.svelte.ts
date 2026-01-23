import { onDestroy } from 'svelte';
import { tick } from 'svelte';
import { keyboardStore } from '$lib/stores/keyboard.svelte';
import { auth } from '$lib/stores/auth.svelte';
import type { Article, SocialShare, CombinedFeedItem, UserShare, Subscription } from '$lib/types';

interface KeyboardShortcutsParams {
	// Getters for current state
	getCurrentItems: () => (Article | SocialShare | UserShare | CombinedFeedItem)[];
	getSelectedIndex: () => number;
	getExpandedIndex: () => number;
	getViewMode: () => 'articles' | 'shares' | 'userShares' | 'combined';
	getDisplayedArticles: () => Article[];
	getDisplayedShares: () => SocialShare[];
	getDisplayedCombined: () => CombinedFeedItem[];
	getDisplayedUserShares: () => UserShare[];
	getSubscriptions: () => Subscription[];
	getArticlesByGuid: () => Map<string, Article>;

	// Pagination state
	getCombinedHasMore: () => boolean;
	getArticlesHasMore: () => boolean;
	getSharesHasMore: () => boolean;

	// Filter state
	hasFeedFilter: () => boolean;
	hasStarredFilter: () => boolean;
	hasSharedFilter: () => boolean;

	// State setters
	selectItem: (index: number) => void;
	setExpandedIndex: (index: number) => void;

	// Scroll helper
	scrollToCenter: () => void;

	// Action callbacks
	loadMoreCombined: () => Promise<void>;
	loadMoreArticles: () => Promise<void>;
	loadMoreShares: () => Promise<void>;
	toggleStar: (guid: string, url: string, title: string) => void;
	share: (
		rkey: string,
		feedUrl: string,
		guid: string,
		url: string,
		title: string,
		author?: string,
		summary?: string,
		imageUrl?: string,
		publishedAt?: string
	) => void;
	unshare: (guid: string) => void;
	isShared: (guid: string) => boolean;
	markAsRead: (rkey: string, guid: string, url: string, title?: string) => void;
	markAsUnread: (guid: string) => void;
	isRead: (guid: string) => boolean;
	shareMarkAsRead: (uri: string, authorDid: string, url: string, title?: string) => void;
	shareMarkAsUnread: (uri: string) => void;
	shareIsRead: (uri: string) => boolean;
	markAllAsReadInCurrentFeed: () => Promise<void>;
	toggleUnreadFilter: () => void;
}

/**
 * Hook for feed keyboard shortcuts.
 * Registers and unregisters keyboard shortcuts for the feed page.
 */
export function useFeedKeyboardShortcuts(params: KeyboardShortcutsParams) {
	// Helper to get selected article info
	function getSelectedArticle(): {
		article: Article;
		sub: Subscription;
	} | null {
		const selectedIndex = params.getSelectedIndex();
		if (selectedIndex < 0) return null;
		const mode = params.getViewMode();

		if (mode === 'articles') {
			const article = params.getDisplayedArticles()[selectedIndex];
			if (!article) return null;
			const sub = params.getSubscriptions().find((s) => s.id === article.subscriptionId);
			if (!sub) return null;
			return { article, sub };
		} else if (mode === 'combined') {
			const feedItem = params.getDisplayedCombined()[selectedIndex];
			if (!feedItem || feedItem.type !== 'article') return null;
			const article = feedItem.item;
			const sub = params.getSubscriptions().find((s) => s.id === article.subscriptionId);
			if (!sub) return null;
			return { article, sub };
		} else if (mode === 'userShares') {
			const share = params.getDisplayedUserShares()[selectedIndex];
			if (!share) return null;
			const localArticle = params.getArticlesByGuid().get(share.articleGuid);
			if (localArticle) {
				const sub = params.getSubscriptions().find((s) => s.id === localArticle.subscriptionId);
				if (sub) return { article: localArticle, sub };
			}
			// For user shares without local article, create a minimal article object
			return {
				article: {
					guid: share.articleGuid,
					url: share.articleUrl,
					title: share.articleTitle || share.articleUrl,
					author: share.articleAuthor,
					summary: share.articleDescription,
					imageUrl: share.articleImage,
					publishedAt: share.articlePublishedAt || share.createdAt,
					subscriptionId: 0,
					fetchedAt: Date.now(),
				},
				sub: {
					rkey: '',
					feedUrl: share.feedUrl || '',
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

	// Open selected item in new tab
	function openSelectedItem() {
		const selectedIndex = params.getSelectedIndex();
		if (selectedIndex < 0) return;
		const items = params.getCurrentItems();
		const item = items[selectedIndex];
		const mode = params.getViewMode();
		let url: string;
		if (mode === 'combined') {
			const combined = item as CombinedFeedItem;
			url = combined.type === 'article' ? combined.item.url : combined.item.itemUrl;
		} else if (mode === 'shares') {
			url = (item as SocialShare).itemUrl;
		} else if (mode === 'userShares') {
			url = (item as UserShare).articleUrl;
		} else {
			url = (item as Article).url;
		}
		window.open(url, '_blank');
	}

	// Toggle star on selected item
	function toggleSelectedStar() {
		const selected = getSelectedArticle();
		if (selected) {
			params.toggleStar(selected.article.guid, selected.article.url, selected.article.title);
		}
	}

	// Share/unshare selected item
	function toggleSelectedShare() {
		const selected = getSelectedArticle();
		if (!selected) return;

		const { article, sub } = selected;
		if (params.isShared(article.guid)) {
			params.unshare(article.guid);
		} else {
			params.share(
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
		const selectedIndex = params.getSelectedIndex();
		if (selectedIndex < 0) return;
		const mode = params.getViewMode();

		if (mode === 'articles') {
			const article = params.getDisplayedArticles()[selectedIndex];
			if (!article) return;
			const sub = params.getSubscriptions().find((s) => s.id === article.subscriptionId);
			if (!sub) return;

			if (params.isRead(article.guid)) {
				params.markAsUnread(article.guid);
			} else {
				params.markAsRead(sub.rkey, article.guid, article.url, article.title);
			}
		} else if (mode === 'combined') {
			const feedItem = params.getDisplayedCombined()[selectedIndex];
			if (!feedItem) return;

			if (feedItem.type === 'article') {
				const article = feedItem.item;
				const sub = params.getSubscriptions().find((s) => s.id === article.subscriptionId);
				if (!sub) return;

				if (params.isRead(article.guid)) {
					params.markAsUnread(article.guid);
				} else {
					params.markAsRead(sub.rkey, article.guid, article.url, article.title);
				}
			} else {
				const share = feedItem.item;
				if (params.shareIsRead(share.recordUri)) {
					params.shareMarkAsUnread(share.recordUri);
				} else {
					params.shareMarkAsRead(share.recordUri, share.authorDid, share.itemUrl, share.itemTitle);
				}
			}
		} else if (mode === 'shares') {
			const share = params.getDisplayedShares()[selectedIndex];
			if (!share) return;

			if (params.shareIsRead(share.recordUri)) {
				params.shareMarkAsUnread(share.recordUri);
			} else {
				params.shareMarkAsRead(share.recordUri, share.authorDid, share.itemUrl, share.itemTitle);
			}
		}
	}

	function register() {
		// Navigation shortcuts
		keyboardStore.register({
			key: 'j',
			description: 'Next item',
			category: 'Navigation',
			action: async () => {
				const currentItems = params.getCurrentItems();
				const selectedIndex = params.getSelectedIndex();
				if (currentItems.length > 0) {
					const nextIndex = Math.min(selectedIndex + 1, currentItems.length - 1);
					params.selectItem(nextIndex);

					// If we're at the last item, try to load more
					if (nextIndex === currentItems.length - 1) {
						const viewMode = params.getViewMode();
						if (viewMode === 'combined' && params.getCombinedHasMore()) {
							await params.loadMoreCombined();
						} else if (viewMode === 'articles' && params.getArticlesHasMore()) {
							await params.loadMoreArticles();
						} else if (viewMode === 'shares' && params.getSharesHasMore()) {
							await params.loadMoreShares();
						}
					}
				}
			},
			condition: () => auth.isAuthenticated && params.getCurrentItems().length > 0,
		});

		keyboardStore.register({
			key: 'ArrowDown',
			description: 'Next item',
			category: 'Navigation',
			action: async () => {
				const currentItems = params.getCurrentItems();
				const selectedIndex = params.getSelectedIndex();
				if (currentItems.length > 0) {
					const nextIndex = Math.min(selectedIndex + 1, currentItems.length - 1);
					params.selectItem(nextIndex);

					// If we're at the last item, try to load more
					if (nextIndex === currentItems.length - 1) {
						const viewMode = params.getViewMode();
						if (viewMode === 'combined' && params.getCombinedHasMore()) {
							await params.loadMoreCombined();
						} else if (viewMode === 'articles' && params.getArticlesHasMore()) {
							await params.loadMoreArticles();
						} else if (viewMode === 'shares' && params.getSharesHasMore()) {
							await params.loadMoreShares();
						}
					}
				}
			},
			condition: () => auth.isAuthenticated && params.getCurrentItems().length > 0,
		});

		keyboardStore.register({
			key: 'k',
			description: 'Previous item',
			category: 'Navigation',
			action: () => {
				const currentItems = params.getCurrentItems();
				const selectedIndex = params.getSelectedIndex();
				if (currentItems.length > 0) {
					params.selectItem(Math.max(selectedIndex - 1, 0));
				}
			},
			condition: () => auth.isAuthenticated && params.getCurrentItems().length > 0,
		});

		keyboardStore.register({
			key: 'ArrowUp',
			description: 'Previous item',
			category: 'Navigation',
			action: () => {
				const currentItems = params.getCurrentItems();
				const selectedIndex = params.getSelectedIndex();
				if (currentItems.length > 0) {
					params.selectItem(Math.max(selectedIndex - 1, 0));
				}
			},
			condition: () => auth.isAuthenticated && params.getCurrentItems().length > 0,
		});

		keyboardStore.register({
			key: 'o',
			description: 'Open in new tab',
			category: 'Navigation',
			action: openSelectedItem,
			condition: () => auth.isAuthenticated && params.getSelectedIndex() >= 0,
		});

		keyboardStore.register({
			key: 'Enter',
			description: 'Toggle expand',
			category: 'Navigation',
			action: async () => {
				const selectedIndex = params.getSelectedIndex();
				const expandedIndex = params.getExpandedIndex();
				if (selectedIndex >= 0) {
					if (expandedIndex === selectedIndex) {
						params.setExpandedIndex(-1);
						await tick();
						params.scrollToCenter();
					} else {
						params.setExpandedIndex(selectedIndex);
						await tick();
						params.scrollToCenter();
					}
				}
			},
			condition: () => auth.isAuthenticated && params.getSelectedIndex() >= 0,
		});

		// Article action shortcuts
		keyboardStore.register({
			key: 's',
			description: 'Toggle star',
			category: 'Article',
			action: toggleSelectedStar,
			condition: () => auth.isAuthenticated && params.getSelectedIndex() >= 0,
		});

		keyboardStore.register({
			key: 'S',
			shift: true,
			description: 'Share/unshare',
			category: 'Article',
			action: toggleSelectedShare,
			condition: () => auth.isAuthenticated && params.getSelectedIndex() >= 0,
		});

		keyboardStore.register({
			key: 'm',
			description: 'Mark read/unread',
			category: 'Article',
			action: toggleSelectedRead,
			condition: () => auth.isAuthenticated && params.getSelectedIndex() >= 0,
		});

		// Other shortcuts
		keyboardStore.register({
			key: 'u',
			description: 'Toggle unread filter',
			category: 'Other',
			action: params.toggleUnreadFilter,
			condition: () =>
				auth.isAuthenticated && !params.hasStarredFilter() && !params.hasSharedFilter(),
		});

		keyboardStore.register({
			key: 'A',
			shift: true,
			description: 'Mark all as read',
			category: 'Article',
			action: params.markAllAsReadInCurrentFeed,
			condition: () => auth.isAuthenticated && params.hasFeedFilter(),
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
