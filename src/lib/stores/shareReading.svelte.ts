import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
import { syncQueue, type ShareReadingPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import type { ShareReadPosition } from '$lib/types';

function generateTid(): string {
	const now = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `${now.toString(36)}${random}`;
}

function createShareReadingStore() {
	let shareReadPositions = $state<Map<string, ShareReadPosition>>(new Map());
	let isLoading = $state(true);

	async function load() {
		isLoading = true;

		// 1. First, try to load from local cache for instant display
		try {
			const cached = await db.shareReadPositions.toArray();
			if (cached.length > 0) {
				shareReadPositions = new Map(cached.map((p) => [p.shareUri, p]));
				// Show cached data immediately, but keep loading
				isLoading = false;
			}
		} catch (e) {
			console.error('Failed to load share read positions from cache:', e);
		}

		// 2. Then fetch from backend and update
		try {
			const { positions } = await api.getShareReadPositions();

			// Clear and rebuild the cache
			await db.shareReadPositions.clear();

			const newPositions = new Map<string, ShareReadPosition>();
			for (const p of positions) {
				const position: Omit<ShareReadPosition, 'id'> = {
					rkey: p.rkey,
					shareUri: p.shareUri,
					shareAuthorDid: p.shareAuthorDid,
					itemUrl: p.itemUrl || '',
					itemTitle: p.itemTitle || undefined,
					readAt: p.readAt,
				};
				const id = await db.shareReadPositions.add(position);
				newPositions.set(p.shareUri, { ...position, id });
			}

			shareReadPositions = newPositions;
		} catch (e) {
			console.error('Failed to load share read positions from backend:', e);
			// If backend fails but we have cached data, that's ok
		} finally {
			isLoading = false;
		}
	}

	function isRead(shareUri: string): boolean {
		return shareReadPositions.has(shareUri);
	}

	async function markAsRead(
		shareUri: string,
		shareAuthorDid: string,
		itemUrl: string,
		itemTitle?: string
	) {
		// Check if already read - skip if so
		if (shareReadPositions.has(shareUri)) return;

		const rkey = generateTid();
		const now = new Date().toISOString();

		const position: Omit<ShareReadPosition, 'id'> = {
			rkey,
			shareUri,
			shareAuthorDid,
			itemUrl,
			itemTitle,
			readAt: now,
		};

		// Optimistic update - add to local state and cache
		shareReadPositions.set(shareUri, { ...position });
		shareReadPositions = new Map(shareReadPositions);

		const id = await db.shareReadPositions.add(position);
		shareReadPositions.set(shareUri, { ...position, id });
		shareReadPositions = new Map(shareReadPositions);

		const payload: ShareReadingPayload = {
			rkey,
			shareUri,
			shareAuthorDid,
			itemUrl:
				itemUrl && (itemUrl.startsWith('http://') || itemUrl.startsWith('https://'))
					? itemUrl
					: undefined,
			itemTitle: itemTitle || undefined,
		};

		if (syncStore.isOnline) {
			try {
				await api.markShareAsRead({
					rkey,
					shareUri,
					shareAuthorDid,
					itemUrl: payload.itemUrl,
					itemTitle: payload.itemTitle,
				});
			} catch (e) {
				console.error('Failed to mark share as read, queueing for retry:', e);
				await syncQueue.enqueue('create', 'shareReading', shareUri, payload);
			}
		} else {
			// Offline - queue the operation
			await syncQueue.enqueue('create', 'shareReading', shareUri, payload);
		}
	}

	async function markAsUnread(shareUri: string) {
		const position = shareReadPositions.get(shareUri);
		if (!position || !position.id || !position.rkey) return;

		// Optimistic update - remove from local state and cache
		shareReadPositions.delete(shareUri);
		shareReadPositions = new Map(shareReadPositions);

		await db.shareReadPositions.delete(position.id);

		const payload: ShareReadingPayload = {
			rkey: position.rkey,
			shareUri,
			shareAuthorDid: position.shareAuthorDid,
		};

		if (syncStore.isOnline) {
			try {
				await api.markShareAsUnread(position.rkey);
			} catch (e) {
				console.error('Failed to mark share as unread, queueing for retry:', e);
				await syncQueue.enqueue('delete', 'shareReading', shareUri, payload);
			}
		} else {
			// Offline - queue the operation
			await syncQueue.enqueue('delete', 'shareReading', shareUri, payload);
		}
	}

	return {
		get shareReadPositions() {
			return shareReadPositions;
		},
		get isLoading() {
			return isLoading;
		},
		load,
		isRead,
		markAsRead,
		markAsUnread,
	};
}

export const shareReadingStore = createShareReadingStore();
