import { db } from '$lib/services/db';
import { safeBulkPut } from '$lib/services/safeDb.svelte';
import { api } from '$lib/services/api';
import { profileService } from '$lib/services/profiles';
import { itemLabelsStore } from './itemLabels.svelte';
import type { SocialDocument, SocialShare } from '$lib/types';

function createSocialStore() {
  let shares = $state<SocialShare[]>([]);
  let documents = $state<SocialDocument[]>([]);
  let popularShares = $state<(SocialShare & { shareCount: number })[]>([]);
  let isLoadingFeed = $state(false);
  let cursor = $state<string | null>(null);
  let hasMore = $state(true);
  let error = $state<string | null>(null);

  async function loadFeed(reset = false) {
    if (isLoadingFeed || (!hasMore && !reset)) {
      return;
    }

    isLoadingFeed = true;
    error = null;

    try {
      const result = await api.getSocialFeed(reset ? undefined : (cursor ?? undefined));

      if (reset) {
        shares = result.shares;
        documents = result.documents || [];
        // Cache in IndexedDB
        await db.socialShares.clear();
        await safeBulkPut(db.socialShares, result.shares);
        await db.socialDocuments.clear();
        if (result.documents && result.documents.length > 0) {
          await safeBulkPut(db.socialDocuments, result.documents);
        }
      } else {
        shares = [...shares, ...result.shares];
        documents = [...documents, ...(result.documents || [])];
        await safeBulkPut(db.socialShares, result.shares);
        if (result.documents && result.documents.length > 0) {
          await safeBulkPut(db.socialDocuments, result.documents);
        }
      }

      cursor = result.cursor;
      hasMore = !!result.cursor;

      // Prefetch author profiles from Bluesky (fire and forget)
      const shareAuthorDids = result.shares.map((s) => s.authorDid);
      const docAuthorDids = (result.documents || []).map((d) => d.authorDid);
      const authorDids = [...new Set([...shareAuthorDids, ...docAuthorDids])];
      profileService.prefetch(authorDids);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load social feed';

      // Load from cache on error
      if (reset) {
        shares = await db.socialShares.orderBy('createdAt').reverse().toArray();
        documents = await db.socialDocuments.orderBy('publishedAt').reverse().toArray();
      }
    } finally {
      isLoadingFeed = false;
    }
  }

  async function loadPopular(period: 'day' | 'week' | 'month' = 'week') {
    isLoadingFeed = true;
    error = null;

    try {
      const result = await api.getPopularShares(period);
      popularShares = result.shares;
      // Prefetch author profiles from Bluesky (fire and forget)
      const authorDids = [...new Set(result.shares.map((s) => s.authorDid))];
      profileService.prefetch(authorDids);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load popular shares';
    } finally {
      isLoadingFeed = false;
    }
  }

  function reset() {
    shares = [];
    documents = [];
    popularShares = [];
    cursor = null;
    hasMore = true;
    error = null;
  }

  function getSharesByAuthor(authorDid: string): SocialShare[] {
    return shares.filter((s) => s.authorDid === authorDid);
  }

  return {
    get shares() {
      return shares;
    },
    get documents() {
      return documents;
    },
    get popularShares() {
      return popularShares;
    },
    get isLoading() {
      return isLoadingFeed;
    },
    get hasMore() {
      return hasMore;
    },
    get error() {
      return error;
    },
    loadFeed,
    loadPopular,
    reset,
    getSharesByAuthor,
  };
}

export const socialStore = createSocialStore();
