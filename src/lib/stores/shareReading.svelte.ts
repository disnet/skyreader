import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
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
		};

		// Use dedicated share read endpoint
		await api.markShareAsRead({
			rkey,
			shareUri,
			shareAuthorDid,
			// Only include itemUrl if it looks like a valid URL
			itemUrl:
				itemUrl && (itemUrl.startsWith('http://') || itemUrl.startsWith('https://'))
					? itemUrl
					: undefined,
			itemTitle: itemTitle || undefined,
		});

		// Update local state and cache
		shareReadPositions.set(shareUri, { ...position });
		shareReadPositions = new Map(shareReadPositions);

		const id = await db.shareReadPositions.add(position);
		shareReadPositions.set(shareUri, { ...position, id });
		shareReadPositions = new Map(shareReadPositions);
	}

	async function markAsUnread(shareUri: string) {
		const position = shareReadPositions.get(shareUri);
		if (!position || !position.id) return;

		// Use dedicated share read endpoint
		if (position.rkey) {
			await api.markShareAsUnread(position.rkey);
		}

		// Delete from local DB
		await db.shareReadPositions.delete(position.id);

		// Remove from map
		shareReadPositions.delete(shareUri);
		shareReadPositions = new Map(shareReadPositions);
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
