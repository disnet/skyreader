import { db } from '$lib/services/db';
import { safeBulkAdd } from '$lib/services/safeDb.svelte';
import { api } from '$lib/services/api';
import { profileService } from '$lib/services/profiles';
import { syncQueue, type FollowPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import type { DiscoverUser, FollowedUserDetailed, SocialDocument, SocialShare } from '$lib/types';
import { generateTid } from '$lib/utils/tid';
import { auth } from './auth.svelte';

export interface FollowedUser {
  did: string;
  source: 'bluesky' | 'inapp' | 'both';
}

function createSocialStore() {
  let shares = $state<SocialShare[]>([]);
  let documents = $state<SocialDocument[]>([]);
  let popularShares = $state<(SocialShare & { shareCount: number })[]>([]);
  let followedUsers = $state<FollowedUser[]>([]);
  let discoverUsers = $state<DiscoverUser[]>([]);
  let skyreaderFollows = $state<FollowedUserDetailed[]>([]);
  let blueskyFollows = $state<FollowedUserDetailed[]>([]);
  let skyreaderFollowsNextOffset = $state<number | null>(null);
  let blueskyFollowsCursor = $state<string | null>(null);
  let isLoadingFeed = $state(false);
  let isLoadingUsers = $state(false);
  let isLoadingSkyreaderFollows = $state(false);
  let isLoadingBlueskyFollows = $state(false);
  let isDiscoverLoading = $state(false);
  let cursor = $state<string | null>(null);
  let hasMore = $state(true);
  let error = $state<string | null>(null);
  let inAppFollowCount = $state(0);
  let inAppFollows = $state<
    Array<{
      rkey: string;
      did: string;
      handle?: string;
      displayName?: string;
      avatarUrl?: string;
      createdAt: number;
    }>
  >([]);

  // Derived: any loading operation in progress
  let isLoading = $derived(isLoadingFeed || isLoadingUsers);

  // Derived: follow limit from user tier (fallback to 50 for free)
  let followLimit = $derived(auth.user?.limits?.maxFollows ?? 50);

  // Derived: whether we've hit the follow limit
  let isAtFollowLimit = $derived(inAppFollowCount >= followLimit);

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
        await safeBulkAdd(db.socialShares, result.shares);
        await db.socialDocuments.clear();
        if (result.documents && result.documents.length > 0) {
          await safeBulkAdd(db.socialDocuments, result.documents);
        }
      } else {
        shares = [...shares, ...result.shares];
        documents = [...documents, ...(result.documents || [])];
        await safeBulkAdd(db.socialShares, result.shares);
        if (result.documents && result.documents.length > 0) {
          await safeBulkAdd(db.socialDocuments, result.documents);
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

  async function loadFollowedUsers() {
    isLoadingUsers = true;
    error = null;

    try {
      const result = await api.getFollowedUsers();
      followedUsers = result.users;
      // Prefetch profiles from Bluesky (fire and forget)
      profileService.prefetch(result.users.map((u) => u.did));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load followed users';
    } finally {
      isLoadingUsers = false;
    }
  }

  async function loadInAppFollowCount() {
    try {
      const result = await api.listInAppFollows();
      inAppFollowCount = result.follows.length;
      inAppFollows = result.follows;

      // Prefetch profiles for follows that only have a DID as their handle
      const needsProfile = result.follows
        .filter((f) => !f.handle || f.handle === f.did || f.handle.startsWith('did:'))
        .map((f) => f.did);
      if (needsProfile.length > 0) {
        profileService.prefetch(needsProfile);
      }
    } catch (e) {
      // Silently fail - the count will stay at its previous value
      console.error('Failed to load in-app follow count:', e);
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

  async function loadSkyreaderFollows(reset = true) {
    if (isLoadingSkyreaderFollows) return;
    if (!reset && skyreaderFollowsNextOffset === null) return;

    isLoadingSkyreaderFollows = true;
    error = null;

    try {
      const offset = reset ? 0 : (skyreaderFollowsNextOffset ?? 0);
      const result = await api.getFollowingDetailed(50, offset);

      if (reset) {
        skyreaderFollows = result.users;
      } else {
        skyreaderFollows = [...skyreaderFollows, ...result.users];
      }
      skyreaderFollowsNextOffset = result.nextOffset;

      // Prefetch profiles from Bluesky
      profileService.prefetch(result.users.map((u) => u.did));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load Skyreader follows';
    } finally {
      isLoadingSkyreaderFollows = false;
    }
  }

  async function loadBlueskyFollows(reset = true, userDid?: string) {
    if (isLoadingBlueskyFollows) return;
    if (!reset && blueskyFollowsCursor === null) return;
    if (!userDid) return;

    isLoadingBlueskyFollows = true;
    error = null;

    try {
      const params = new URLSearchParams({
        actor: userDid,
        limit: '50',
      });
      if (!reset && blueskyFollowsCursor) {
        params.set('cursor', blueskyFollowsCursor);
      }

      const response = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows?${params}`
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch Bluesky follows: ${response.status}`);
      }

      const data = (await response.json()) as {
        follows: Array<{
          did: string;
          handle: string;
          displayName?: string;
          avatar?: string;
        }>;
        cursor?: string;
      };

      // Map Bluesky follows into FollowedUserDetailed shape
      // Check which are also followed in-app
      const inappDids = new Set(inAppFollows.map((f) => f.did));
      const inappRkeys = new Map(inAppFollows.map((f) => [f.did, f.rkey]));

      const users: FollowedUserDetailed[] = data.follows.map((f) => ({
        did: f.did,
        source: inappDids.has(f.did) ? 'both' : 'bluesky',
        shareCount: 0,
        lastSharedAt: null,
        followedAt: 0,
        rkey: inappRkeys.get(f.did),
      }));

      if (reset) {
        blueskyFollows = users;
      } else {
        blueskyFollows = [...blueskyFollows, ...users];
      }
      blueskyFollowsCursor = data.cursor || null;

      // Prefetch profiles from Bluesky
      profileService.prefetch(users.map((u) => u.did));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load Bluesky follows';
    } finally {
      isLoadingBlueskyFollows = false;
    }
  }

  async function followUser(did: string): Promise<boolean> {
    const rkey = generateTid();

    // Optimistic update - remove from discover
    discoverUsers = discoverUsers.filter((u) => u.did !== did);

    // Optimistic update - add to followed users for sidebar
    const existingUser = followedUsers.find((u) => u.did === did);
    if (existingUser) {
      // Update source to 'both' if already following on Bluesky
      followedUsers = followedUsers.map((u) =>
        u.did === did ? { ...u, source: 'both' as const } : u
      );
    } else {
      // Add new follow
      followedUsers = [...followedUsers, { did, source: 'inapp' as const }];
    }

    // Optimistic update - update blueskyFollows source to 'both'
    const originalBlueskyFollow = blueskyFollows.find((u) => u.did === did);
    if (originalBlueskyFollow) {
      blueskyFollows = blueskyFollows.map((u) =>
        u.did === did ? { ...u, source: 'both' as const } : u
      );
    }

    // Optimistic update - increment follow count
    inAppFollowCount++;

    const payload: FollowPayload = { rkey, did };

    if (syncStore.isOnline) {
      try {
        await api.followUser(rkey, did);
        // Refresh followed users to get accurate data
        await loadFollowedUsers();
        await loadInAppFollowCount();
        // Load social feed and read positions to include the new user's shares/articles
        try {
          await Promise.all([loadFeed(true), itemLabelsStore.load()]);
        } catch (e) {
          console.error('Failed to reload social feed after follow:', e);
          // Don't propagate - follow succeeded, feed will load on next refresh
        }
        return true;
      } catch (e) {
        error = e instanceof Error ? e.message : 'Failed to follow user';
        // Revert optimistic update on error
        if (existingUser) {
          followedUsers = followedUsers.map((u) =>
            u.did === did ? { ...u, source: existingUser.source } : u
          );
        } else {
          followedUsers = followedUsers.filter((u) => u.did !== did);
        }
        // Revert blueskyFollows
        if (originalBlueskyFollow) {
          blueskyFollows = blueskyFollows.map((u) =>
            u.did === did ? { ...u, source: originalBlueskyFollow.source } : u
          );
        }
        // Revert count
        inAppFollowCount--;
        // Queue for retry
        await syncQueue.enqueue('create', 'follows', did, payload);
        return false;
      }
    } else {
      // Offline - queue the operation
      await syncQueue.enqueue('create', 'follows', did, payload);
      return true; // Optimistically return success
    }
  }

  async function unfollowInApp(did: string): Promise<boolean> {
    // Need to get the rkey first - this requires being online
    if (!syncStore.isOnline) {
      error = 'Cannot unfollow while offline';
      return false;
    }

    // Store original state for potential rollback
    const originalUser = followedUsers.find((u) => u.did === did);
    const originalCount = inAppFollowCount;

    // Optimistic update - update source or remove from followed users
    if (originalUser?.source === 'both') {
      // If following on both, change to bluesky-only
      followedUsers = followedUsers.map((u) =>
        u.did === did ? { ...u, source: 'bluesky' as const } : u
      );
    } else {
      // If only following in-app, remove entirely
      followedUsers = followedUsers.filter((u) => u.did !== did);
    }

    // Optimistic update - remove from skyreaderFollows
    const originalSkyreaderFollows = skyreaderFollows;
    skyreaderFollows = skyreaderFollows.filter((u) => u.did !== did);

    // Optimistic update - update blueskyFollows source
    const originalBlueskyFollowForUnfollow = blueskyFollows.find((u) => u.did === did);
    if (originalBlueskyFollowForUnfollow) {
      blueskyFollows = blueskyFollows.map((u) =>
        u.did === did ? { ...u, source: 'bluesky' as const } : u
      );
    }

    // Optimistic update - decrement follow count
    inAppFollowCount = Math.max(0, inAppFollowCount - 1);

    try {
      // Get in-app follows with rkeys
      const { follows } = await api.listInAppFollows();
      const followRecord = follows.find((f) => f.did === did);

      if (!followRecord) {
        // Revert optimistic update
        if (originalUser) {
          if (originalUser.source === 'both') {
            followedUsers = followedUsers.map((u) =>
              u.did === did ? { ...u, source: 'both' as const } : u
            );
          } else {
            followedUsers = [...followedUsers, originalUser];
          }
        }
        skyreaderFollows = originalSkyreaderFollows;
        if (originalBlueskyFollowForUnfollow) {
          blueskyFollows = blueskyFollows.map((u) =>
            u.did === did ? { ...u, source: originalBlueskyFollowForUnfollow.source } : u
          );
        }
        inAppFollowCount = originalCount;
        error = 'Follow record not found';
        return false;
      }

      const payload: FollowPayload = { rkey: followRecord.rkey, did };

      try {
        await api.unfollowUser(followRecord.rkey);
        // Refresh followed users to get accurate data
        await loadFollowedUsers();
        await loadInAppFollowCount();
        return true;
      } catch (e) {
        error = e instanceof Error ? e.message : 'Failed to unfollow user';
        // Revert optimistic update
        if (originalUser) {
          if (originalUser.source === 'both') {
            followedUsers = followedUsers.map((u) =>
              u.did === did ? { ...u, source: 'both' as const } : u
            );
          } else {
            followedUsers = [...followedUsers, originalUser];
          }
        }
        skyreaderFollows = originalSkyreaderFollows;
        if (originalBlueskyFollowForUnfollow) {
          blueskyFollows = blueskyFollows.map((u) =>
            u.did === did ? { ...u, source: originalBlueskyFollowForUnfollow.source } : u
          );
        }
        inAppFollowCount = originalCount;
        // Queue for retry
        await syncQueue.enqueue('delete', 'follows', did, payload);
        return false;
      }
    } catch (e) {
      // Revert optimistic update
      if (originalUser) {
        if (originalUser.source === 'both') {
          followedUsers = followedUsers.map((u) =>
            u.did === did ? { ...u, source: 'both' as const } : u
          );
        } else {
          followedUsers = [...followedUsers, originalUser];
        }
      }
      skyreaderFollows = originalSkyreaderFollows;
      if (originalBlueskyFollowForUnfollow) {
        blueskyFollows = blueskyFollows.map((u) =>
          u.did === did ? { ...u, source: originalBlueskyFollowForUnfollow.source } : u
        );
      }
      inAppFollowCount = originalCount;
      error = e instanceof Error ? e.message : 'Failed to unfollow user';
      return false;
    }
  }

  function reset() {
    shares = [];
    documents = [];
    popularShares = [];
    followedUsers = [];
    discoverUsers = [];
    skyreaderFollows = [];
    blueskyFollows = [];
    skyreaderFollowsNextOffset = null;
    blueskyFollowsCursor = null;
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
    get followedUsers() {
      return followedUsers;
    },
    get discoverUsers() {
      return discoverUsers;
    },
    get skyreaderFollows() {
      return skyreaderFollows;
    },
    get blueskyFollows() {
      return blueskyFollows;
    },
    get hasMoreSkyreaderFollows() {
      return skyreaderFollowsNextOffset !== null;
    },
    get hasMoreBlueskyFollows() {
      return blueskyFollowsCursor !== null;
    },
    get isLoading() {
      return isLoading;
    },
    get isLoadingSkyreaderFollows() {
      return isLoadingSkyreaderFollows;
    },
    get isLoadingBlueskyFollows() {
      return isLoadingBlueskyFollows;
    },
    get isDiscoverLoading() {
      return isDiscoverLoading;
    },
    get hasMore() {
      return hasMore;
    },
    get error() {
      return error;
    },
    get inAppFollowCount() {
      return inAppFollowCount;
    },
    get inAppFollows() {
      return inAppFollows;
    },
    get isAtFollowLimit() {
      return isAtFollowLimit;
    },
    get followLimit() {
      return followLimit;
    },
    loadFeed,
    loadPopular,
    loadFollowedUsers,
    loadInAppFollowCount,
    loadDiscoverUsers,
    loadSkyreaderFollows,
    loadBlueskyFollows,
    followUser,
    unfollowInApp,
    reset,
    getSharesByAuthor,
  };
}

export const socialStore = createSocialStore();
