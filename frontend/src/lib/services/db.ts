import Dexie, { type Table } from 'dexie';
import type { Subscription, Article, ReadPosition, ShareReadPosition, SocialShare, UserShare, SyncQueueItem } from '$lib/types';

class ATRSSDatabase extends Dexie {
  subscriptions!: Table<Subscription>;
  articles!: Table<Article>;
  readPositions!: Table<ReadPosition>;
  shareReadPositions!: Table<ShareReadPosition>;
  socialShares!: Table<SocialShare>;
  userShares!: Table<UserShare>;
  syncQueue!: Table<SyncQueueItem>;

  constructor() {
    super('at-rss');

    this.version(1).stores({
      subscriptions: '++id, atUri, rkey, feedUrl, category, syncStatus, localUpdatedAt',
      articles: '++id, subscriptionId, guid, url, publishedAt, fetchedAt',
      readPositions: '++id, atUri, subscriptionAtUri, articleGuid, starred, syncStatus',
      socialShares: '++id, authorDid, recordUri, itemUrl, createdAt',
      syncQueue: '++id, operation, collection, timestamp'
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
      subscriptions: '++id, atUri, rkey, feedUrl, category, syncStatus, fetchStatus, localUpdatedAt',
    });
  }
}

export const db = new ATRSSDatabase();

// Helper to check if article is read
export async function isArticleRead(articleGuid: string): Promise<boolean> {
  const position = await db.readPositions.where('articleGuid').equals(articleGuid).first();
  return !!position;
}

// Helper to get unread count for a subscription
export async function getUnreadCount(subscriptionId: number): Promise<number> {
  const articles = await db.articles.where('subscriptionId').equals(subscriptionId).toArray();
  const readGuids = new Set(
    (await db.readPositions.toArray()).map(p => p.articleGuid)
  );
  return articles.filter(a => !readGuids.has(a.guid)).length;
}

// Helper to get all starred articles
export async function getStarredArticles(): Promise<ReadPosition[]> {
  return db.readPositions.where('starred').equals(1).toArray();
}

// Clear all data (for logout)
export async function clearAllData(): Promise<void> {
  await Promise.all([
    db.subscriptions.clear(),
    db.articles.clear(),
    db.readPositions.clear(),
    db.shareReadPositions.clear(),
    db.socialShares.clear(),
    db.userShares.clear(),
    db.syncQueue.clear()
  ]);
}
