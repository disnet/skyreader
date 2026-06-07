import Dexie, { type Table } from 'dexie';
import type {
  Subscription,
  Article,
  SocialDocument,
  LinkblogShare,
  FilteredView,
  ItemTags,
  ItemLabel,
  SavedItem,
  FollowingPublication,
} from '$lib/types';

// Sync queue for offline operations
export interface SyncQueueEntry {
  id?: number;
  operation: 'create' | 'update' | 'delete';
  collection: 'reading' | 'socialReading' | 'follows' | 'label' | 'saved' | 'integration';
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

// A followed Bluesky account, cached locally so /discover can scan for their
// standard.site publications without re-walking the follow graph each visit.
export interface FollowCacheEntry {
  did: string; // primary key
  handle: string | null;
  displayName?: string;
  avatar?: string;
  // Epoch ms this account's PDS was last scanned for publications (0 = never).
  scannedAt: number;
  // User chose to ignore this account in discovery — never scanned or shown.
  hidden?: boolean;
}

// Cached Semble/Margin collection for the integration share picker.
// Keyed by [integration+uri] so the same Dexie table can hold both integrations.
export interface IntegrationCollectionCacheEntry {
  integration: 'semble' | 'margin';
  uri: string;
  cid: string;
  name?: string;
  description?: string;
  createdAt?: string;
  cachedAt: number;
}

class SkyreaderDatabase extends Dexie {
  subscriptions!: Table<Subscription>;
  articles!: Table<Article>;
  socialDocuments!: Table<SocialDocument>;
  linkblogShares!: Table<LinkblogShare>;
  syncQueue!: Table<SyncQueueEntry>;
  metadata!: Table<MetadataEntry>;
  filteredViews!: Table<FilteredView>;
  itemTags!: Table<ItemTags>;
  itemLabels!: Table<ItemLabel>;
  saved!: Table<SavedItem>;
  integrationCollections!: Table<IntegrationCollectionCacheEntry>;
  follows!: Table<FollowCacheEntry>;
  followingPublications!: Table<FollowingPublication>;

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
        // Migrate existing shareReadPositions to socialReadPositions with type='share'.
        // (The legacy share-read-position shape, since removed from the live types.)
        type LegacyShareReadPosition = {
          rkey?: string;
          shareUri: string;
          shareAuthorDid: string;
          itemUrl: string;
          itemTitle?: string;
          readAt: string;
        };
        const sharePositions = await tx.table('shareReadPositions').toArray();
        const migrated = sharePositions.map((p: LegacyShareReadPosition) => ({
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
            props: {
              readAt: pos.readAt,
              itemUrl: pos.itemUrl,
              itemTitle: pos.itemTitle,
            },
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

    // Add savedArticles table for articles saved from URLs
    this.version(20).stores({
      savedArticles: 'rkey, url',
    });

    // Rename savedArticles to bookmarks
    this.version(21).stores({
      bookmarks: 'rkey, url',
      savedArticles: null,
    });

    // Drop readPositionsCache table (starred/archived now in itemLabels)
    this.version(22).stores({
      readPositionsCache: null,
    });

    // Add itemGuid index to bookmarks for feed save lookups
    this.version(23).stores({
      bookmarks: 'rkey, url, itemGuid',
    });

    // Rename bookmarks table to saved
    this.version(24)
      .stores({
        saved: 'rkey, url, itemGuid',
        bookmarks: null,
      })
      .upgrade(async (tx) => {
        const oldRows = await tx.table('bookmarks').toArray();
        if (oldRows.length > 0) {
          await tx.table('saved').bulkAdd(oldRows);
        }
      });

    // Add sourceType and subjectDid indexes to subscriptions for AT Proto content streams
    this.version(25).stores({
      subscriptions:
        '++id, rkey, feedUrl, category, fetchStatus, source, localUpdatedAt, sourceType, subjectDid',
    });

    // Channels redesign: sourceMode/sourceKeys/autoRule/typeFilter stored as non-indexed fields.
    // Version bump ensures any pending upgrades run before we access the new fields.
    this.version(26).stores({});

    // Add uuid to filteredViews for cross-device sync
    this.version(27)
      .stores({
        filteredViews: '++id, uuid, name, position',
      })
      .upgrade(async (tx) => {
        const views = await tx.table('filteredViews').toArray();
        for (const view of views) {
          if (!view.uuid) {
            await tx.table('filteredViews').update(view.id, {
              uuid: crypto.randomUUID(),
            });
          }
        }
      });

    // Add integrationCollections table for Semble/Margin collection picker cache
    this.version(28).stores({
      integrationCollections: '[integration+uri], integration, cachedAt',
    });

    // Saved channels historically defaulted readFilter='all' from dead-code
    // defaults. Now that readFilter actually drives inbox/archive filtering,
    // coerce those defaults to 'unread' (Inbox only). Users who explicitly
    // pick 'all' after this upgrade keep their choice.
    this.version(29)
      .stores({})
      .upgrade(async (tx) => {
        const views = await tx.table('filteredViews').toArray();
        const now = Date.now();
        for (const view of views) {
          if (view.mode === 'saved' && view.readFilter === 'all') {
            await tx.table('filteredViews').update(view.id, {
              readFilter: 'unread',
              updatedAt: now,
            });
          }
        }
      });

    // Linkblog (Phase 1): local record of articles shared to the user's
    // skyreader-links publication, keyed by external article URL for dedup.
    this.version(30).stores({
      linkblogShares: '++id, articleUrl, rkey',
    });

    // Linkblog Phase 3: locally-tracked boosts (bare recommends) of others' link
    // posts, keyed by the boosted document's record URI for state + un-boosting.
    this.version(31).stores({
      linkblogBoosts: '++id, documentUri, rkey',
    });

    // Phase 4 teardown: the legacy share system is gone. Drop its three tables.
    // (Old records, if any, are abandoned — the app no longer reads shares.)
    this.version(32).stores({
      socialShares: null,
      userShares: null,
      shareReadPositions: null,
    });

    // Phase 7: the recommend/boost write path is removed — every reshare is now a
    // linkblog document. Drop the locally-tracked boosts table.
    this.version(33).stores({
      linkblogBoosts: null,
    });

    // Client-side social-graph cache for /discover: the user's Bluesky follows
    // (with a per-account last-scanned timestamp) and the standard.site
    // publications discovered on them. Lets discovery run entirely in the
    // browser and stay fast on repeat visits.
    this.version(34).stores({
      follows: 'did, scannedAt',
      followingPublications: 'publicationUri, did',
    });

    // Read-state refactor: document reads are unified onto the itemLabels table
    // (item_type='document', label='read'), so the standalone socialReadPositions
    // mirror is dead. Drop it. Existing document reads also live in itemLabels and
    // are re-hydrated by the forward read delta, so nothing is lost.
    this.version(35).stores({
      socialReadPositions: null,
    });
  }
}

export const db = new SkyreaderDatabase();

// Clear all data (for logout)
export async function clearAllData(): Promise<void> {
  await Promise.all([
    db.subscriptions.clear(),
    db.articles.clear(),
    db.socialDocuments.clear(),
    db.linkblogShares.clear(),
    db.syncQueue.clear(),
    db.metadata.clear(),
    db.filteredViews.clear(),
    db.itemTags.clear(),
    db.itemLabels.clear(),
    db.saved.clear(),
    db.integrationCollections.clear(),
    db.follows.clear(),
    db.followingPublications.clear(),
  ]);
}

/**
 * Verify IndexedDB is accessible and the Dexie schema is intact.
 * If the database is corrupted or unavailable (common on iOS after long idle
 * or under storage pressure), delete and recreate it so the app can start
 * with an empty cache instead of white-screening.
 *
 * Returns true if healthy, false if the DB had to be reset.
 */
export async function checkDbHealth(): Promise<boolean> {
  try {
    // Attempt a lightweight read — this forces Dexie to open the DB and
    // run any pending version upgrades.
    await db.metadata.get('__health_check__');
    return true;
  } catch (e) {
    console.error('IndexedDB health check failed, resetting database:', e);
    try {
      db.close();
      await Dexie.delete('skyreader');
      // Re-open so subsequent code can use db normally
      await db.open();
    } catch (resetError) {
      console.error('Failed to reset IndexedDB:', resetError);
    }
    return false;
  }
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
