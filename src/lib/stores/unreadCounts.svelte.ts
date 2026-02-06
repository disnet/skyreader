import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import { socialStore } from './social.svelte';
import { socialReadingStore } from './socialReading.svelte';
import { readingStore } from './reading.svelte';
import { liveDb } from '$lib/services/liveDb.svelte';

/**
 * Centralized unread count computations.
 * Used by Sidebar, NavigationDropdown, and page title.
 */
function createUnreadCountsStore() {
	// Per-feed unread counts
	let feedCounts = $derived.by(() => {
		liveDb.articlesVersion;
		readingStore.readPositions;
		const counts = new Map<number, number>();
		for (const sub of subscriptionsStore.subscriptions) {
			if (sub.id) {
				counts.set(sub.id, articlesStore.getUnreadCount(sub.id));
			}
		}
		return counts;
	});

	// Total unread articles
	let totalArticles = $derived(Array.from(feedCounts.values()).reduce((a, b) => a + b, 0));

	// Unread shares by author
	let sharerShareCounts = $derived.by(() => {
		socialReadingStore.positions;
		const counts = new Map<string, number>();
		for (const share of socialStore.shares) {
			if (!socialReadingStore.isRead(share.recordUri)) {
				counts.set(share.authorDid, (counts.get(share.authorDid) || 0) + 1);
			}
		}
		return counts;
	});

	// Unread documents by author
	let sharerDocCounts = $derived.by(() => {
		socialReadingStore.positions;
		const counts = new Map<string, number>();
		for (const doc of socialStore.documents) {
			if (!socialReadingStore.isRead(doc.recordUri)) {
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
