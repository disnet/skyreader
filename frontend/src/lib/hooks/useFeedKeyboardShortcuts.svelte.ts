import { onDestroy } from 'svelte';
import { tick } from 'svelte';
import { keyboardStore } from '$lib/stores/keyboard.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { linkblogStore } from '$lib/stores/linkblog.svelte';
import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
import { preferences } from '$lib/stores/preferences.svelte';
import type { Article, Subscription } from '$lib/types';

interface KeyboardShortcutsParams {
  scrollToCenter: () => void;
  markAllAsReadInCurrentFeed: () => Promise<void>;
  openSavedReader?: () => void;
  openFullscreenReader?: () => void;
  toggleHighlight?: () => void;
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
    }
    return null;
  }

  // Helper to get subscription for an article
  function getSubscriptionForArticle(article: Article): Subscription | undefined {
    return subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
  }

  // Helper to resolve the currently-selected item by key. Returns null when
  // nothing is selected or the previously-selected item is no longer present.
  function getSelectedItem(): FeedDisplayItem | null {
    const key = feedViewStore.selectedKey;
    if (key === null) return null;
    return feedViewStore.currentItems.find((i) => i.key === key) ?? null;
  }

  // Helper to get selected article info
  function getSelectedArticle(): {
    article: Article;
    sub: Subscription;
  } | null {
    const item = getSelectedItem();
    if (!item) return null;

    const article = getArticleFromItem(item);
    if (!article) return null;

    const sub = getSubscriptionForArticle(article);
    if (!sub) return null;

    return { article, sub };
  }

  // Open selected item in new tab
  function openSelectedItem() {
    const item = getSelectedItem();
    if (!item) return;

    let url: string;
    if (item.type === 'article') {
      url = item.item.url;
    } else if (item.type === 'document') {
      url = item.item.canonicalUrl || item.item.path || '';
    } else {
      url = item.item.url;
    }
    if (url) {
      window.open(url, '_blank');
    }
  }

  // Toggle save on selected item (works for all item types)
  function toggleSelectedSave() {
    const item = getSelectedItem();
    if (!item) return;

    if (item.type === 'article') {
      itemLabelsStore.toggleSave(item.item.guid, 'article', item.item.url, item.item.title, {
        type: 'article',
        guid: item.item.guid,
        url: item.item.url,
        title: item.item.title,
        author: item.item.author,
        summary: item.item.summary,
        imageUrl: item.item.imageUrl,
        publishedAt: item.item.publishedAt,
      });
    } else if (item.type === 'document') {
      itemLabelsStore.toggleSave(
        item.item.recordUri,
        'document',
        item.item.canonicalUrl || item.item.path || '',
        item.item.title,
        {
          type: 'document',
          recordUri: item.item.recordUri,
          url: item.item.canonicalUrl || item.item.path || '',
          title: item.item.title,
          description: item.item.description,
          publishedAt: item.item.publishedAt,
        }
      );
    }
  }

  // Fetch the full original article for the selected item and show it inline,
  // replacing the RSS excerpt (the same path the end-of-body affordance uses).
  // Article items only; the extract cache dedupes/caches per URL.
  function fetchSelectedOriginal() {
    const item = getSelectedItem();
    if (!item || item.type !== 'article' || !item.item.url) return;
    linkPostContentStore.fetch(item.item.url);
    // Expand so the fetched (longer) body shows rather than the clamped excerpt.
    if (feedViewStore.expandedKey !== item.key) {
      const idx = feedViewStore.currentItems.findIndex((i) => i.key === item.key);
      if (idx >= 0) feedViewStore.expand(idx);
    }
  }

  // Share/unshare selected item to the linkblog (article items only)
  function toggleSelectedShare() {
    if (preferences.linkblogDisabled) return;
    const selected = getSelectedArticle();
    if (!selected) return;

    const { article } = selected;
    if (linkblogStore.isShared(article.url)) {
      linkblogStore.unshare(article.url);
    } else {
      linkblogStore.shareLink(article);
    }
  }

  // Toggle read/unread on selected item
  function toggleSelectedRead() {
    const item = getSelectedItem();
    if (!item) return;

    if (item.type === 'article') {
      const article = item.item;
      const sub = getSubscriptionForArticle(article);
      if (!sub) return;

      if (itemLabelsStore.isRead(article.guid)) {
        itemLabelsStore.markAsUnread(article.guid);
      } else {
        itemLabelsStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
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
    if (currentItems.length === 0) return;

    const selectedKey = feedViewStore.selectedKey;
    const currentIndex =
      selectedKey === null ? -1 : currentItems.findIndex((i) => i.key === selectedKey);
    const nextIndex = Math.min(currentIndex + 1, currentItems.length - 1);
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
    if (currentItems.length === 0) return;

    const selectedKey = feedViewStore.selectedKey;
    const currentIndex =
      selectedKey === null ? -1 : currentItems.findIndex((i) => i.key === selectedKey);
    feedViewStore.select(Math.max(currentIndex - 1, 0));

    await tick();
    params.scrollToCenter();
  }

  function hasItems() {
    return auth.isAuthenticated && feedViewStore.currentItems.length > 0;
  }

  function hasSelected() {
    return auth.isAuthenticated && feedViewStore.selectedKey !== null;
  }

  // Toggle expand action (or open bookmark reader in bookmarks view)
  async function toggleExpand() {
    const selectedKey = feedViewStore.selectedKey;
    if (selectedKey === null) return;

    if (feedViewStore.savedFilter && params.openSavedReader) {
      params.openSavedReader();
      return;
    }

    if (feedViewStore.expandedKey === selectedKey) {
      feedViewStore.collapse();
    } else {
      const idx = feedViewStore.currentItems.findIndex((i) => i.key === selectedKey);
      if (idx >= 0) feedViewStore.expand(idx);
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
      description: 'Toggle save',
      category: 'Article',
      action: toggleSelectedSave,
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
        const item = getSelectedItem();
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
      condition: () => auth.isAuthenticated && !feedViewStore.savedFilter,
    });

    keyboardStore.register({
      key: 'A',
      shift: true,
      description: 'Mark all as read',
      category: 'Article',
      action: params.markAllAsReadInCurrentFeed,
      condition: () => auth.isAuthenticated && !!feedViewStore.feedFilter,
    });

    // Bookmarks-specific: archive item (works for all item types)
    keyboardStore.register({
      key: 'e',
      description: 'Archive/unarchive saved item',
      category: 'Article',
      action: () => {
        const item = getSelectedItem();
        if (!item) return;
        itemLabelsStore.toggleArchive(item.key, item.type);
      },
      condition: () => hasSelected() && !!feedViewStore.savedFilter,
    });

    // Highlight current paragraph when expanded
    keyboardStore.register({
      key: 'h',
      description: 'Toggle highlight on paragraph',
      category: 'Article',
      action: () => params.toggleHighlight?.(),
      condition: () => hasSelected() && feedViewStore.expandedKey !== null,
    });

    // Full-screen reader for feed items (not in bookmarks view, which uses Enter)
    keyboardStore.register({
      key: 'f',
      description: 'Read in full screen',
      category: 'Navigation',
      action: () => params.openFullscreenReader?.(),
      condition: () => hasSelected() && !feedViewStore.savedFilter,
    });

    // Fetch the full original article (pairs with 'f'). Article items only.
    keyboardStore.register({
      key: 'F',
      shift: true,
      description: 'Fetch full article',
      category: 'Article',
      action: fetchSelectedOriginal,
      condition: () => {
        const item = getSelectedItem();
        return auth.isAuthenticated && item?.type === 'article' && !!item.item.url;
      },
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
    keyboardStore.unregister('x');
    keyboardStore.unregister('h');
    keyboardStore.unregister('f');
    keyboardStore.unregister('F', true);
  }

  // Auto-cleanup on component destroy
  onDestroy(unregister);

  return {
    register,
    unregister,
  };
}
