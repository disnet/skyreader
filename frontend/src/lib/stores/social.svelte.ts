import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
import type { SocialShare } from '$lib/types';

function createSocialStore() {
  let shares = $state<SocialShare[]>([]);
  let popularShares = $state<(SocialShare & { shareCount: number })[]>([]);
  let isLoading = $state(false);
  let cursor = $state<string | null>(null);
  let hasMore = $state(true);
  let error = $state<string | null>(null);

  async function loadFeed(reset = false) {
    if (isLoading || (!hasMore && !reset)) return;

    isLoading = true;
    error = null;

    try {
      const result = await api.getSocialFeed(reset ? undefined : cursor ?? undefined);

      if (reset) {
        shares = result.shares;
        // Cache in IndexedDB
        await db.socialShares.clear();
        await db.socialShares.bulkAdd(result.shares);
      } else {
        shares = [...shares, ...result.shares];
        await db.socialShares.bulkAdd(result.shares);
      }

      cursor = result.cursor;
      hasMore = !!result.cursor;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load social feed';

      // Load from cache on error
      if (reset) {
        shares = await db.socialShares.orderBy('createdAt').reverse().toArray();
      }
    } finally {
      isLoading = false;
    }
  }

  async function loadPopular(period: 'day' | 'week' | 'month' = 'week') {
    isLoading = true;
    error = null;

    try {
      const result = await api.getPopularShares(period);
      popularShares = result.shares;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load popular shares';
    } finally {
      isLoading = false;
    }
  }

  async function syncFollows() {
    try {
      const result = await api.syncFollows();
      // Refresh feed after syncing follows
      await loadFeed(true);
      return result.synced;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to sync follows';
      return 0;
    }
  }

  function reset() {
    shares = [];
    popularShares = [];
    cursor = null;
    hasMore = true;
    error = null;
  }

  return {
    get shares() {
      return shares;
    },
    get popularShares() {
      return popularShares;
    },
    get isLoading() {
      return isLoading;
    },
    get hasMore() {
      return hasMore;
    },
    get error() {
      return error;
    },
    loadFeed,
    loadPopular,
    syncFollows,
    reset,
  };
}

export const socialStore = createSocialStore();
