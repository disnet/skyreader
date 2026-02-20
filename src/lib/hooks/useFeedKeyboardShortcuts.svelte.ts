import { onDestroy } from 'svelte';
import { tick } from 'svelte';
import { keyboardStore } from '$lib/stores/keyboard.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { sharesStore } from '$lib/stores/shares.svelte';
import type { Article, Subscription } from '$lib/types';

interface KeyboardShortcutsParams {
  scrollToCenter: () => void;
  markAllAsReadInCurrentFeed: () => Promise<void>;
  openBookmarkReader?: () => void;
  toggleAddFromUrl?: () => void;
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
    } else if (item.type === 'document') {
      url = item.item.canonicalUrl || item.item.path || '';
    } else if (item.type === 'bookmark') {
      url = item.item.url;
    } else {
      url = item.item.articleUrl;
    }
    if (url) {
      window.open(url, '_blank');
    }
  }

  // Toggle star on selected item (works for all item types)
  function toggleSelectedStar() {
    const selectedIndex = feedViewStore.selectedIndex;
    if (selectedIndex < 0) return;

    const items = feedViewStore.currentItems;
    const item = items[selectedIndex];
    if (!item) return;

    if (item.type === 'article') {
      itemLabelsStore.toggleStar(item.item.guid, 'article', item.item.url, item.item.title, {
        guid: item.item.guid,
        url: item.item.url,
        title: item.item.title,
        author: item.item.author,
        summary: item.item.summary,
        imageUrl: item.item.imageUrl,
        publishedAt: item.item.publishedAt,
      });
    } else if (item.type === 'userShare') {
      itemLabelsStore.toggleStar(
        item.article.guid,
        'article',
        item.article.url,
        item.article.title,
        {
          guid: item.article.guid,
          url: item.article.url,
          title: item.article.title,
          author: item.article.author,
          summary: item.article.summary,
          imageUrl: item.article.imageUrl,
          publishedAt: item.article.publishedAt,
        }
      );
    } else if (item.type === 'share') {
      itemLabelsStore.toggleStar(
        item.item.recordUri,
        'share',
        item.item.itemUrl,
        item.item.itemTitle
      );
    } else if (item.type === 'document') {
      itemLabelsStore.toggleStar(
        item.item.recordUri,
        'document',
        item.item.canonicalUrl || item.item.path || '',
        item.item.title
      );
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

      if (itemLabelsStore.isRead(article.guid)) {
        itemLabelsStore.markAsUnread(article.guid);
      } else {
        itemLabelsStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
      }
    } else if (item.type === 'share') {
      const share = item.item;
      if (itemLabelsStore.isSocialRead(share.recordUri)) {
        itemLabelsStore.markSocialAsUnread(share.recordUri);
      } else {
        feedViewStore.trackSeenThisSession(item);
        itemLabelsStore.markSocialAsRead(
          'share',
          share.recordUri,
          share.authorDid,
          share.itemUrl,
          share.itemTitle
        );
      }
    } else if (item.type === 'document') {
      const doc = item.item;
      if (itemLabelsStore.isSocialRead(doc.recordUri)) {
        itemLabelsStore.markSocialAsUnread(doc.recordUri);
      } else {
        feedViewStore.trackSeenThisSession(item);
        itemLabelsStore.markSocialAsRead(
          'document',
          doc.recordUri,
          doc.authorDid,
          doc.canonicalUrl || '',
          doc.title
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

    await tick();
    params.scrollToCenter();
  }

  async function selectPreviousItem() {
    const currentItems = feedViewStore.currentItems;
    const selectedIndex = feedViewStore.selectedIndex;
    if (currentItems.length === 0) return;

    feedViewStore.select(Math.max(selectedIndex - 1, 0));

    await tick();
    params.scrollToCenter();
  }

  function hasItems() {
    return auth.isAuthenticated && feedViewStore.currentItems.length > 0;
  }

  function hasSelected() {
    return auth.isAuthenticated && feedViewStore.selectedIndex >= 0;
  }

  // Toggle expand action (or open bookmark reader in bookmarks view)
  async function toggleExpand() {
    const selectedIndex = feedViewStore.selectedIndex;
    if (selectedIndex < 0) return;

    if (feedViewStore.starredFilter && params.openBookmarkReader) {
      params.openBookmarkReader();
      return;
    }

    const expandedIndex = feedViewStore.expandedIndex;
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
      key: 'k',
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

    keyboardStore.register({
      key: 't',
      description: 'Tag item',
      category: 'Article',
      action: () => {
        const idx = feedViewStore.selectedIndex;
        if (idx < 0) return;
        const item = feedViewStore.currentItems[idx];
        if (!item) return;
        if (feedViewStore.tagMenuItemKey === item.key) {
          feedViewStore.closeTagMenu();
        } else {
          feedViewStore.openTagMenu(item.key);
        }
      },
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

    // Bookmarks-specific: add article from URL
    keyboardStore.register({
      key: 'a',
      description: 'Add from URL',
      category: 'Article',
      action: () => params.toggleAddFromUrl?.(),
      condition: () => auth.isAuthenticated && !!feedViewStore.starredFilter,
    });

    // Bookmarks-specific: archive item (works for all item types)
    keyboardStore.register({
      key: 'e',
      description: 'Archive/unarchive bookmark',
      category: 'Article',
      action: () => {
        const idx = feedViewStore.selectedIndex;
        if (idx < 0) return;
        const item = feedViewStore.currentItems[idx];
        if (!item) return;
        const itemType = item.type === 'userShare' ? 'userShare' : item.type;
        itemLabelsStore.toggleArchive(
          item.key,
          itemType as 'article' | 'share' | 'document' | 'userShare'
        );
      },
      condition: () => hasSelected() && !!feedViewStore.starredFilter,
    });
  }

  function unregister() {
    keyboardStore.unregister('j');
    keyboardStore.unregister('k');
    keyboardStore.unregister('o');
    keyboardStore.unregister('Enter');
    keyboardStore.unregister('s');
    keyboardStore.unregister('S', true);
    keyboardStore.unregister('m');
    keyboardStore.unregister('t');
    keyboardStore.unregister('u');
    keyboardStore.unregister('A', true);
    keyboardStore.unregister('a');
    keyboardStore.unregister('e');
  }

  // Auto-cleanup on component destroy
  onDestroy(unregister);

  return {
    register,
    unregister,
  };
}
