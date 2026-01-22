import { db } from '$lib/services/db';
import { syncQueue } from '$lib/services/sync-queue';
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
		try {
			const positions = await db.shareReadPositions.toArray();
			shareReadPositions = new Map(positions.map((p) => [p.shareUri, p]));
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
			syncStatus: 'pending',
		};

		// Update map immediately to prevent race conditions
		shareReadPositions.set(shareUri, { ...position });
		shareReadPositions = new Map(shareReadPositions);

		const id = await db.shareReadPositions.add(position);
		shareReadPositions.set(shareUri, { ...position, id });
		shareReadPositions = new Map(shareReadPositions);

		// Build record, only including optional fields if they have valid values
		const record: Record<string, unknown> = {
			shareUri,
			shareAuthorDid,
			readAt: now,
		};
		// Only include itemUrl if it looks like a valid URL
		if (itemUrl && (itemUrl.startsWith('http://') || itemUrl.startsWith('https://'))) {
			record.itemUrl = itemUrl;
		}
		// Only include itemTitle if present
		if (itemTitle) {
			record.itemTitle = itemTitle;
		}

		await syncQueue.enqueue({
			operation: 'create',
			collection: 'app.skyreader.social.shareReadPosition',
			rkey,
			record,
		});
	}

	async function markAsUnread(shareUri: string) {
		const position = shareReadPositions.get(shareUri);
		if (!position || !position.id) return;

		// Delete from local DB
		await db.shareReadPositions.delete(position.id);

		// Remove from map
		shareReadPositions.delete(shareUri);
		shareReadPositions = new Map(shareReadPositions);

		// Queue delete to sync to server
		if (position.syncStatus === 'synced' && position.rkey) {
			await syncQueue.enqueue({
				operation: 'delete',
				collection: 'app.skyreader.social.shareReadPosition',
				rkey: position.rkey,
			});
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
