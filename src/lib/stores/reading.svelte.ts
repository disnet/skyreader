import { api } from '$lib/services/api';
import { db, type ReadPositionCache } from '$lib/services/db';
import {
  realtime,
  type ReadPositionSyncPayload,
  type ReadPositionDeletePayload,
  type ReadPositionStarPayload,
  type ReadPositionBulkSyncPayload,
} from '$lib/services/realtime';

interface ReadPosition {
  starred: boolean;
  readAt: number;
  itemUrl?: string;
  itemTitle?: string;
}

// Type exported for use in starred page
export interface StarredArticle {
  articleGuid: string;
  articleUrl?: string;
  articleTitle?: string;
  readAt: number;
}

function createReadingStore() {
  let readPositions = $state<Map<string, ReadPosition>>(new Map());
  let isLoading = $state(true);
  let hasLoaded = false;

  // Helper to update the local IndexedDB cache
  async function updateCache(articleGuid: string, position: ReadPosition) {
    try {
      await db.readPositionsCache.put({
        articleGuid,
        starred: position.starred,
        readAt: position.readAt,
        itemUrl: position.itemUrl,
        itemTitle: position.itemTitle,
      });
    } catch (e) {
      console.error('Failed to update cache:', e);
    }
  }

  // Helper to remove from cache
  async function removeFromCache(articleGuid: string) {
    try {
      await db.readPositionsCache.delete(articleGuid);
    } catch (e) {
      console.error('Failed to remove from cache:', e);
    }
  }

  // Helper to sync entire cache from backend data
  async function syncCache(positions: Map<string, ReadPosition>) {
    try {
      // Clear and repopulate cache
      await db.readPositionsCache.clear();
      const items: ReadPositionCache[] = Array.from(positions.entries()).map(
        ([articleGuid, pos]) => ({
          articleGuid,
          starred: pos.starred,
          readAt: pos.readAt,
          itemUrl: pos.itemUrl,
          itemTitle: pos.itemTitle,
        })
      );
      if (items.length > 0) {
        await db.readPositionsCache.bulkPut(items);
      }
    } catch (e) {
      console.error('Failed to sync cache:', e);
    }
  }

  // Load read positions - stale-while-revalidate pattern
  async function load() {
    isLoading = true;

    // 1. First, try to load from local cache for instant display
    try {
      const cached = await db.readPositionsCache.toArray();
      if (cached.length > 0) {
        readPositions = new Map(
          cached.map((p) => [
            p.articleGuid,
            {
              starred: p.starred,
              readAt: p.readAt,
              itemUrl: p.itemUrl,
              itemTitle: p.itemTitle,
            },
          ])
        );
        // Show cached data immediately, but keep loading
        isLoading = false;
      }
    } catch (e) {
      console.error('Failed to load from cache:', e);
    }

    // 2. Then fetch from backend and update
    try {
      const { positions } = await api.getReadPositions();
      const newPositions = new Map(
        positions.map((p) => [
          p.item_guid,
          {
            starred: !!p.starred,
            readAt: p.read_at,
            itemUrl: p.item_url || undefined,
            itemTitle: p.item_title || undefined,
          },
        ])
      );
      readPositions = newPositions;
      hasLoaded = true;

      // Update cache in background
      syncCache(newPositions);
    } catch (e) {
      console.error('Failed to load read positions from backend:', e);
      // If backend fails but we have cached data, that's ok
      if (readPositions.size > 0) {
        hasLoaded = true;
      }
    } finally {
      isLoading = false;
    }
  }

  function isRead(articleGuid: string): boolean {
    return readPositions.has(articleGuid);
  }

  function isStarred(articleGuid: string): boolean {
    return readPositions.get(articleGuid)?.starred ?? false;
  }

  async function markAsRead(
    _subscriptionAtUri: string,
    articleGuid: string,
    articleUrl: string,
    articleTitle?: string
  ) {
    // Skip if already read
    if (readPositions.has(articleGuid)) return;

    const position: ReadPosition = {
      starred: false,
      readAt: Date.now(),
      itemUrl: articleUrl,
      itemTitle: articleTitle,
    };

    // Optimistic update
    readPositions.set(articleGuid, position);
    readPositions = new Map(readPositions);

    try {
      await api.markAsRead({
        itemGuid: articleGuid,
        itemUrl: articleUrl,
        itemTitle: articleTitle,
      });
      // Update cache on success
      updateCache(articleGuid, position);
    } catch (e) {
      // Rollback on failure
      readPositions.delete(articleGuid);
      readPositions = new Map(readPositions);
      console.error('Failed to mark as read:', e);
    }
  }

  async function markAllAsRead(
    articles: Array<{
      subscriptionAtUri: string;
      articleGuid: string;
      articleUrl: string;
      articleTitle?: string;
    }>
  ) {
    // Filter out already-read articles
    const unreadArticles = articles.filter((a) => !readPositions.has(a.articleGuid));
    if (unreadArticles.length === 0) return;

    // Optimistic update
    const now = Date.now();
    const newPositions: Array<{ guid: string; position: ReadPosition }> = [];
    for (const article of unreadArticles) {
      const position: ReadPosition = {
        starred: false,
        readAt: now,
        itemUrl: article.articleUrl,
        itemTitle: article.articleTitle,
      };
      readPositions.set(article.articleGuid, position);
      newPositions.push({ guid: article.articleGuid, position });
    }
    readPositions = new Map(readPositions);

    try {
      await api.markAsReadBulk(
        unreadArticles.map((a) => ({
          itemGuid: a.articleGuid,
          itemUrl: a.articleUrl,
          itemTitle: a.articleTitle,
        }))
      );
      // Update cache on success
      for (const { guid, position } of newPositions) {
        updateCache(guid, position);
      }
    } catch (e) {
      // Rollback on failure
      for (const article of unreadArticles) {
        readPositions.delete(article.articleGuid);
      }
      readPositions = new Map(readPositions);
      console.error('Failed to mark all as read:', e);
    }
  }

  async function markAsUnread(articleGuid: string) {
    const position = readPositions.get(articleGuid);
    if (!position) return;

    // Optimistic update
    readPositions.delete(articleGuid);
    readPositions = new Map(readPositions);

    try {
      await api.markAsUnread(articleGuid);
      // Update cache on success
      removeFromCache(articleGuid);
    } catch (e) {
      // Rollback on failure
      readPositions.set(articleGuid, position);
      readPositions = new Map(readPositions);
      console.error('Failed to mark as unread:', e);
    }
  }

  async function toggleStar(articleGuid: string) {
    const position = readPositions.get(articleGuid);
    if (!position) return;

    const newStarred = !position.starred;
    const newPosition = { ...position, starred: newStarred };

    // Optimistic update
    readPositions.set(articleGuid, newPosition);
    readPositions = new Map(readPositions);

    try {
      await api.toggleStar(articleGuid, newStarred);
      // Update cache on success
      updateCache(articleGuid, newPosition);
    } catch (e) {
      // Rollback on failure
      readPositions.set(articleGuid, position);
      readPositions = new Map(readPositions);
      console.error('Failed to toggle star:', e);
    }
  }

  function getStarredArticles(): StarredArticle[] {
    return Array.from(readPositions.entries())
      .filter(([, pos]) => pos.starred)
      .map(([guid, pos]) => ({
        articleGuid: guid,
        articleUrl: pos.itemUrl,
        articleTitle: pos.itemTitle,
        readAt: pos.readAt,
      }));
  }

  // Get unread count for a subscription (articles from IndexedDB, read status from memory)
  async function getUnreadCount(subscriptionId: number): Promise<number> {
    try {
      const articles = await db.articles.where('subscriptionId').equals(subscriptionId).toArray();
      return articles.filter((a) => !readPositions.has(a.guid)).length;
    } catch {
      return 0;
    }
  }

  // Listen for realtime updates from other devices
  realtime.on('read_position_sync', (payload) => {
    const data = payload as ReadPositionSyncPayload;
    // Only add if we don't already have it (avoid duplicates from own actions)
    if (!readPositions.has(data.itemGuid)) {
      const position: ReadPosition = {
        starred: data.starred,
        readAt: data.readAt,
        itemUrl: data.itemUrl,
        itemTitle: data.itemTitle,
      };
      readPositions.set(data.itemGuid, position);
      readPositions = new Map(readPositions);
      // Update cache
      updateCache(data.itemGuid, position);
    }
  });

  realtime.on('read_position_delete', (payload) => {
    const data = payload as ReadPositionDeletePayload;
    if (readPositions.has(data.itemGuid)) {
      readPositions.delete(data.itemGuid);
      readPositions = new Map(readPositions);
      // Update cache
      removeFromCache(data.itemGuid);
    }
  });

  realtime.on('read_position_star', (payload) => {
    const data = payload as ReadPositionStarPayload;
    const position = readPositions.get(data.itemGuid);
    if (position) {
      const newPosition = { ...position, starred: data.starred };
      readPositions.set(data.itemGuid, newPosition);
      readPositions = new Map(readPositions);
      // Update cache
      updateCache(data.itemGuid, newPosition);
    }
  });

  realtime.on('read_position_bulk_sync', (payload) => {
    const data = payload as ReadPositionBulkSyncPayload;
    let changed = false;
    const newItems: Array<{ guid: string; position: ReadPosition }> = [];
    for (const item of data.items) {
      if (!readPositions.has(item.itemGuid)) {
        const position: ReadPosition = {
          starred: item.starred,
          readAt: item.readAt,
        };
        readPositions.set(item.itemGuid, position);
        newItems.push({ guid: item.itemGuid, position });
        changed = true;
      }
    }
    if (changed) {
      readPositions = new Map(readPositions);
      // Update cache
      for (const { guid, position } of newItems) {
        updateCache(guid, position);
      }
    }
  });

  // Catch-up sync when reconnecting after being offline
  realtime.onConnectionChange((connected) => {
    if (connected && hasLoaded) {
      // Reconnected after being offline - catch up from backend
      load();
    }
  });

  return {
    get readPositions() {
      return readPositions;
    },
    get isLoading() {
      return isLoading;
    },
    load,
    isRead,
    isStarred,
    markAsRead,
    markAllAsRead,
    markAsUnread,
    toggleStar,
    getStarredArticles,
    getUnreadCount,
  };
}

export const readingStore = createReadingStore();
