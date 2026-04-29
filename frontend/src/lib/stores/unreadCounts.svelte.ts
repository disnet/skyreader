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
  isSharesSource,
  isDocumentsSource,
  getRssSubscriptionRkey,
  getSourceDid,
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

      if (sub.sourceType === 'atproto.shares' && sub.subjectDid) {
        let count = 0;
        for (const share of socialStore.shares) {
          if (
            share.authorDid === sub.subjectDid &&
            !itemLabelsStore.isSocialRead(share.recordUri)
          ) {
            count++;
          }
        }
        counts.set(sub.id, count);
        continue;
      }

      if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
        let count = 0;
        for (const doc of socialStore.documents) {
          if (doc.authorDid !== sub.subjectDid) continue;
          if (itemLabelsStore.isSocialRead(doc.recordUri)) continue;

          // Publication subscriptions are scoped to a site URI. Freestanding document
          // subscriptions intentionally exclude documents attached to an ATProto site.
          if (sub.feedUrl === '__freestanding__') {
            if (doc.siteUri?.startsWith('at://')) continue;
          } else if (sub.feedUrl?.startsWith('at://')) {
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

  // Unread shares by author
  let sharerShareCounts = $derived.by(() => {
    itemLabelsStore.socialPositions;
    const counts = new Map<string, number>();
    for (const share of socialStore.shares) {
      if (!itemLabelsStore.isSocialRead(share.recordUri)) {
        counts.set(share.authorDid, (counts.get(share.authorDid) || 0) + 1);
      }
    }
    return counts;
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
  let totalSocial = $derived(
    Array.from(sharerShareCounts.values()).reduce((a, b) => a + b, 0) +
      Array.from(sharerDocCounts.values()).reduce((a, b) => a + b, 0)
  );

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

        // Count non-archived saved shares (source = 'share')
        if (!sourceFilter || sourceFilter.has('share')) {
          for (const share of socialStore.shares) {
            if (seen.has(share.recordUri)) continue;
            if (
              itemLabelsStore.isSaved(share.recordUri) &&
              !itemLabelsStore.isArchived(share.recordUri)
            ) {
              const displayItem: FeedDisplayItem = {
                type: 'share',
                item: share,
                key: share.recordUri,
              };
              if (!matchesChannelFilters(displayItem)) continue;
              seen.add(share.recordUri);
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
      const showShares =
        (typeFilter.length === 0 || typeFilter.includes('atproto.shares')) &&
        (sourceMode === 'all' || sourceKeys.some(isSharesSource));
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

      // Count unread shares — sum from pre-computed per-author map
      if (showShares) {
        if (sourceMode === 'all') {
          for (const c of sharerShareCounts.values()) count += c;
        } else {
          const allowedDids = new Set(sourceKeys.filter(isSharesSource).map(getSourceDid));
          for (const did of allowedDids) {
            count += sharerShareCounts.get(did) || 0;
          }
        }
      }

      // Count unread documents — sum from pre-computed per-author map
      if (showDocs) {
        if (sourceMode === 'all') {
          for (const c of sharerDocCounts.values()) count += c;
        } else {
          const allowedDids = new Set(sourceKeys.filter(isDocumentsSource).map(getSourceDid));
          for (const did of allowedDids) {
            count += sharerDocCounts.get(did) || 0;
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
    get sharerShareCounts() {
      return sharerShareCounts;
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
      return (sharerShareCounts.get(did) || 0) + (sharerDocCounts.get(did) || 0);
    },
    getSharesForSharer(did: string): number {
      return sharerShareCounts.get(did) || 0;
    },
    getDocsForSharer(did: string): number {
      return sharerDocCounts.get(did) || 0;
    },
  };
}

export const unreadCounts = createUnreadCountsStore();
