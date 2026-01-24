import { api } from '$lib/services/api';
import { db } from '$lib/services/db';
import { syncQueue, type SharePayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import type { UserShare } from '$lib/types';

function generateTid(): string {
	const now = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `${now.toString(36)}${random}`;
}

function createSharesStore() {
	let userShares = $state<Map<string, UserShare>>(new Map());
	let isLoading = $state(true);
	let hasLoaded = false;

	// Load shares - stale-while-revalidate pattern
	async function load() {
		isLoading = true;

		// 1. First, try to load from local cache for instant display
		try {
			const cached = await db.userShares.toArray();
			if (cached.length > 0) {
				userShares = new Map(cached.map((s) => [s.articleGuid, s]));
				// Show cached data immediately, but keep loading
				isLoading = false;
			}
		} catch (e) {
			console.error('Failed to load shares from cache:', e);
		}

		// 2. Then fetch from backend and update
		try {
			const { shares } = await api.getMyShares();

			// Convert backend response to UserShare format and build map
			const newShares = new Map<string, UserShare>();
			const sharesForDb: UserShare[] = [];

			for (const share of shares) {
				// Extract rkey from recordUri: local://did/collection/rkey or at://did/collection/rkey
				const rkey = share.recordUri.split('/').pop() || '';

				const userShare: UserShare = {
					rkey,
					feedUrl: share.feedUrl,
					articleGuid: share.articleGuid || share.articleUrl, // Fall back to URL if no GUID
					articleUrl: share.articleUrl,
					articleTitle: share.articleTitle,
					articleAuthor: share.articleAuthor,
					articleDescription: share.articleDescription,
					articleImage: share.articleImage,
					articlePublishedAt: share.articlePublishedAt,
					note: share.note,
					createdAt: share.createdAt,
				};

				newShares.set(userShare.articleGuid, userShare);
				sharesForDb.push(userShare);
			}

			userShares = newShares;
			hasLoaded = true;

			// Sync cache in background - clear and repopulate
			try {
				await db.userShares.clear();
				if (sharesForDb.length > 0) {
					await db.userShares.bulkPut(sharesForDb);
				}
			} catch (cacheError) {
				console.error('Failed to sync shares cache:', cacheError);
			}
		} catch (e) {
			console.error('Failed to load shares from backend:', e);
			// If backend fails but we have cached data, that's ok
			if (userShares.size > 0) {
				hasLoaded = true;
			}
		} finally {
			isLoading = false;
		}
	}

	function isShared(articleGuid: string): boolean {
		return userShares.has(articleGuid);
	}

	function getShareNote(articleGuid: string): string | undefined {
		return userShares.get(articleGuid)?.note;
	}

	async function share(
		subscriptionRkey: string,
		feedUrl: string,
		articleGuid: string,
		articleUrl: string,
		articleTitle?: string,
		articleAuthor?: string,
		articleContent?: string,
		articleDescription?: string,
		articleImage?: string,
		articlePublishedAt?: string
	) {
		// Already shared - skip
		if (userShares.has(articleGuid)) return;

		const rkey = generateTid();
		const now = new Date().toISOString();

		const shareData: Omit<UserShare, 'id'> = {
			rkey,
			subscriptionRkey,
			feedUrl,
			articleGuid,
			articleUrl,
			articleTitle,
			articleAuthor,
			articleDescription,
			articleImage,
			articlePublishedAt,
			createdAt: now,
		};

		// Optimistic update - add to local state and cache
		userShares.set(articleGuid, { ...shareData });
		userShares = new Map(userShares);

		const id = await db.userShares.add(shareData);
		userShares.set(articleGuid, { ...shareData, id });
		userShares = new Map(userShares);

		const payload: SharePayload = {
			rkey,
			subscriptionRkey,
			feedUrl,
			articleGuid,
			articleUrl,
			articleTitle,
			articleAuthor,
			articleContent,
			articleDescription,
			articleImage,
			articlePublishedAt,
		};

		if (syncStore.isOnline) {
			try {
				await api.createShare({
					rkey,
					itemUrl: articleUrl,
					feedUrl: feedUrl || undefined,
					itemGuid: articleGuid || undefined,
					itemTitle: articleTitle,
					itemAuthor: articleAuthor,
					itemDescription: articleDescription ? articleDescription.slice(0, 1000) : undefined,
					content: articleContent,
					itemImage:
						articleImage &&
						(articleImage.startsWith('http://') || articleImage.startsWith('https://'))
							? articleImage
							: undefined,
					itemPublishedAt: articlePublishedAt,
				});
			} catch (e) {
				console.error('Failed to create share, queueing for retry:', e);
				await syncQueue.enqueue('create', 'shares', articleGuid, payload);
			}
		} else {
			// Offline - queue the operation
			await syncQueue.enqueue('create', 'shares', articleGuid, payload);
		}
	}

	async function unshare(articleGuid: string) {
		const existingShare = userShares.get(articleGuid);
		if (!existingShare) return;

		// Optimistic update - remove from map and cache
		userShares.delete(articleGuid);
		userShares = new Map(userShares);

		if (existingShare.id) {
			await db.userShares.delete(existingShare.id);
		}

		const payload: SharePayload = {
			rkey: existingShare.rkey || '',
			feedUrl: existingShare.feedUrl || '',
			articleGuid,
			articleUrl: existingShare.articleUrl,
		};

		if (syncStore.isOnline) {
			try {
				if (existingShare.rkey) {
					await api.deleteShare(existingShare.rkey);
				}
			} catch (e) {
				console.error('Failed to delete share, queueing for retry:', e);
				if (existingShare.rkey) {
					await syncQueue.enqueue('delete', 'shares', articleGuid, payload);
				}
			}
		} else {
			// Offline - queue the operation
			if (existingShare.rkey) {
				await syncQueue.enqueue('delete', 'shares', articleGuid, payload);
			}
		}
	}

	async function getSharedArticles(): Promise<UserShare[]> {
		return db.userShares.orderBy('createdAt').reverse().toArray();
	}

	return {
		get userShares() {
			return userShares;
		},
		get isLoading() {
			return isLoading;
		},
		load,
		isShared,
		getShareNote,
		share,
		unshare,
		getSharedArticles,
	};
}

export const sharesStore = createSharesStore();
