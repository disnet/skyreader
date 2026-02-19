import Dexie, { type Table } from 'dexie';
import type {
  Subscription,
  Article,
  ShareReadPosition,
  SocialReadPosition,
  SocialDocument,
  SocialShare,
  UserShare,
  FilteredView,
  ItemTags,
  ItemLabel,
} from '$lib/types';

// Local cache for read positions (backend is source of truth)
export interface ReadPositionCache {
  articleGuid: string; // primary key
  starred: boolean;
  archived?: boolean; // for read-it-later inbox/archive
  readAt: number;
  itemUrl?: string;
  itemTitle?: string;
}

// Sync queue for offline operations
export interface SyncQueueEntry {
  id?: number;
  operation: 'create' | 'update' | 'delete';
  collection: 'reading' | 'shares' | 'shareReading' | 'socialReading' | 'follows';
  key: string; // Deduplication key (e.g., articleGuid, rkey)
  payload: string; // JSON-serialized data
  timestamp: number;
  retryCount: number;
  status: 'pending' | 'processing' | 'failed';
}

// Metadata key-value store for app state persistence
export interface MetadataEntry {
  key: string; // primary key
  value: string; // JSON-serialized value
}

class SkyreaderDatabase extends Dexie {
  subscriptions!: Table<Subscription>;
  articles!: Table<Article>;
  readPositionsCache!: Table<ReadPositionCache>;
  shareReadPositions!: Table<ShareReadPosition>;
  socialReadPositions!: Table<SocialReadPosition>;
  socialShares!: Table<SocialShare>;
  socialDocuments!: Table<SocialDocument>;
  userShares!: Table<UserShare>;
  syncQueue!: Table<SyncQueueEntry>;
  metadata!: Table<MetadataEntry>;
  filteredViews!: Table<FilteredView>;
  itemTags!: Table<ItemTags>;
  itemLabels!: Table<ItemLabel>;

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

    // Add syncQueue back for offline support
    this.version(11).stores({
      syncQueue: '++id, [collection+key], status, timestamp',
    });

    // Add metadata table for persisting app state
    this.version(12).stores({
      metadata: 'key',
    });

    // Add socialDocuments table for caching site.standard.document records
    this.version(13).stores({
      socialDocuments: '++id, authorDid, recordUri, canonicalUrl, publishedAt',
    });

    // Add content field to socialDocuments for pub.leaflet.content support
    // Note: Dexie handles new fields automatically, but we increment version for clarity
    this.version(14).stores({
      socialDocuments: '++id, authorDid, recordUri, canonicalUrl, publishedAt',
    });

    // Add unified socialReadPositions table for tracking read state across all social item types
    this.version(15)
      .stores({
        socialReadPositions: '++id, rkey, type, itemUri, authorDid',
      })
      .upgrade(async (tx) => {
        // Migrate existing shareReadPositions to socialReadPositions with type='share'
        const sharePositions = await tx.table('shareReadPositions').toArray();
        const migrated = sharePositions.map((p: ShareReadPosition) => ({
          rkey: p.rkey,
          type: 'share' as const,
          itemUri: p.shareUri,
          authorDid: p.shareAuthorDid,
          itemUrl: p.itemUrl,
          itemTitle: p.itemTitle,
          readAt: p.readAt,
        }));
        if (migrated.length > 0) {
          await tx.table('socialReadPositions').bulkAdd(migrated);
        }
      });

    // Add filteredViews table for user-created filtered views
    this.version(16).stores({
      filteredViews: '++id, name, position',
    });

    // Add itemTags table for client-side tagging of feed items
    this.version(17).stores({
      itemTags: 'itemKey, *tags',
    });

    // Add archived field index to readPositionsCache for inbox/archive bookmarks view
    this.version(18).stores({
      readPositionsCache: 'articleGuid, starred, archived',
    });

    // Add unified itemLabels table, replacing readPositionsCache and itemTags
    this.version(19)
      .stores({
        itemLabels: '[itemKey+label], itemKey, label, itemType',
        // Keep old tables during migration for safety - they'll be unused
        readPositionsCache: 'articleGuid, starred, archived',
        itemTags: 'itemKey, *tags',
      })
      .upgrade(async (tx) => {
        const labelsTable = tx.table('itemLabels');
        const now = Date.now();

        // Migrate readPositionsCache → itemLabels
        const readPositions = await tx.table('readPositionsCache').toArray();
        for (const pos of readPositions) {
          // Create 'read' label
          await labelsTable.put({
            itemKey: pos.articleGuid,
            itemType: 'article',
            label: 'read',
            props: { readAt: pos.readAt, itemUrl: pos.itemUrl, itemTitle: pos.itemTitle },
            createdAt: pos.readAt || now,
            updatedAt: now,
          });

          // Create 'starred' label if starred
          if (pos.starred) {
            await labelsTable.put({
              itemKey: pos.articleGuid,
              itemType: 'article',
              label: 'starred',
              props: {
                starredAt: pos.readAt || now,
                itemUrl: pos.itemUrl,
                itemTitle: pos.itemTitle,
              },
              createdAt: pos.readAt || now,
              updatedAt: now,
            });
          }

          // Create 'archived' label if archived
          if (pos.archived) {
            await labelsTable.put({
              itemKey: pos.articleGuid,
              itemType: 'article',
              label: 'archived',
              props: { archivedAt: now },
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        // Migrate itemTags → itemLabels
        const tagEntries = await tx.table('itemTags').toArray();
        for (const entry of tagEntries) {
          if (!Array.isArray(entry.tags)) continue;
          for (const tag of entry.tags) {
            await labelsTable.put({
              itemKey: entry.itemKey,
              itemType: entry.itemType || 'article',
              label: `tag:${tag}`,
              props: {},
              createdAt: now,
              updatedAt: now,
            });
          }
        }
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
    db.socialReadPositions.clear(),
    db.socialShares.clear(),
    db.socialDocuments.clear(),
    db.userShares.clear(),
    db.syncQueue.clear(),
    db.metadata.clear(),
    db.filteredViews.clear(),
    db.itemTags.clear(),
    db.itemLabels.clear(),
  ]);
}

// Metadata helpers for persisting app state
export async function getMetadata<T>(key: string): Promise<T | null> {
  const entry = await db.metadata.get(key);
  if (!entry) return null;
  try {
    return JSON.parse(entry.value) as T;
  } catch {
    return null;
  }
}

export async function setMetadata<T>(key: string, value: T): Promise<void> {
  await db.metadata.put({ key, value: JSON.stringify(value) });
}
