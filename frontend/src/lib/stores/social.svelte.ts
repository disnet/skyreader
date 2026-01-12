import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
import { realtime, type NewSharePayload } from '$lib/services/realtime';
import type { DiscoverUser, SocialShare } from '$lib/types';
import { generateTid } from '$lib/utils/tid';

export interface FollowedUser {
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  onApp?: boolean;
  source: 'bluesky' | 'inapp' | 'both';
}

function createSocialStore() {
  let shares = $state<SocialShare[]>([]);
  let popularShares = $state<(SocialShare & { shareCount: number })[]>([]);
  let followedUsers = $state<FollowedUser[]>([]);
  let discoverUsers = $state<DiscoverUser[]>([]);
  let isLoading = $state(false);
  let isDiscoverLoading = $state(false);
  let isSyncing = $state(false);
  let cursor = $state<string | null>(null);
  let hasMore = $state(true);
  let error = $state<string | null>(null);

  // Listen for realtime new shares
  realtime.on('new_share', async (payload) => {
    const data = payload as NewSharePayload;
    const newShare: SocialShare = {
      authorDid: data.authorDid,
      authorHandle: data.authorHandle || data.authorDid,
      authorDisplayName: data.authorDisplayName,
      authorAvatar: data.authorAvatar,
      recordUri: data.recordUri,
      feedUrl: data.feedUrl,
      itemUrl: data.itemUrl,
      itemTitle: data.itemTitle,
      itemDescription: data.itemDescription,
      itemImage: data.itemImage,
      itemGuid: data.itemGuid,
      itemPublishedAt: data.itemPublishedAt,
      note: data.note,
      content: data.content,
      createdAt: data.createdAt,
    };

    // Check if share already exists
    const existingIndex = shares.findIndex(s => s.recordUri === newShare.recordUri);

    if (existingIndex === -1) {
      // New share - add it
      shares = [newShare, ...shares];
      try {
        await db.socialShares.add(newShare);
      } catch {
        // Ignore duplicate errors
      }
    } else if (newShare.content && !shares[existingIndex].content) {
      // Existing share but new message has content - update it
      const updated = { ...shares[existingIndex], content: newShare.content };
      shares = [
        ...shares.slice(0, existingIndex),
        updated,
        ...shares.slice(existingIndex + 1)
      ];
      // Update in IndexedDB
      try {
        await db.socialShares.where('recordUri').equals(newShare.recordUri).modify({ content: newShare.content });
      } catch {
        // Ignore errors
      }
    }
  });

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

  async function loadFollowedUsers() {
    isLoading = true;
    error = null;

    try {
      const result = await api.getFollowedUsers();
      followedUsers = result.users;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load followed users';
    } finally {
      isLoading = false;
    }
  }

  async function syncFollows() {
    isSyncing = true;
    error = null;

    try {
      const result = await api.syncFollows();
      // Refresh followed users list and feed after syncing
      await loadFollowedUsers();
      await loadFeed(true);
      return result.synced;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to sync follows';
      return 0;
    } finally {
      isSyncing = false;
    }
  }

  async function loadDiscoverUsers() {
    isDiscoverLoading = true;
    error = null;

    try {
      const result = await api.getDiscoverUsers();
      discoverUsers = result.users;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load discover users';
    } finally {
      isDiscoverLoading = false;
    }
  }

  async function followUser(did: string): Promise<boolean> {
    try {
      const rkey = generateTid();
      const record = {
        subject: did,
        createdAt: new Date().toISOString(),
      };

      await api.syncRecord({
        operation: 'create',
        collection: 'com.at-rss.social.follow',
        rkey,
        record,
      });

      // Refresh followed users and remove from discover
      await loadFollowedUsers();
      discoverUsers = discoverUsers.filter(u => u.did !== did);

      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to follow user';
      return false;
    }
  }

  async function unfollowInApp(did: string): Promise<boolean> {
    try {
      // Find the user's in-app follow record
      const records = await api.listRecords<{ subject: string }>('com.at-rss.social.follow');
      const followRecord = records.records.find(r => r.value.subject === did);

      if (!followRecord) {
        error = 'Follow record not found';
        return false;
      }

      const rkey = followRecord.uri.split('/').pop();
      if (!rkey) {
        error = 'Invalid follow record URI';
        return false;
      }

      await api.syncRecord({
        operation: 'delete',
        collection: 'com.at-rss.social.follow',
        rkey,
      });

      // Refresh followed users
      await loadFollowedUsers();

      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to unfollow user';
      return false;
    }
  }

  function reset() {
    shares = [];
    popularShares = [];
    followedUsers = [];
    discoverUsers = [];
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
    get popularShares() {
      return popularShares;
    },
    get followedUsers() {
      return followedUsers;
    },
    get discoverUsers() {
      return discoverUsers;
    },
    get isLoading() {
      return isLoading;
    },
    get isDiscoverLoading() {
      return isDiscoverLoading;
    },
    get isSyncing() {
      return isSyncing;
    },
    get hasMore() {
      return hasMore;
    },
    get error() {
      return error;
    },
    loadFeed,
    loadPopular,
    loadFollowedUsers,
    loadDiscoverUsers,
    followUser,
    unfollowInApp,
    syncFollows,
    reset,
    getSharesByAuthor,
  };
}

export const socialStore = createSocialStore();
