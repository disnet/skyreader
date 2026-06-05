import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import { socialStore } from './social.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { savesStore } from './saves.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import {
  type FeedDisplayItem,
  getItemWordCount,
  getItemDomain,
  getSavedDate,
  datePresetToMs,
  matchesReadingLength,
} from './feedView.svelte';
import { liveDb } from '$lib/services/liveDb.svelte';
import {
  isRssSource,
  isDocumentsSource,
  getRssSubscriptionRkey,
  resolveDocScopes,
  docInAnyScope,
} from '$lib/utils/sourceKeys';

/**
 * Centralized unread count computations.
 * Used by Sidebar, NavigationDropdown, and page title.
 */
function createUnreadCountsStore() {
  // Per-source unread counts. RSS sources count unread feed articles; ATProto sources
  // count unread social records scoped to the subscribed author/publication.
  let feedCounts = $derived.by(() => {
    liveDb.articlesVersion;
    itemLabelsStore.readPositions;
    itemLabelsStore.socialPositions;

    const counts = new Map<number, number>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (!sub.id) continue;

      if (!sub.sourceType || sub.sourceType === 'rss') {
        counts.set(sub.id, articlesStore.getUnreadCount(sub.id));
        continue;
      }

      if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
        let count = 0;
        for (const doc of socialStore.documents) {
          if (doc.authorDid !== sub.subjectDid) continue;
          if (itemLabelsStore.isSocialRead(doc.recordUri)) continue;

          // Publication subscriptions are scoped to a site URI.
          if (sub.feedUrl?.startsWith('at://')) {
            if (doc.siteUri !== sub.feedUrl) continue;
          }

          count++;
        }
        counts.set(sub.id, count);
        continue;
      }

      counts.set(sub.id, 0);
    }
    return counts;
  });

  // Total unread articles (deduplicated by GUID across feeds to match combined view)
  let totalArticles = $derived.by(() => {
    liveDb.articlesVersion;
    itemLabelsStore.readPositions; // Access for reactivity
    const seen = new Set<string>();
    let count = 0;
    for (const article of articlesStore.allArticles) {
      if (!seen.has(article.guid) && !itemLabelsStore.isRead(article.guid)) {
        seen.add(article.guid);
        count++;
      }
    }
    return count;
  });

  // Unread documents by author
  let sharerDocCounts = $derived.by(() => {
    itemLabelsStore.socialPositions;
    const counts = new Map<string, number>();
    for (const doc of socialStore.documents) {
      if (!itemLabelsStore.isSocialRead(doc.recordUri)) {
        counts.set(doc.authorDid, (counts.get(doc.authorDid) || 0) + 1);
      }
    }
    return counts;
  });

  // Total unread social items
  let totalSocial = $derived(Array.from(sharerDocCounts.values()).reduce((a, b) => a + b, 0));

  // Per-channel (FilteredView) unread counts
  let channelCounts = $derived.by(() => {
    // Access reactive dependencies
    liveDb.articlesVersion;
    itemLabelsStore.readPositions;
    itemLabelsStore.socialPositions;

    const counts = new Map<number, number>();
    for (const view of filteredViewsStore.views) {
      if (view.id == null) continue;

      // Saved channels: count non-archived saved items
      if (view.mode === 'saved') {
        const sourceFilter =
          view.savedSourceFilter && view.savedSourceFilter.length > 0
            ? new Set(view.savedSourceFilter)
            : null;

        const dateCutoff = view.savedDateFilter ? datePresetToMs(view.savedDateFilter) : null;
        const readingLengths = view.savedReadingLength ?? [];
        const domainSet =
          view.savedDomainFilter && view.savedDomainFilter.length > 0
            ? new Set(view.savedDomainFilter.map((d) => d.toLowerCase()))
            : null;

        const matchesChannelFilters = (item: FeedDisplayItem): boolean => {
          if (dateCutoff !== null && getSavedDate(item) < dateCutoff) return false;
          if (readingLengths.length > 0) {
            const wc = getItemWordCount(item);
            // Exclude items with unknown word count — the suggestion counts
            // promised a specific number of long reads, so a bookmark whose
            // wordCount was never computed shouldn't be silently counted as one.
            if (wc === null) return false;
            if (!readingLengths.some((b) => matchesReadingLength(wc, b))) return false;
          }
          if (domainSet) {
            const domain = getItemDomain(item);
            if (domain === null || !domainSet.has(domain.toLowerCase())) return false;
          }
          return true;
        };

        // Use a Set of item keys so the same item can't be counted twice —
        // e.g. when a guid exists in multiple subscriptions, or when a
        // bookmark and its primary-store counterpart refer to the same item.
        const seen = new Set<string>();

        // Count non-archived saved articles (source = 'feed')
        if (!sourceFilter || sourceFilter.has('feed')) {
          for (const article of articlesStore.allArticles) {
            if (seen.has(article.guid)) continue;
            if (
              itemLabelsStore.isSaved(article.guid) &&
              !itemLabelsStore.isArchived(article.guid)
            ) {
              const displayItem: FeedDisplayItem = {
                type: 'article',
                item: article,
                key: article.guid,
              };
              if (!matchesChannelFilters(displayItem)) continue;
              seen.add(article.guid);
            }
          }
        }

        // Count non-archived saved documents (source = 'document')
        if (!sourceFilter || sourceFilter.has('document')) {
          for (const doc of socialStore.documents) {
            if (seen.has(doc.recordUri)) continue;
            if (
              itemLabelsStore.isSaved(doc.recordUri) &&
              !itemLabelsStore.isArchived(doc.recordUri)
            ) {
              const displayItem: FeedDisplayItem = {
                type: 'document',
                item: doc,
                key: doc.recordUri,
              };
              if (!matchesChannelFilters(displayItem)) continue;
              seen.add(doc.recordUri);
            }
          }
        }

        // Count non-archived bookmarks, deduping against items already counted
        // above via itemGuid (regardless of bm.source — legacy rows may lack it).
        for (const bm of savesStore.articles) {
          const src = bm.source ?? 'url';
          if (sourceFilter && !sourceFilter.has(src)) continue;
          const key = bm.itemGuid || bm.uri || bm.rkey;
          if (seen.has(key)) continue;
          const archiveKey = bm.itemGuid || bm.uri || '';
          if (itemLabelsStore.isArchived(archiveKey)) continue;
          const displayItem: FeedDisplayItem = {
            type: 'saved',
            item: bm,
            key: bm.uri || bm.itemGuid || bm.rkey,
          };
          if (!matchesChannelFilters(displayItem)) continue;
          seen.add(key);
        }

        counts.set(view.id, seen.size);
        continue;
      }

      const sourceMode = view.sourceMode ?? 'all';
      const sourceKeys = view.sourceKeys ?? [];
      const typeFilter = view.typeFilter ?? [];

      // Determine which content types this channel shows
      const showRss =
        (typeFilter.length === 0 || typeFilter.includes('rss')) &&
        (sourceMode === 'all' || sourceKeys.some(isRssSource));
      const showDocs =
        (typeFilter.length === 0 || typeFilter.includes('atproto.documents')) &&
        (sourceMode === 'all' || sourceKeys.some(isDocumentsSource));

      let count = 0;

      // Count unread articles
      if (showRss) {
        if (sourceMode === 'all') {
          // Reuse already-computed total (deduped by guid)
          count += totalArticles;
        } else {
          const allowedIds = new Set(
            sourceKeys
              .filter(isRssSource)
              .map((key) => {
                const sub = subscriptionsStore.getByRkey(getRssSubscriptionRkey(key));
                return sub?.id;
              })
              .filter((id): id is number => id != null)
          );
          const seen = new Set<string>();
          for (const article of articlesStore.allArticles) {
            if (seen.has(article.guid)) continue;
            seen.add(article.guid);
            if (!allowedIds.has(article.subscriptionId)) continue;
            if (!itemLabelsStore.isRead(article.guid)) count++;
          }
        }
      }

      // Count unread documents. 'all' sums the pre-computed per-author map; an
      // include filter counts per (author, publication) scope so two publications
      // owned by one author aren't conflated.
      if (showDocs) {
        if (sourceMode === 'all') {
          for (const c of sharerDocCounts.values()) count += c;
        } else {
          const scopes = resolveDocScopes(sourceKeys, subscriptionsStore.subscriptions);
          for (const doc of socialStore.documents) {
            if (itemLabelsStore.isSocialRead(doc.recordUri)) continue;
            if (docInAnyScope(doc, scopes)) count++;
          }
        }
      }

      counts.set(view.id, count);
    }
    return counts;
  });

  return {
    get feedCounts() {
      return feedCounts;
    },
    get totalArticles() {
      return totalArticles;
    },
    get sharerDocCounts() {
      return sharerDocCounts;
    },
    get totalSocial() {
      return totalSocial;
    },
    get channelCounts() {
      return channelCounts;
    },
    getUnreadForSharer(did: string): number {
      return sharerDocCounts.get(did) || 0;
    },
    getDocsForSharer(did: string): number {
      return sharerDocCounts.get(did) || 0;
    },
  };
}

export const unreadCounts = createUnreadCountsStore();
