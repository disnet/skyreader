import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import { readingStore } from './reading.svelte';
import { shareReadingStore } from './shareReading.svelte';
import { socialReadingStore } from './socialReading.svelte';
import { sharesStore } from './shares.svelte';
import { socialStore } from './social.svelte';
import { preferences } from './preferences.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { tagsStore } from './tags.svelte';
import type { Article, SocialShare, SocialDocument, CombinedFeedItem, UserShare } from '$lib/types';
import {
  isRssSource,
  isSharesSource,
  isDocumentsSource,
  getRssSubscriptionId,
  getSourceDid,
  migrateLegacyView,
} from '$lib/utils/sourceKeys';

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
  sourceMode: 'all' | 'include';
  sourceKeys: string[];
  readFilter: 'all' | 'unread' | 'read';
  sortOrder: 'newest' | 'oldest';
}

/**
 * Derive allowed RSS subscription IDs from effective filters.
 * Returns null if all RSS sources are allowed.
 */
function deriveAllowedRssIds(fv: EffectiveFilters): Set<number> | null {
  if (fv.sourceMode === 'all') return null;

  const ids = new Set<number>();
  for (const key of fv.sourceKeys) {
    if (isRssSource(key)) ids.add(getRssSubscriptionId(key));
  }
  return ids;
}

/**
 * Derive allowed DIDs for a given account source kind.
 * Returns null if all DIDs are allowed for that kind.
 */
function deriveAllowedDids(
  fv: EffectiveFilters,
  kindTest: (key: string) => boolean
): Set<string> | null {
  if (fv.sourceMode === 'all') return null;

  const dids = new Set<string>();
  for (const key of fv.sourceKeys) {
    if (kindTest(key)) dids.add(getSourceDid(key));
  }
  return dids;
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

  // Tag menu state (which item key should show the tag menu, null = closed)
  let tagMenuItemKey = $state<string | null>(null);

  // Toolbar filter state (unified source model)
  let filterToolbarOpen = $state(false);
  let sourcePopoverOpen = $state(false);
  let toolbarSourceMode = $state<'all' | 'include'>('all');
  let toolbarSourceKeys = $state<string[]>([]);
  // View-local sort order override (null = use global preferences.sortOrder)
  let toolbarSortOrder = $state<'newest' | 'oldest' | null>(null);
  // Tag filter (empty = no tag filter)
  let toolbarTagFilter = $state<string[]>([]);

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

  // Helper to get current subscription IDs and follow DIDs for migration
  function getAllSubIds(): number[] {
    return subscriptionsStore.subscriptions
      .map((s) => s.id)
      .filter((id): id is number => id != null);
  }

  function getAllFollowDids(): string[] {
    return socialStore.inAppFollows.map((f) => f.did);
  }

  // Derived: effective filters (always uses toolbar state as the working copy)
  let effectiveFilters = $derived.by((): EffectiveFilters => {
    return {
      sourceMode: toolbarSourceMode,
      sourceKeys: toolbarSourceKeys,
      readFilter: showOnlyUnread ? 'unread' : 'all',
      sortOrder: toolbarSortOrder ?? preferences.sortOrder,
    };
  });

  // Derived: whether any toolbar filter differs from defaults
  let hasActiveFilters = $derived.by(() => {
    if (activeFilteredView) return true;
    return toolbarSourceMode !== 'all';
  });

  // Derived: whether toolbar state differs from the persisted saved view
  let hasUnsavedChanges = $derived.by(() => {
    if (!activeFilteredView) return false;
    const view = activeFilteredView;
    const savedMode = view.sourceMode === 'all' ? 'all' : 'include';
    const savedKeys = new Set(view.sourceKeys ?? []);
    const currentReadFilter = showOnlyUnread ? 'unread' : 'all';
    const currentSortOrder = toolbarSortOrder ?? preferences.sortOrder;

    if (toolbarSourceMode !== savedMode) return true;
    if (currentReadFilter !== view.readFilter) return true;
    if (currentSortOrder !== view.sortOrder) return true;
    if (toolbarSourceKeys.length !== savedKeys.size) return true;
    for (const key of toolbarSourceKeys) {
      if (!savedKeys.has(key)) return true;
    }
    return false;
  });

  // Derived: view mode
  let viewMode = $derived.by((): ViewMode => {
    if (activeFilteredView) return 'combined';
    if (sharedFilter) return 'userShares';
    if (sharerFilter || followingFilter) return 'shares';
    if (feedFilter || starredFilter || feedsFilter) return 'articles';
    return 'combined';
  });

  // Track items that were read during this view session to keep them visible
  // These are cleared when switching views/feeds
  let readArticleGuidsThisSession = $state<Set<string>>(new Set());
  let readShareUrisThisSession = $state<Set<string>>(new Set());
  let readDocumentUrisThisSession = $state<Set<string>>(new Set());

  // Derived: whether articles are shown (any RSS source allowed)
  let showArticles = $derived.by((): boolean => {
    const fv = effectiveFilters;
    if (fv.sourceMode === 'all') return true;
    return fv.sourceKeys.some(isRssSource);
  });

  // Derived: whether shares are shown (any shares source allowed)
  let showShares = $derived.by((): boolean => {
    const fv = effectiveFilters;
    if (fv.sourceMode === 'all') return true;
    return fv.sourceKeys.some(isSharesSource);
  });

  // Derived: whether documents are shown (any documents source allowed)
  let showDocuments = $derived.by((): boolean => {
    const fv = effectiveFilters;
    if (fv.sourceMode === 'all') return true;
    return fv.sourceKeys.some(isDocumentsSource);
  });

  // Derived: filtered articles based on current filters
  let filteredArticles = $derived.by((): Article[] => {
    const fv = effectiveFilters;

    // If no articles are allowed by source filter, return empty
    if (!showArticles) return [];

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

      // Filter by subscription (URL filter)
      if (feedFilter) {
        const feedId = parseInt(feedFilter);
        articles = articles.filter((a) => a.subscriptionId === feedId);
      }

      // Apply source-based RSS filtering
      const allowedIds = deriveAllowedRssIds(fv);
      if (allowedIds !== null) {
        articles = articles.filter((a) => allowedIds.has(a.subscriptionId));
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

    // If shares are not shown by source filter, return empty
    if (!showShares) return [];

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

    // Apply source-based DID filtering for shares
    const allowedDids = deriveAllowedDids(fv, isSharesSource);
    if (allowedDids !== null) {
      filtered = filtered.filter((s) => allowedDids.has(s.authorDid));
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

    // If documents are not shown by source filter, return empty
    if (!showDocuments) return [];

    // Return empty if contentTypeFilter is 'shares'
    if (contentTypeFilter === 'shares') return [];

    const docs = socialStore.documents;
    const sortOrder = fv.sortOrder;

    let filtered = [...docs];

    // Filter by author if sharerFilter is set
    if (sharerFilter) {
      filtered = filtered.filter((d) => d.authorDid === sharerFilter);
    }

    // Apply source-based DID filtering for documents
    const allowedDids = deriveAllowedDids(fv, isDocumentsSource);
    if (allowedDids !== null) {
      filtered = filtered.filter((d) => allowedDids.has(d.authorDid));
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
  // When there are more articles to load, social items are limited to the date range
  // of currently loaded articles. This prevents old social items (e.g. from a year ago)
  // from dominating the tail of the list while there are plenty of unloaded articles
  // that should fill the gap. As more articles load, the date range expands and more
  // social items become visible.
  let displayedCombined = $derived.by((): CombinedFeedItem[] => {
    if (viewMode !== 'combined') return [];

    const fv = effectiveFilters;
    const sortOrder = fv.sortOrder;
    const hasMoreArticlesToLoad = loadedArticleCount < filteredArticles.length;

    let sharesToInclude = displayedShares;
    let documentsToInclude = displayedDocuments;

    if (hasMoreArticlesToLoad && displayedArticles.length > 0) {
      // Find the oldest displayed article's date based on sort order.
      // filteredArticles (and thus displayedArticles) are sorted newest-first by default.
      const oldestArticle =
        sortOrder === 'newest'
          ? displayedArticles[displayedArticles.length - 1]
          : displayedArticles[0];
      const cutoffTime = new Date(oldestArticle.publishedAt).getTime();

      sharesToInclude = displayedShares.filter(
        (s) => new Date(s.itemPublishedAt || s.createdAt).getTime() >= cutoffTime
      );
      documentsToInclude = displayedDocuments.filter(
        (d) => new Date(d.publishedAt).getTime() >= cutoffTime
      );
    }

    const combined: CombinedFeedItem[] = [
      ...displayedArticles.map((item) => ({
        type: 'article' as const,
        item,
        date: item.publishedAt,
      })),
      ...sharesToInclude.map((item) => ({
        type: 'share' as const,
        item,
        date: item.itemPublishedAt || item.createdAt,
      })),
      ...documentsToInclude.map((item) => ({
        type: 'document' as const,
        item,
        date: item.publishedAt,
      })),
    ];

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
    let items: FeedDisplayItem[];

    if (mode === 'combined') {
      items = displayedCombined.map((item) => {
        if (item.type === 'article') {
          return { type: 'article' as const, item: item.item, key: item.item.guid };
        } else if (item.type === 'share') {
          return { type: 'share' as const, item: item.item, key: item.item.recordUri };
        } else {
          return { type: 'document' as const, item: item.item, key: item.item.recordUri };
        }
      });
    } else if (mode === 'shares') {
      // Combine shares and documents, sorted by date
      const sortOrder = preferences.sortOrder;
      type ItemWithDate = FeedDisplayItem & { date: number };
      const rawItems: ItemWithDate[] = [
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

      rawItems.sort((a, b) => {
        const diff = b.date - a.date;
        return sortOrder === 'newest' ? diff : -diff;
      });

      items = rawItems.map(({ type, item, key }) => ({ type, item, key }) as FeedDisplayItem);
    } else if (mode === 'userShares') {
      items = displayedUserShares.map((share) => {
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
    } else {
      // articles mode
      items = displayedArticles.map((item) => ({
        type: 'article' as const,
        item,
        key: item.guid,
      }));
    }

    // Apply tag filter
    if (toolbarTagFilter.length > 0) {
      // Access tagsByItem for reactivity
      const _tags = tagsStore.tagsByItem;
      items = items.filter((item) => tagsStore.itemHasAnyTag(item.key, toolbarTagFilter));
    }

    return items;
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
      sourceMode: toolbarSourceMode,
      sourceKeys: [...toolbarSourceKeys],
      readFilter: showOnlyUnread ? 'unread' : 'all',
      sortOrder: toolbarSortOrder ?? preferences.sortOrder,
      tagFilter: toolbarTagFilter.length > 0 ? [...toolbarTagFilter] : undefined,
    });
  }

  function resetToolbarFilters() {
    toolbarSourceMode = 'all';
    toolbarSourceKeys = [];
    toolbarSortOrder = null;
    toolbarTagFilter = [];
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

  // Bulk-track items as read this session so they stay visible in unread filter
  function trackItemsAsReadThisSession(
    articleGuids: string[],
    shareUris: string[],
    documentUris: string[]
  ) {
    if (articleGuids.length > 0) {
      for (const guid of articleGuids) readArticleGuidsThisSession.add(guid);
      readArticleGuidsThisSession = new Set(readArticleGuidsThisSession);
    }
    if (shareUris.length > 0) {
      for (const uri of shareUris) readShareUrisThisSession.add(uri);
      readShareUrisThisSession = new Set(readShareUrisThisSession);
    }
    if (documentUris.length > 0) {
      for (const uri of documentUris) readDocumentUrisThisSession.add(uri);
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
    get sourcePopoverOpen() {
      return sourcePopoverOpen;
    },
    get hasActiveFilters() {
      return hasActiveFilters;
    },
    get hasUnsavedChanges() {
      return hasUnsavedChanges;
    },
    get toolbarTagFilter() {
      return toolbarTagFilter;
    },
    get currentSortOrder() {
      return toolbarSortOrder ?? preferences.sortOrder;
    },
    get tagMenuItemKey() {
      return tagMenuItemKey;
    },

    // All filtered items (not paginated) — for bulk operations like mark-all-as-read
    get filteredArticles() {
      return filteredArticles;
    },
    get displayedShares() {
      return displayedShares;
    },
    get displayedDocuments() {
      return displayedDocuments;
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
    trackItemsAsReadThisSession,
    setShowOnlyUnread(value: boolean) {
      showOnlyUnread = value;
    },
    setFilterToolbarOpen(open: boolean) {
      filterToolbarOpen = open;
    },
    setSourcePopoverOpen(open: boolean) {
      sourcePopoverOpen = open;
    },
    setToolbarTagFilter(tags: string[]) {
      toolbarTagFilter = tags;
    },
    setToolbarSourceFilter(mode: 'all' | 'include', keys: string[]) {
      toolbarSourceMode = mode;
      toolbarSourceKeys = keys;
    },
    toggleSortOrder() {
      if (viewFilter) {
        const current = toolbarSortOrder ?? preferences.sortOrder;
        toolbarSortOrder = current === 'newest' ? 'oldest' : 'newest';
      } else {
        preferences.toggleSortOrder();
      }
    },
    resetToolbarFilters,
    syncToolbarToSavedView,
    openTagMenu(itemKey: string) {
      tagMenuItemKey = itemKey;
    },
    closeTagMenu() {
      tagMenuItemKey = null;
    },
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
          if (fv.sourceMode != null) {
            // New format (coerce any stale 'exclude' to 'include')
            toolbarSourceMode = fv.sourceMode === 'all' ? 'all' : 'include';
            toolbarSourceKeys = toolbarSourceMode === 'all' ? [] : [...(fv.sourceKeys ?? [])];
          } else {
            // Legacy format — migrate
            const migrated = migrateLegacyView(
              {
                showArticles: fv.showArticles,
                showShares: fv.showShares,
                showDocuments: fv.showDocuments,
                feedMode: fv.feedMode,
                feedIds: fv.feedIds,
                accountMode: fv.accountMode,
                accountDids: fv.accountDids,
              },
              getAllSubIds(),
              getAllFollowDids()
            );
            toolbarSourceMode = migrated.sourceMode;
            toolbarSourceKeys = migrated.sourceKeys;
          }
          showOnlyUnread = fv.readFilter === 'unread';
          toolbarSortOrder = fv.sortOrder;
          toolbarTagFilter = fv.tagFilter ? [...fv.tagFilter] : [];
          // Fire-and-forget legacy migration write-back
          if (fv.sourceMode == null && fv.id != null) {
            filteredViewsStore.update(fv.id, {
              sourceMode: toolbarSourceMode,
              sourceKeys: [...toolbarSourceKeys],
            });
          }
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
