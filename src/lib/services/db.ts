import Dexie, { type Table } from 'dexie';
import type { Subscription, Article, ShareReadPosition, SocialShare, UserShare } from '$lib/types';

// Local cache for read positions (backend is source of truth)
export interface ReadPositionCache {
	articleGuid: string; // primary key
	starred: boolean;
	readAt: number;
	itemUrl?: string;
	itemTitle?: string;
}

class SkyreaderDatabase extends Dexie {
	subscriptions!: Table<Subscription>;
	articles!: Table<Article>;
	readPositionsCache!: Table<ReadPositionCache>;
	shareReadPositions!: Table<ShareReadPosition>;
	socialShares!: Table<SocialShare>;
	userShares!: Table<UserShare>;

	constructor() {
		super('skyreader');

		this.version(1).stores({
			subscriptions: '++id, atUri, rkey, feedUrl, category, syncStatus, localUpdatedAt',
			articles: '++id, subscriptionId, guid, url, publishedAt, fetchedAt',
			readPositions: '++id, atUri, subscriptionAtUri, articleGuid, starred, syncStatus',
			socialShares: '++id, authorDid, recordUri, itemUrl, createdAt',
			syncQueue: '++id, operation, collection, timestamp',
		});

		// Add rkey index to readPositions for sync-queue lookups
		this.version(2).stores({
			readPositions: '++id, atUri, rkey, subscriptionAtUri, articleGuid, starred, syncStatus',
		});

		// Add userShares table for user's own shares
		this.version(3).stores({
			userShares: '++id, atUri, rkey, articleGuid, articleUrl, syncStatus',
		});

		// Add shareReadPositions table for tracking read status of social shares
		this.version(4).stores({
			shareReadPositions: '++id, atUri, rkey, shareUri, shareAuthorDid, syncStatus',
		});

		// Add rkey index to syncQueue for updating pending items
		this.version(5).stores({
			syncQueue: '++id, operation, collection, rkey, timestamp',
		});

		// Add fetchStatus to track backend feed processing state
		this.version(6).stores({
			subscriptions:
				'++id, atUri, rkey, feedUrl, category, syncStatus, fetchStatus, localUpdatedAt',
		});

		// Remove readPositions table - read status now stored in D1 backend
		this.version(7).stores({
			readPositions: null,
		});

		// Add readPositionsCache table - local cache for faster loads, backend is source of truth
		this.version(8).stores({
			readPositionsCache: 'articleGuid, starred',
		});

		// Add source index for Leaflet sync tracking
		this.version(9).stores({
			subscriptions:
				'++id, atUri, rkey, feedUrl, category, syncStatus, fetchStatus, source, localUpdatedAt',
		});

		// Remove syncQueue table and PDS-related indexes - data now stored only in D1
		this.version(10).stores({
			syncQueue: null, // Remove syncQueue table
			subscriptions: '++id, rkey, feedUrl, category, fetchStatus, source, localUpdatedAt',
			userShares: '++id, rkey, articleGuid, articleUrl',
			shareReadPositions: '++id, rkey, shareUri, shareAuthorDid',
		});
	}
}

export const db = new SkyreaderDatabase();

// Clear all data (for logout)
export async function clearAllData(): Promise<void> {
	await Promise.all([
		db.subscriptions.clear(),
		db.articles.clear(),
		db.readPositionsCache.clear(),
		db.shareReadPositions.clear(),
		db.socialShares.clear(),
		db.userShares.clear(),
	]);
}
