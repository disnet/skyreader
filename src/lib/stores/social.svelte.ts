import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
import { syncQueue, type FollowPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
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
	let isLoadingFeed = $state(false);
	let isLoadingUsers = $state(false);
	let isDiscoverLoading = $state(false);
	let isSyncing = $state(false);
	let cursor = $state<string | null>(null);
	let hasMore = $state(true);
	let error = $state<string | null>(null);

	// Derived: any loading operation in progress
	let isLoading = $derived(isLoadingFeed || isLoadingUsers);

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
			isLoadingFeed = false;
		}
	}

	async function loadPopular(period: 'day' | 'week' | 'month' = 'week') {
		isLoadingFeed = true;
		error = null;

		try {
			const result = await api.getPopularShares(period);
			popularShares = result.shares;
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
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load followed users';
		} finally {
			isLoadingUsers = false;
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
		const rkey = generateTid();

		// Optimistic update - remove from discover
		discoverUsers = discoverUsers.filter((u) => u.did !== did);

		const payload: FollowPayload = { rkey, did };

		if (syncStore.isOnline) {
			try {
				await api.followUser(rkey, did);
				// Refresh followed users
				await loadFollowedUsers();
				return true;
			} catch (e) {
				error = e instanceof Error ? e.message : 'Failed to follow user';
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

		try {
			// Get in-app follows with rkeys
			const { follows } = await api.listInAppFollows();
			const followRecord = follows.find((f) => f.did === did);

			if (!followRecord) {
				error = 'Follow record not found';
				return false;
			}

			const payload: FollowPayload = { rkey: followRecord.rkey, did };

			try {
				await api.unfollowUser(followRecord.rkey);
				// Refresh followed users
				await loadFollowedUsers();
				return true;
			} catch (e) {
				error = e instanceof Error ? e.message : 'Failed to unfollow user';
				// Queue for retry
				await syncQueue.enqueue('delete', 'follows', did, payload);
				return false;
			}
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
