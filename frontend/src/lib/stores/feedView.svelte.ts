import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { socialStore } from './social.svelte';
import { savesStore } from './saves.svelte';
import { preferences } from './preferences.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { liveDb } from '$lib/services/liveDb.svelte';
import type {
  Article,
  SocialDocument,
  CombinedFeedItem,
  SavedItem,
  SubscriptionSourceType,
  SavedSourceType,
  DateAddedPreset,
  ReadingLengthFilter,
  SortOrder,
} from '$lib/types';
import {
  isRssSource,
  isDocumentsSource,
  getRssSubscriptionRkey,
  getSourceDid,
  migrateLegacyView,
} from '$lib/utils/sourceKeys';

export type ViewMode = 'articles' | 'shares' | 'combined';

/**
 * Unified feed item type for rendering - wraps all item types with common metadata
 */
export type FeedDisplayItem =
  | { type: 'article'; item: Article; key: string }
  | { type: 'document'; item: SocialDocument; key: string }
  | { type: 'saved'; item: SavedItem; key: string };

const DEFAULT_PAGE_SIZE = 50;

export interface EffectiveFilters {
  sourceMode: 'all' | 'include';
  sourceKeys: string[];
  readFilter: 'all' | 'unread' | 'read';
  sortOrder: SortOrder;
  typeFilter: SubscriptionSourceType[];
}

/**
 * Derive allowed RSS subscription IDs from effective filters.
 * Converts rkeys in sourceKeys to Dexie IDs for article filtering.
 * Returns null if all RSS sources are allowed.
 */
function deriveAllowedRssIds(fv: EffectiveFilters): Set<number> | null {
  if (fv.sourceMode === 'all') return null;

  const ids = new Set<number>();
  for (const key of fv.sourceKeys) {
    if (isRssSource(key)) {
      const rkey = getRssSubscriptionRkey(key);
      const sub = subscriptionsStore.getByRkey(rkey);
      if (sub?.id != null) ids.add(sub.id);
    }
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
function getItemDate(item: FeedDisplayItem): number {
  if (item.type === 'article') {
    return new Date(item.item.publishedAt).getTime();
  } else if (item.type === 'document') {
    return new Date(item.item.publishedAt).getTime();
  } else {
    return new Date(item.item.savedAt).getTime();
  }
}

export function getSavedDate(item: FeedDisplayItem): number {
  if (item.type === 'saved') {
    return new Date(item.item.savedAt).getTime();
  }
  const savedItem = savesStore.getByGuid(item.key);
  if (savedItem) {
    return new Date(savedItem.savedAt).getTime();
  }
  return getItemDate(item);
}

function getItemPublishedDate(item: FeedDisplayItem): number {
  if (item.type === 'saved') {
    return item.item.publishedAt
      ? new Date(item.item.publishedAt).getTime()
      : new Date(item.item.savedAt).getTime();
  }
  return getItemDate(item);
}

export function getItemWordCount(item: FeedDisplayItem): number | null {
  if (item.type === 'saved') return item.item.wordCount;
  if (item.type === 'article') {
    const text = item.item.content || item.item.summary || '';
    return text ? text.split(/\s+/).length : null;
  }
  if (item.type === 'document') {
    const text = item.item.textContent || item.item.description || '';
    return text ? text.split(/\s+/).length : null;
  }
  return null;
}

export function getItemDomain(item: FeedDisplayItem): string | null {
  if (item.type === 'saved') return item.item.domain;
  const url =
    item.type === 'article'
      ? item.item.url
      : item.type === 'document'
        ? item.item.canonicalUrl || item.item.path
        : null;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function datePresetToMs(preset: DateAddedPreset): number {
  const DAY = 86400000;
  switch (preset) {
    case 'last-week':
      return Date.now() - 7 * DAY;
    case 'last-month':
      return Date.now() - 30 * DAY;
    case 'last-3-months':
      return Date.now() - 90 * DAY;
    case 'last-year':
      return Date.now() - 365 * DAY;
  }
}

const WPM = 200;
export function matchesReadingLength(wc: number | null, bucket: ReadingLengthFilter): boolean {
  if (wc === null) return false;
  const minutes = wc / WPM;
  switch (bucket) {
    case 'quick':
      return minutes < 5;
    case 'medium':
      return minutes >= 5 && minutes < 15;
    case 'long':
      return minutes >= 15;
  }
}

function createFeedViewStore() {
  // UI state
  let showOnlyUnread = $state(true);
  // Track selection/expansion by item key (stable across refreshes) rather than
  // by array index — list refreshes re-sort items so an index would point at a
  // different item after a refresh.
  let selectedKey = $state<string | null>(null);
  let expandedKey = $state<string | null>(null);
  let loadedArticleCount = $state(DEFAULT_PAGE_SIZE);

  // Tag menu state (which item key should show the tag menu, null = closed)
  let tagMenuItemKey = $state<string | null>(null);

  // Mobile scroll-hide state for floating controls
  let mobileControlsVisible = $state(true);

  // Toolbar filter state (unified source model)
  let filterToolbarOpen = $state(false);
  let sourcePopoverOpen = $state(false);
  let toolbarSourceMode = $state<'all' | 'include'>('all');
  let toolbarSourceKeys = $state<string[]>([]);
  // View-local sort order override (null = use global preferences.sortOrder)
  let toolbarSortOrder = $state<SortOrder | null>(null);
  // Tag filter (empty = no tag filter)
  let toolbarTagFilter = $state<string[]>([]);
  // Type filter (empty = all types shown)
  let toolbarTypeFilter = $state<SubscriptionSourceType[]>([]);
  // Saved source filter (for saved-mode channels: url, feed, document)
  let toolbarSavedSourceFilter = $state<SavedSourceType[]>([]);
  // Saved channel: date added filter
  let toolbarDateFilter = $state<DateAddedPreset | null>(null);
  // Saved channel: reading length filter (multi-select)
  let toolbarReadingLength = $state<ReadingLengthFilter[]>([]);
  // Saved channel: domain filter (list of domains to include)
  let toolbarDomainFilter = $state<string[]>([]);

  // Bookmarks view sub-filter (inbox vs archive)
  let savedView = $state<'inbox' | 'archive'>('inbox');

  // URL filters (set by component from $page store)
  let feedFilter = $state<string | null>(null);
  let savedFilter = $state<string | null>(null);
  let sharerFilter = $state<string | null>(null);
  let followingFilter = $state<string | null>(null);
  let feedsFilter = $state<string | null>(null); // deprecated, kept for setFilters compat
  let contentTypeFilter = $state<'documents' | null>(null);
  let viewFilter = $state<string | null>(null);
  let categoryFilter = $state<string | null>(null);

  // Derived: subscription IDs that belong to the selected category
  let categorySubscriptionIds = $derived.by(() => {
    if (!categoryFilter) return null;
    const ids = new Set<number>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.category === categoryFilter && sub.id) {
        ids.add(sub.id);
      }
    }
    return ids;
  });

  // Derived: active filtered view (looked up by uuid, with fallback to Dexie id for old bookmarks)
  let activeFilteredView = $derived.by(() => {
    if (!viewFilter) return null;
    // Try uuid first, fall back to numeric Dexie id for old bookmarks
    const byUuid = filteredViewsStore.getByUuid(viewFilter);
    if (byUuid) return byUuid;
    const asNum = parseInt(viewFilter, 10);
    if (!isNaN(asNum)) return filteredViewsStore.getById(asNum) ?? null;
    return null;
  });

  // Derived: whether the active channel is a saved-mode channel
  let isSavedChannel = $derived(activeFilteredView?.mode === 'saved');

  // Derived: whether we're in any saved view (URL param or saved channel)
  let isSavedView = $derived(Boolean(savedFilter) || isSavedChannel);

  // Helper to get current subscription rkeys, ID→rkey map, and follow DIDs for migration
  function getAllSubRkeys(): string[] {
    return subscriptionsStore.subscriptions.map((s) => s.rkey).filter(Boolean);
  }

  function getIdToRkeyMap(): Map<number, string> {
    const map = new Map<number, string>();
    for (const s of subscriptionsStore.subscriptions) {
      if (s.id != null && s.rkey) map.set(s.id, s.rkey);
    }
    return map;
  }

  function getAllFollowDids(): string[] {
    const dids = new Set<string>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.sourceType?.startsWith('atproto.') && sub.subjectDid) {
        dids.add(sub.subjectDid);
      }
    }
    return [...dids];
  }

  // Derived: effective filters (always uses toolbar state as the working copy)
  let effectiveFilters = $derived.by((): EffectiveFilters => {
    return {
      sourceMode: toolbarSourceMode,
      sourceKeys: toolbarSourceKeys,
      readFilter: showOnlyUnread ? 'unread' : 'all',
      sortOrder: toolbarSortOrder ?? preferences.sortOrder,
      typeFilter: toolbarTypeFilter,
    };
  });

  // Derived: whether any toolbar filter differs from defaults
  let hasActiveFilters = $derived.by(() => {
    if (activeFilteredView) return true;
    return toolbarSourceMode !== 'all' || toolbarTypeFilter.length > 0;
  });

  // Derived: whether toolbar state differs from the persisted saved view
  let hasUnsavedChanges = $derived.by(() => {
    if (!activeFilteredView) return false;
    const view = activeFilteredView;
    const currentReadFilter = showOnlyUnread ? 'unread' : 'all';
    const currentSortOrder = toolbarSortOrder ?? preferences.sortOrder;

    if (currentReadFilter !== view.readFilter) return true;
    if (currentSortOrder !== view.sortOrder) return true;

    if (view.mode === 'saved') {
      // Compare saved source filter
      const savedSources = new Set(view.savedSourceFilter ?? []);
      if (toolbarSavedSourceFilter.length !== savedSources.size) return true;
      for (const s of toolbarSavedSourceFilter) {
        if (!savedSources.has(s)) return true;
      }
      // Compare date filter
      if ((toolbarDateFilter ?? null) !== (view.savedDateFilter ?? null)) return true;
      // Compare reading length filter
      const savedRL = new Set(view.savedReadingLength ?? []);
      if (toolbarReadingLength.length !== savedRL.size) return true;
      for (const r of toolbarReadingLength) {
        if (!savedRL.has(r)) return true;
      }
      // Compare domain filter
      const savedDomains = new Set(view.savedDomainFilter ?? []);
      if (toolbarDomainFilter.length !== savedDomains.size) return true;
      for (const d of toolbarDomainFilter) {
        if (!savedDomains.has(d)) return true;
      }
    } else {
      const savedMode = view.sourceMode === 'all' ? 'all' : 'include';
      const savedKeys = new Set(view.sourceKeys ?? []);
      if (toolbarSourceMode !== savedMode) return true;
      if (toolbarSourceKeys.length !== savedKeys.size) return true;
      for (const key of toolbarSourceKeys) {
        if (!savedKeys.has(key)) return true;
      }
      const savedTypeFilter = new Set(view.typeFilter ?? []);
      if (toolbarTypeFilter.length !== savedTypeFilter.size) return true;
      for (const t of toolbarTypeFilter) {
        if (!savedTypeFilter.has(t)) return true;
      }
    }
    return false;
  });

  // Derived: the subscription selected by feedFilter (if any)
  let feedFilterSubscription = $derived.by(() => {
    if (!feedFilter) return null;
    const id = parseInt(feedFilter);
    return subscriptionsStore.getById(id) ?? null;
  });

  // Derived: view mode
  let viewMode = $derived.by((): ViewMode => {
    if (isSavedChannel) return 'articles'; // saved channels use their own rendering path
    if (activeFilteredView) return 'combined';
    if (sharerFilter || followingFilter) return 'shares';
    if (feedFilter) {
      // AT Proto subscriptions show documents, not articles
      const sub = feedFilterSubscription;
      if (sub?.sourceType === 'atproto.documents') {
        return 'shares';
      }
      return 'articles';
    }
    if (categoryFilter) return 'combined';
    if (savedFilter) return 'articles';
    return 'combined';
  });

  // Track items that were read during this view session to keep them visible
  // These are cleared when switching views/feeds
  let readArticleGuidsThisSession = $state<Set<string>>(new Set());
  let readDocumentUrisThisSession = $state<Set<string>>(new Set());

  // Derived: whether articles are shown (any RSS source allowed and type filter permits)
  let showArticles = $derived.by((): boolean => {
    const fv = effectiveFilters;
    if (fv.typeFilter.length > 0 && !fv.typeFilter.includes('rss')) return false;
    if (fv.sourceMode === 'all') return true;
    return fv.sourceKeys.some(isRssSource);
  });

  // Derived: whether documents are shown (any documents source allowed and type filter permits)
  let showDocuments = $derived.by((): boolean => {
    const fv = effectiveFilters;
    if (fv.typeFilter.length > 0 && !fv.typeFilter.includes('atproto.documents')) return false;
    if (fv.sourceMode === 'all') return true;
    return fv.sourceKeys.some(isDocumentsSource);
  });

  // Derived: filtered articles based on current filters
  let filteredArticles = $derived.by((): Article[] => {
    const fv = effectiveFilters;

    // If no articles are allowed by source filter, return empty
    if (!showArticles) return [];

    // Subscribe directly to the live DB version. The sidebar counts already do
    // this; the feed list needs the same dependency so background refreshes
    // repaint the active Everything view without a route/filter change.
    liveDb.articlesVersion;
    const allArticles = articlesStore.allArticles;
    const sortOrder = fv.sortOrder;

    let articles: Article[];

    if (isSavedView) {
      // Saved view with inbox/archive sub-filter
      if (savedView === 'inbox') {
        articles = allArticles.filter((a) => {
          return itemLabelsStore.isSaved(a.guid) && !itemLabelsStore.isArchived(a.guid);
        });
      } else {
        articles = allArticles.filter((a) => {
          return itemLabelsStore.isSaved(a.guid) && itemLabelsStore.isArchived(a.guid);
        });
      }
    } else {
      articles = allArticles;

      // Filter by subscription (URL filter)
      if (feedFilter) {
        const feedId = parseInt(feedFilter);
        articles = articles.filter((a) => a.subscriptionId === feedId);
      }

      // Filter by category
      if (categorySubscriptionIds) {
        articles = articles.filter((a) => categorySubscriptionIds.has(a.subscriptionId));
      }

      // Apply source-based RSS filtering
      const allowedIds = deriveAllowedRssIds(fv);
      if (allowedIds !== null) {
        articles = articles.filter((a) => allowedIds.has(a.subscriptionId));
      }

      // Apply read filter
      if (fv.readFilter === 'unread') {
        articles = articles.filter(
          (a) => !itemLabelsStore.isRead(a.guid) || readArticleGuidsThisSession.has(a.guid)
        );
      } else if (fv.readFilter === 'read') {
        articles = articles.filter((a) => itemLabelsStore.isRead(a.guid));
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

  // Derived: filtered documents
  let displayedDocuments = $derived.by((): SocialDocument[] => {
    const fv = effectiveFilters;

    // If documents are not shown by source filter, return empty
    if (!showDocuments) return [];

    const feedSub = feedFilterSubscription;
    const docs = socialStore.documents;
    const sortOrder = fv.sortOrder;

    let filtered = [...docs];

    if (feedSub?.sourceType === 'atproto.documents' && feedSub.subjectDid) {
      // Filter to documents from this subscription's subject
      filtered = filtered.filter((d) => d.authorDid === feedSub.subjectDid);
      // If publication-scoped (feedUrl is a publication AT URI), also filter by siteUri
      if (feedSub.feedUrl && feedSub.feedUrl.startsWith('at://')) {
        filtered = filtered.filter((d) => d.siteUri === feedSub.feedUrl);
      }
    } else if (sharerFilter) {
      // Filter by author if sharerFilter is set
      filtered = filtered.filter((d) => d.authorDid === sharerFilter);
    }

    // Apply source-based DID filtering for documents
    const allowedDids = deriveAllowedDids(fv, isDocumentsSource);
    if (allowedDids !== null) {
      filtered = filtered.filter((d) => allowedDids.has(d.authorDid));
    }

    // Filter by category: only show documents from subscriptions in the category
    if (categorySubscriptionIds) {
      const categoryDids = new Set<string>();
      for (const sub of subscriptionsStore.subscriptions) {
        if (sub.category === categoryFilter && sub.subjectDid) {
          categoryDids.add(sub.subjectDid);
        }
      }
      filtered = filtered.filter((d) => categoryDids.has(d.authorDid));
    }

    // Apply read filter
    if (fv.readFilter === 'unread') {
      filtered = filtered.filter(
        (d) =>
          !itemLabelsStore.isSocialRead(d.recordUri) || readDocumentUrisThisSession.has(d.recordUri)
      );
    } else if (fv.readFilter === 'read') {
      filtered = filtered.filter((d) => itemLabelsStore.isSocialRead(d.recordUri));
    }

    // Apply sort order
    filtered.sort((a, b) => {
      const dateA = new Date(a.publishedAt).getTime();
      const dateB = new Date(b.publishedAt).getTime();
      return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
    });

    return filtered;
  });

  // Derived: combined view (articles + documents merged by date)
  // When there are more articles to load, documents are limited to the date range
  // of currently loaded articles. This prevents old documents (e.g. from a year ago)
  // from dominating the tail of the list while there are plenty of unloaded articles
  // that should fill the gap. As more articles load, the date range expands and more
  // documents become visible.
  let displayedCombined = $derived.by((): CombinedFeedItem[] => {
    if (viewMode !== 'combined') return [];

    const fv = effectiveFilters;
    const sortOrder = fv.sortOrder;
    const hasMoreArticlesToLoad = loadedArticleCount < filteredArticles.length;

    let documentsToInclude = displayedDocuments;

    if (hasMoreArticlesToLoad && displayedArticles.length > 0) {
      // Find the oldest displayed article's date based on sort order.
      // filteredArticles (and thus displayedArticles) are sorted newest-first by default.
      const oldestArticle =
        sortOrder === 'newest'
          ? displayedArticles[displayedArticles.length - 1]
          : displayedArticles[0];
      const cutoffTime = new Date(oldestArticle.publishedAt).getTime();

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

  // Derived: full merged-and-filtered saved-items list (pre-pagination).
  // Exposed separately from currentItems so the saved-view rendering path can
  // slice into it for infinite scroll while hasMore/loadMore still see the
  // total count.
  let savedItemsAll = $derived.by((): FeedDisplayItem[] => {
    if (!isSavedView) return [];

    const sortOrder = effectiveFilters.sortOrder;
    const isArchiveView = savedView === 'archive';

    // Per-item predicate for saved-channel filters. Used both for the final
    // item list *and* for deciding whether an article should dedup a bookmark
    // — otherwise a feed-saved article that doesn't match the channel filter
    // would silently kill its matching bookmark even though the article
    // itself never shows up.
    const dateCutoff = toolbarDateFilter ? datePresetToMs(toolbarDateFilter) : null;
    const domainSet =
      toolbarDomainFilter.length > 0
        ? new Set(toolbarDomainFilter.map((d) => d.toLowerCase()))
        : null;
    const readingLengths = toolbarReadingLength;
    const matchesSavedChannelFilters = (item: FeedDisplayItem): boolean => {
      if (dateCutoff !== null && getSavedDate(item) < dateCutoff) return false;
      if (readingLengths.length > 0) {
        const wc = getItemWordCount(item);
        if (wc === null) return false;
        if (!readingLengths.some((b) => matchesReadingLength(wc, b))) return false;
      }
      if (domainSet) {
        const domain = getItemDomain(item);
        if (domain === null || !domainSet.has(domain.toLowerCase())) return false;
      }
      return true;
    };
    const sourceFilter =
      isSavedChannel && toolbarSavedSourceFilter.length > 0
        ? new Set(toolbarSavedSourceFilter)
        : null;

    // Start with saved articles from filteredArticles (already filtered by savedView).
    // Use the full filteredArticles list, not displayedArticles — saved-channel
    // filters (reading length, date, domain) are applied at the end of this
    // block, and pagination-before-filter would hide matches that fall outside
    // the current page window.
    const articleItems: FeedDisplayItem[] =
      sourceFilter && !sourceFilter.has('feed')
        ? []
        : filteredArticles.map((item) => ({
            type: 'article' as const,
            item,
            key: item.guid,
          }));

    // Add starred documents (source type 'document')
    const starredDocumentItems: FeedDisplayItem[] =
      sourceFilter && !sourceFilter.has('document')
        ? []
        : socialStore.documents
            .filter((d) => {
              if (!itemLabelsStore.isSaved(d.recordUri)) return false;
              if (isArchiveView) return itemLabelsStore.isArchived(d.recordUri);
              return !itemLabelsStore.isArchived(d.recordUri);
            })
            .map((d) => ({
              type: 'document' as const,
              item: d,
              key: d.recordUri,
            }));

    // Add bookmarks — exclude bookmarks already shown via articles/shares/documents.
    // Only dedup against articles that actually match the channel filters;
    // otherwise an article that's filtered out (e.g. by reading length) would
    // silently kill its matching bookmark, and the sidebar count would not
    // agree with the displayed list.
    const allSavedArticleGuids = new Set(
      articlesStore.allArticles
        .filter(
          (a) =>
            itemLabelsStore.isSaved(a.guid) &&
            matchesSavedChannelFilters({ type: 'article', item: a, key: a.guid })
        )
        .map((a) => a.guid)
    );
    // Only dedup bookmarks against documents that will actually pass
    // the channel filters — same reasoning as allSavedArticleGuids above.
    const documentRecordUris = new Set(
      starredDocumentItems.filter((d) => matchesSavedChannelFilters(d)).map((d) => d.key)
    );
    const bookmarkItems: FeedDisplayItem[] = savesStore.articles
      .filter((bm) => {
        // Apply saved source filter for saved channels. Treat a missing
        // source as 'url' (the default for legacy rows) so the filter still
        // applies instead of silently letting the bookmark through.
        const src = bm.source ?? 'url';
        if (sourceFilter && !sourceFilter.has(src)) return false;
        // Dedup against items already displayed via the primary stores.
        // Checked regardless of bm.source so legacy rows with undefined
        // source can't slip through and show up twice.
        if (bm.itemGuid) {
          if (allSavedArticleGuids.has(bm.itemGuid)) return false;
          if (documentRecordUris.has(bm.itemGuid)) return false;
        }
        // Use itemGuid (article guid) for archive checks when available, since archive
        // labels are stored against the article guid, not the AT Protocol URI
        const archiveKey = bm.itemGuid || bm.uri || '';
        if (isArchiveView) return itemLabelsStore.isArchived(archiveKey);
        return !itemLabelsStore.isArchived(archiveKey);
      })
      .map((bm) => ({
        type: 'saved' as const,
        item: bm,
        key: bm.uri || bm.itemGuid || bm.rkey,
      }));

    let items: FeedDisplayItem[] = [...articleItems, ...starredDocumentItems, ...bookmarkItems];

    // Sort saved items
    const sort = isSavedChannel ? (toolbarSortOrder ?? 'newest') : sortOrder;
    items.sort((a, b) => {
      switch (sort) {
        case 'published-newest':
        case 'published-oldest': {
          const dateA = getItemPublishedDate(a);
          const dateB = getItemPublishedDate(b);
          return sort === 'published-newest' ? dateB - dateA : dateA - dateB;
        }
        case 'shortest':
        case 'longest': {
          const wcA = getItemWordCount(a) ?? 0;
          const wcB = getItemWordCount(b) ?? 0;
          return sort === 'shortest' ? wcA - wcB : wcB - wcA;
        }
        case 'domain-asc':
        case 'domain-desc': {
          const domA = (getItemDomain(a) ?? '').toLowerCase();
          const domB = (getItemDomain(b) ?? '').toLowerCase();
          const cmp = domA.localeCompare(domB);
          return sort === 'domain-asc' ? cmp : -cmp;
        }
        default: {
          // newest / oldest — sort by savedAt
          const dateA = getSavedDate(a);
          const dateB = getSavedDate(b);
          return sort === 'oldest' ? dateA - dateB : dateB - dateA;
        }
      }
    });

    // Apply tag filter
    if (toolbarTagFilter.length > 0) {
      const _tags = itemLabelsStore.tagsByItem;
      items = items.filter((item) => itemLabelsStore.itemHasAnyTag(item.key, toolbarTagFilter));
    }

    // Apply date added filter
    if (toolbarDateFilter) {
      const cutoff = datePresetToMs(toolbarDateFilter);
      items = items.filter((item) => getSavedDate(item) >= cutoff);
    }

    // Apply reading length filter. Items with unknown word count are
    // excluded so the list matches the sidebar count and the suggestion
    // that promised "N long reads".
    if (toolbarReadingLength.length > 0) {
      items = items.filter((item) => {
        const wc = getItemWordCount(item);
        if (wc === null) return false;
        return toolbarReadingLength.some((bucket) => matchesReadingLength(wc, bucket));
      });
    }

    // Apply domain filter
    if (toolbarDomainFilter.length > 0) {
      const domainSet = new Set(toolbarDomainFilter.map((d) => d.toLowerCase()));
      items = items.filter((item) => {
        const domain = getItemDomain(item);
        return domain !== null && domainSet.has(domain.toLowerCase());
      });
    }

    return items;
  });

  // Derived: unified current items for the active view mode
  let currentItems = $derived.by((): FeedDisplayItem[] => {
    const mode = viewMode;
    let items: FeedDisplayItem[];

    // Saved view: paginate the merged/filtered list so very long saved-item
    // lists don't render the whole DOM at once.
    if (isSavedView) {
      return savedItemsAll.slice(0, loadedArticleCount);
    }

    if (mode === 'combined') {
      items = displayedCombined.map((item) => {
        if (item.type === 'article') {
          return { type: 'article' as const, item: item.item, key: item.item.guid };
        } else {
          return { type: 'document' as const, item: item.item, key: item.item.recordUri };
        }
      });
    } else if (mode === 'shares') {
      // Documents from followed linkblogs, sorted by date
      items = displayedDocuments.map((item) => ({
        type: 'document' as const,
        item,
        key: item.recordUri,
      }));
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
      const _tags = itemLabelsStore.tagsByItem;
      items = items.filter((item) => itemLabelsStore.itemHasAnyTag(item.key, toolbarTagFilter));
    }

    return items;
  });

  // Derived: unified pagination state
  let hasMore = $derived.by(() => {
    const mode = viewMode;
    if (isSavedView) return loadedArticleCount < savedItemsAll.length;
    if (mode === 'combined') return loadedArticleCount < filteredArticles.length;
    // 'shares' mode shows documents, which aren't cursor-paginated.
    if (mode === 'shares') return false;
    return loadedArticleCount < filteredArticles.length;
  });

  let isLoadingMore = $derived.by(() => {
    const mode = viewMode;
    if (mode === 'combined' || mode === 'shares') return socialStore.isLoading;
    return false;
  });

  // Actions
  async function loadArticles() {
    // Reset pagination
    loadedArticleCount = DEFAULT_PAGE_SIZE;

    // For unread view, load more articles until we have enough unread ones
    if (showOnlyUnread && !isSavedView) {
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

    // Saved channels still report viewMode === 'articles', so check isSavedView
    // first — otherwise we'd page filteredArticles.length instead of the
    // merged saved-items count (which also includes shares/documents/bookmarks).
    if (isSavedView) {
      if (loadedArticleCount < savedItemsAll.length) {
        loadedArticleCount += DEFAULT_PAGE_SIZE;
      }
      return;
    }

    if (mode === 'combined' || mode === 'articles') {
      if (loadedArticleCount < filteredArticles.length) {
        loadedArticleCount += DEFAULT_PAGE_SIZE;
      }
    }
    // 'shares' mode shows documents (not paginated) — nothing to load.
  }

  function selectByKey(key: string | null) {
    if (key === selectedKey) return;

    if (key === null) {
      selectedKey = null;
      expandedKey = null;
      return;
    }

    const item = currentItems.find((i) => i.key === key);
    if (!item) return;

    selectedKey = key;
    expandedKey = null;

    // Track the item to keep it visible in unread filter for this session
    if (item.type === 'article') {
      readArticleGuidsThisSession.add(item.item.guid);
      readArticleGuidsThisSession = new Set(readArticleGuidsThisSession);
    } else if (item.type === 'document') {
      readDocumentUrisThisSession.add(item.item.recordUri);
      readDocumentUrisThisSession = new Set(readDocumentUrisThisSession);
    }

    // Mark as read when selecting (after updating selection state)
    if (item.type === 'article') {
      const article = item.item;
      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      if (sub && !itemLabelsStore.isRead(article.guid)) {
        itemLabelsStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
      }
    } else if (item.type === 'document') {
      const doc = item.item;
      if (!itemLabelsStore.isSocialRead(doc.recordUri)) {
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

  function select(index: number) {
    selectByKey(currentItems[index]?.key ?? null);
  }

  function deselect() {
    selectedKey = null;
    expandedKey = null;
    // Don't clear session sets - items should stay visible until view changes
  }

  function expand(index: number) {
    expandedKey = currentItems[index]?.key ?? null;
  }

  function collapse() {
    expandedKey = null;
  }

  function resetSelection() {
    selectedKey = null;
    expandedKey = null;
    // Clear session sets when switching views/feeds
    readArticleGuidsThisSession = new Set();
    readDocumentUrisThisSession = new Set();
  }

  function clearReadThisSession() {
    readArticleGuidsThisSession = new Set();
    readDocumentUrisThisSession = new Set();
  }

  // Derived: all unique domains from saved items (for domain filter picker)
  let availableSavedDomains = $derived.by((): string[] => {
    if (!isSavedView) return [];
    const domains = new Set<string>();
    for (const bm of savesStore.articles) {
      if (bm.domain) {
        domains.add(bm.domain);
      } else if (bm.url) {
        try {
          domains.add(new URL(bm.url).hostname);
        } catch {
          // ignore invalid URLs
        }
      }
    }
    return [...domains].sort();
  });

  function syncToolbarToSavedView() {
    if (!viewFilter) return;
    const fv = activeFilteredView;
    if (!fv || fv.id == null) return;
    const id = fv.id;
    const updates: Partial<import('$lib/types').FilteredView> = {
      readFilter: showOnlyUnread ? 'unread' : 'all',
      sortOrder: toolbarSortOrder ?? preferences.sortOrder,
      tagFilter: toolbarTagFilter.length > 0 ? [...toolbarTagFilter] : undefined,
    };
    if (fv.mode === 'saved') {
      updates.savedSourceFilter =
        toolbarSavedSourceFilter.length > 0 ? [...toolbarSavedSourceFilter] : undefined;
      updates.savedDateFilter = toolbarDateFilter ?? undefined;
      updates.savedReadingLength =
        toolbarReadingLength.length > 0 ? [...toolbarReadingLength] : undefined;
      updates.savedDomainFilter =
        toolbarDomainFilter.length > 0 ? [...toolbarDomainFilter] : undefined;
    } else {
      updates.sourceMode = toolbarSourceMode;
      updates.sourceKeys = [...toolbarSourceKeys];
      updates.typeFilter = toolbarTypeFilter.length > 0 ? [...toolbarTypeFilter] : undefined;
    }
    filteredViewsStore.update(id, updates);
  }

  function resetToolbarFilters() {
    toolbarSourceMode = 'all';
    toolbarSourceKeys = [];
    toolbarSortOrder = null;
    toolbarTagFilter = [];
    toolbarTypeFilter = [];
    toolbarSavedSourceFilter = [];
    toolbarDateFilter = null;
    toolbarReadingLength = [];
    toolbarDomainFilter = [];
  }

  function toggleUnreadFilter() {
    showOnlyUnread = !showOnlyUnread;
  }

  // Track an item as "seen this session" so it stays visible after being marked read
  function trackSeenThisSession(item: FeedDisplayItem) {
    if (item.type === 'article') {
      readArticleGuidsThisSession.add(item.item.guid);
      readArticleGuidsThisSession = new Set(readArticleGuidsThisSession);
    } else if (item.type === 'document') {
      readDocumentUrisThisSession.add(item.item.recordUri);
      readDocumentUrisThisSession = new Set(readDocumentUrisThisSession);
    }
  }

  // Bulk-track items as read this session so they stay visible in unread filter
  function trackItemsAsReadThisSession(articleGuids: string[], documentUris: string[]) {
    if (articleGuids.length > 0) {
      for (const guid of articleGuids) readArticleGuidsThisSession.add(guid);
      readArticleGuidsThisSession = new Set(readArticleGuidsThisSession);
    }
    if (documentUris.length > 0) {
      for (const uri of documentUris) readDocumentUrisThisSession.add(uri);
      readDocumentUrisThisSession = new Set(readDocumentUrisThisSession);
    }
  }

  return {
    // State
    get viewMode() {
      return viewMode;
    },
    get currentItems() {
      return currentItems;
    },
    get selectedKey() {
      return selectedKey;
    },
    get expandedKey() {
      return expandedKey;
    },
    get selectedIndex() {
      return selectedKey === null ? -1 : currentItems.findIndex((i) => i.key === selectedKey);
    },
    get expandedIndex() {
      return expandedKey === null ? -1 : currentItems.findIndex((i) => i.key === expandedKey);
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
    get savedFilter() {
      return savedFilter;
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
    get categoryFilter() {
      return categoryFilter;
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
    get toolbarTypeFilter() {
      return toolbarTypeFilter;
    },
    get toolbarDateFilter() {
      return toolbarDateFilter;
    },
    get toolbarReadingLength() {
      return toolbarReadingLength;
    },
    get toolbarDomainFilter() {
      return toolbarDomainFilter;
    },
    get availableSavedDomains() {
      return availableSavedDomains;
    },
    get currentSortOrder() {
      return toolbarSortOrder ?? preferences.sortOrder;
    },
    get tagMenuItemKey() {
      return tagMenuItemKey;
    },
    get savedView() {
      return savedView;
    },
    get isSavedView() {
      return isSavedView;
    },
    get isSavedChannel() {
      return isSavedChannel;
    },
    get toolbarSavedSourceFilter() {
      return toolbarSavedSourceFilter;
    },

    // All filtered items (not paginated) — for bulk operations like mark-all-as-read
    get filteredArticles() {
      return filteredArticles;
    },
    get displayedDocuments() {
      return displayedDocuments;
    },

    // Actions
    loadArticles,
    loadMore,
    select,
    selectByKey,
    deselect,
    expand,
    collapse,
    resetSelection,
    clearReadThisSession,
    toggleUnreadFilter,
    trackSeenThisSession,
    trackItemsAsReadThisSession,
    setShowOnlyUnread(value: boolean) {
      showOnlyUnread = value;
    },
    setFilterToolbarOpen(open: boolean) {
      filterToolbarOpen = open;
    },
    get mobileControlsVisible() {
      return mobileControlsVisible;
    },
    setMobileControlsVisible(visible: boolean) {
      mobileControlsVisible = visible;
    },
    setSourcePopoverOpen(open: boolean) {
      sourcePopoverOpen = open;
    },
    setToolbarTagFilter(tags: string[]) {
      toolbarTagFilter = tags;
    },
    toggleToolbarTag(tag: string) {
      toolbarTagFilter = toolbarTagFilter.includes(tag)
        ? toolbarTagFilter.filter((t) => t !== tag)
        : [...toolbarTagFilter, tag];
    },
    clearToolbarTag() {
      toolbarTagFilter = [];
    },
    setToolbarTypeFilter(types: SubscriptionSourceType[]) {
      toolbarTypeFilter = types;
    },
    toggleToolbarType(type: SubscriptionSourceType) {
      toolbarTypeFilter = toolbarTypeFilter.includes(type)
        ? toolbarTypeFilter.filter((t) => t !== type)
        : [...toolbarTypeFilter, type];
    },
    clearToolbarType() {
      toolbarTypeFilter = [];
    },
    setToolbarSavedSourceFilter(sources: SavedSourceType[]) {
      toolbarSavedSourceFilter = sources;
    },
    toggleToolbarSavedSource(source: SavedSourceType) {
      toolbarSavedSourceFilter = toolbarSavedSourceFilter.includes(source)
        ? toolbarSavedSourceFilter.filter((s) => s !== source)
        : [...toolbarSavedSourceFilter, source];
    },
    clearToolbarSavedSource() {
      toolbarSavedSourceFilter = [];
    },
    setToolbarDateFilter(preset: DateAddedPreset | null) {
      toolbarDateFilter = preset;
    },
    setToolbarReadingLength(lengths: ReadingLengthFilter[]) {
      toolbarReadingLength = lengths;
    },
    toggleToolbarReadingLength(bucket: ReadingLengthFilter) {
      toolbarReadingLength = toolbarReadingLength.includes(bucket)
        ? toolbarReadingLength.filter((l) => l !== bucket)
        : [...toolbarReadingLength, bucket];
    },
    clearToolbarReadingLength() {
      toolbarReadingLength = [];
    },
    setToolbarDomainFilter(domains: string[]) {
      toolbarDomainFilter = domains;
    },
    toggleToolbarDomain(domain: string) {
      toolbarDomainFilter = toolbarDomainFilter.includes(domain)
        ? toolbarDomainFilter.filter((d) => d !== domain)
        : [...toolbarDomainFilter, domain];
    },
    clearToolbarDomain() {
      toolbarDomainFilter = [];
    },
    setToolbarSourceFilter(mode: 'all' | 'include', keys: string[]) {
      toolbarSourceMode = mode;
      toolbarSourceKeys = keys;
    },
    toggleToolbarSourceKey(key: string) {
      const keys = toolbarSourceKeys.includes(key)
        ? toolbarSourceKeys.filter((k) => k !== key)
        : [...toolbarSourceKeys, key];
      toolbarSourceKeys = keys;
    },
    setSortOrder(order: SortOrder) {
      if (viewFilter) {
        toolbarSortOrder = order;
      }
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
    setSavedView(view: 'inbox' | 'archive') {
      savedView = view;
      loadedArticleCount = DEFAULT_PAGE_SIZE;
    },
    openTagMenu(itemKey: string) {
      tagMenuItemKey = itemKey;
    },
    closeTagMenu() {
      tagMenuItemKey = null;
    },
    setFilters(filters: {
      feed: string | null;
      saved: string | null;
      sharer: string | null;
      following: string | null;
      feeds: string | null;
      contentType?: 'documents' | null;
      view?: string | null;
      category?: string | null;
    }) {
      feedFilter = filters.feed;
      savedFilter = filters.saved;
      sharerFilter = filters.sharer;
      followingFilter = filters.following;
      feedsFilter = filters.feeds;
      contentTypeFilter = filters.contentType ?? null;
      viewFilter = filters.view ?? null;
      categoryFilter = filters.category ?? null;
      // Reset pagination when filters change
      loadedArticleCount = DEFAULT_PAGE_SIZE;
      // Populate toolbar from saved view, or reset to defaults
      if (filters.view) {
        const fv =
          filteredViewsStore.getByUuid(filters.view) ??
          filteredViewsStore.getById(parseInt(filters.view, 10));
        if (fv) {
          if (fv.mode === 'saved') {
            // Saved channel — load saved-specific filters
            toolbarSavedSourceFilter = fv.savedSourceFilter ? [...fv.savedSourceFilter] : [];
            toolbarDateFilter = fv.savedDateFilter ?? null;
            toolbarReadingLength = fv.savedReadingLength ? [...fv.savedReadingLength] : [];
            toolbarDomainFilter = fv.savedDomainFilter ? [...fv.savedDomainFilter] : [];
            toolbarSourceMode = 'all';
            toolbarSourceKeys = [];
            toolbarTypeFilter = [];
            // Derive the inbox/archive tab from the channel's readFilter so
            // entering a channel lands on its persisted Status, not leftover
            // global state from a prior view.
            savedView = fv.readFilter === 'read' ? 'archive' : 'inbox';
          } else if (fv.sourceMode != null) {
            // New format (coerce any stale 'exclude' to 'include')
            toolbarSourceMode = fv.sourceMode === 'all' ? 'all' : 'include';
            toolbarSourceKeys = toolbarSourceMode === 'all' ? [] : [...(fv.sourceKeys ?? [])];
            toolbarSavedSourceFilter = [];
          } else {
            // Legacy format — migrate
            const migrated = migrateLegacyView(
              {
                showArticles: fv.showArticles,
                showDocuments: fv.showDocuments,
                feedMode: fv.feedMode,
                feedIds: fv.feedIds,
                accountMode: fv.accountMode,
                accountDids: fv.accountDids,
              },
              getAllSubRkeys(),
              getAllFollowDids(),
              getIdToRkeyMap()
            );
            toolbarSourceMode = migrated.sourceMode;
            toolbarSourceKeys = migrated.sourceKeys;
            toolbarSavedSourceFilter = [];
          }
          showOnlyUnread = fv.readFilter === 'unread';
          toolbarSortOrder = fv.sortOrder;
          toolbarTagFilter = fv.tagFilter ? [...fv.tagFilter] : [];
          toolbarTypeFilter = fv.typeFilter ? [...fv.typeFilter] : [];
          // Fire-and-forget legacy migration write-back
          if (fv.sourceMode == null && fv.mode !== 'saved' && fv.id != null) {
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
