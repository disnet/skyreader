import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import { socialStore } from './social.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { savesStore } from './saves.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { liveDb } from '$lib/services/liveDb.svelte';
import {
  isRssSource,
  isSharesSource,
  isDocumentsSource,
  getRssSubscriptionId,
  getSourceDid,
} from '$lib/utils/sourceKeys';

/**
 * Centralized unread count computations.
 * Used by Sidebar, NavigationDropdown, and page title.
 */
function createUnreadCountsStore() {
  // Per-feed unread counts
  let feedCounts = $derived.by(() => {
    liveDb.articlesVersion;
    itemLabelsStore.readPositions;
    const counts = new Map<number, number>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.id) {
        counts.set(sub.id, articlesStore.getUnreadCount(sub.id));
      }
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
        let count = 0;

        // Count non-archived saved articles (source = 'feed')
        if (!sourceFilter || sourceFilter.has('feed')) {
          for (const article of articlesStore.allArticles) {
            if (
              itemLabelsStore.isSaved(article.guid) &&
              !itemLabelsStore.isArchived(article.guid)
            ) {
              count++;
            }
          }
        }

        // Count non-archived saved shares (source = 'share')
        if (!sourceFilter || sourceFilter.has('share')) {
          for (const share of socialStore.shares) {
            if (
              itemLabelsStore.isSaved(share.recordUri) &&
              !itemLabelsStore.isArchived(share.recordUri)
            ) {
              count++;
            }
          }
        }

        // Count non-archived saved documents (source = 'document')
        if (!sourceFilter || sourceFilter.has('document')) {
          for (const doc of socialStore.documents) {
            if (
              itemLabelsStore.isSaved(doc.recordUri) &&
              !itemLabelsStore.isArchived(doc.recordUri)
            ) {
              count++;
            }
          }
        }

        // Count non-archived bookmarks (deduped against above)
        const savedArticleGuids = new Set(
          articlesStore.allArticles
            .filter((a) => itemLabelsStore.isSaved(a.guid))
            .map((a) => a.guid)
        );
        const savedShareUris = new Set(
          socialStore.shares
            .filter((s) => itemLabelsStore.isSaved(s.recordUri))
            .map((s) => s.recordUri)
        );
        const savedDocUris = new Set(
          socialStore.documents
            .filter((d) => itemLabelsStore.isSaved(d.recordUri))
            .map((d) => d.recordUri)
        );
        for (const bm of savesStore.articles) {
          if (sourceFilter && bm.source && !sourceFilter.has(bm.source)) continue;
          if (bm.source === 'feed' && bm.itemGuid && savedArticleGuids.has(bm.itemGuid)) continue;
          if (bm.source === 'share' && bm.itemGuid && savedShareUris.has(bm.itemGuid)) continue;
          if (bm.source === 'document' && bm.itemGuid && savedDocUris.has(bm.itemGuid)) continue;
          const archiveKey = bm.itemGuid || bm.uri || '';
          if (!itemLabelsStore.isArchived(archiveKey)) count++;
        }

        counts.set(view.id, count);
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
        const allowedIds =
          sourceMode === 'all'
            ? null
            : new Set(sourceKeys.filter(isRssSource).map(getRssSubscriptionId));
        const seen = new Set<string>();
        for (const article of articlesStore.allArticles) {
          if (seen.has(article.guid)) continue;
          seen.add(article.guid);
          if (allowedIds && !allowedIds.has(article.subscriptionId)) continue;
          if (!itemLabelsStore.isRead(article.guid)) count++;
        }
      }

      // Count unread shares
      if (showShares) {
        const allowedDids =
          sourceMode === 'all'
            ? null
            : new Set(sourceKeys.filter(isSharesSource).map(getSourceDid));
        for (const share of socialStore.shares) {
          if (allowedDids && !allowedDids.has(share.authorDid)) continue;
          if (!itemLabelsStore.isSocialRead(share.recordUri)) count++;
        }
      }

      // Count unread documents
      if (showDocs) {
        const allowedDids =
          sourceMode === 'all'
            ? null
            : new Set(sourceKeys.filter(isDocumentsSource).map(getSourceDid));
        for (const doc of socialStore.documents) {
          if (allowedDids && !allowedDids.has(doc.authorDid)) continue;
          if (!itemLabelsStore.isSocialRead(doc.recordUri)) count++;
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
