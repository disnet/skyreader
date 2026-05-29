import { db } from '$lib/services/db';
import { safeAdd } from '$lib/services/safeDb.svelte';
import { api } from '$lib/services/api';
import { syncQueue, type SocialReadingPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { generateTid } from '$lib/utils/tid';
import type { SocialReadPosition, SocialItemType } from '$lib/types';

const BULK_BATCH_SIZE = 500; // Must match backend limit

function createSocialReadingStore() {
  let positions = $state<Map<string, SocialReadPosition>>(new Map());
  let isLoading = $state(true);

  async function load() {
    isLoading = true;

    // 1. First, try to load from local cache for instant display
    try {
      const cached = await db.socialReadPositions.toArray();
      if (cached.length > 0) {
        positions = new Map(cached.map((p) => [p.itemUri, p]));
        // Show cached data immediately, but keep loading
        isLoading = false;
      }
    } catch (e) {
      console.error('Failed to load social read positions from cache:', e);
    }

    // 2. Then fetch from backend and update
    try {
      const { positions: backendPositions } = await api.getSocialReadPositions();

      // Clear and rebuild the cache
      await db.socialReadPositions.clear();

      const newPositions = new Map<string, SocialReadPosition>();
      for (const p of backendPositions) {
        const position: Omit<SocialReadPosition, 'id'> = {
          rkey: p.rkey,
          type: p.type,
          itemUri: p.itemUri,
          authorDid: p.authorDid,
          itemUrl: p.itemUrl || '',
          itemTitle: p.itemTitle || undefined,
          readAt: p.readAt,
        };
        const id = await safeAdd(db.socialReadPositions, position);
        newPositions.set(p.itemUri, { ...position, id });
      }

      positions = newPositions;
    } catch (e) {
      console.error('Failed to load social read positions from backend:', e);
      // If backend fails but we have cached data, that's ok
    } finally {
      isLoading = false;
    }
  }

  function isRead(itemUri: string): boolean {
    return positions.has(itemUri);
  }

  async function markAsRead(
    type: SocialItemType,
    itemUri: string,
    authorDid: string,
    itemUrl: string,
    itemTitle?: string
  ) {
    // Check if already read - skip if so
    if (positions.has(itemUri)) return;

    const rkey = generateTid();
    const now = new Date().toISOString();

    const position: Omit<SocialReadPosition, 'id'> = {
      rkey,
      type,
      itemUri,
      authorDid,
      itemUrl,
      itemTitle,
      readAt: now,
    };

    // Optimistic update - add to local state and cache
    positions.set(itemUri, { ...position });
    positions = new Map(positions);

    const id = await safeAdd(db.socialReadPositions, position);
    positions.set(itemUri, { ...position, id });
    positions = new Map(positions);

    const payload: SocialReadingPayload = {
      type,
      rkey,
      itemUri,
      authorDid,
      itemUrl:
        itemUrl && (itemUrl.startsWith('http://') || itemUrl.startsWith('https://'))
          ? itemUrl
          : undefined,
      itemTitle: itemTitle || undefined,
    };

    if (syncStore.isOnline) {
      try {
        await api.markSocialItemAsRead({
          type,
          rkey,
          itemUri,
          authorDid,
          itemUrl: payload.itemUrl,
          itemTitle: payload.itemTitle,
        });
      } catch (e) {
        console.error('Failed to mark social item as read, queueing for retry:', e);
        await syncQueue.enqueue('create', 'socialReading', itemUri, payload);
      }
    } else {
      // Offline - queue the operation
      await syncQueue.enqueue('create', 'socialReading', itemUri, payload);
    }
  }

  async function markAllAsRead(
    items: Array<{
      type: SocialItemType;
      itemUri: string;
      authorDid: string;
      itemUrl: string;
      itemTitle?: string;
    }>
  ) {
    // Filter out already-read items
    const unreadItems = items.filter((item) => !positions.has(item.itemUri));
    if (unreadItems.length === 0) return;

    const now = new Date().toISOString();
    const itemsWithRkeys = unreadItems.map((item) => ({
      ...item,
      rkey: generateTid(),
    }));

    // Optimistic update - add all to local state
    for (const item of itemsWithRkeys) {
      const position: Omit<SocialReadPosition, 'id'> = {
        rkey: item.rkey,
        type: item.type,
        itemUri: item.itemUri,
        authorDid: item.authorDid,
        itemUrl: item.itemUrl,
        itemTitle: item.itemTitle,
        readAt: now,
      };
      positions.set(item.itemUri, { ...position });
    }
    positions = new Map(positions);

    // Update local cache
    for (const item of itemsWithRkeys) {
      const position: Omit<SocialReadPosition, 'id'> = {
        rkey: item.rkey,
        type: item.type,
        itemUri: item.itemUri,
        authorDid: item.authorDid,
        itemUrl: item.itemUrl,
        itemTitle: item.itemTitle,
        readAt: now,
      };
      const id = await safeAdd(db.socialReadPositions, position);
      positions.set(item.itemUri, { ...position, id });
    }
    positions = new Map(positions);

    // Build API payloads once
    const apiItems = itemsWithRkeys.map((item) => ({
      type: item.type,
      rkey: item.rkey,
      itemUri: item.itemUri,
      authorDid: item.authorDid,
      itemUrl:
        item.itemUrl && (item.itemUrl.startsWith('http://') || item.itemUrl.startsWith('https://'))
          ? item.itemUrl
          : undefined,
      itemTitle: item.itemTitle || undefined,
    }));

    // Send to backend
    if (syncStore.isOnline) {
      try {
        // Chunk to stay within backend's 500-item limit
        for (let i = 0; i < apiItems.length; i += BULK_BATCH_SIZE) {
          await api.markSocialItemsAsReadBulk(apiItems.slice(i, i + BULK_BATCH_SIZE));
        }
      } catch (e) {
        console.error('Failed to bulk mark social items as read, queueing for retry:', e);
        for (const item of apiItems) {
          await syncQueue.enqueue(
            'create',
            'socialReading',
            item.itemUri,
            item as SocialReadingPayload
          );
        }
      }
    } else {
      for (const item of apiItems) {
        await syncQueue.enqueue(
          'create',
          'socialReading',
          item.itemUri,
          item as SocialReadingPayload
        );
      }
    }
  }

  async function markAsUnread(itemUri: string) {
    const position = positions.get(itemUri);
    if (!position || !position.id || !position.rkey) return;

    // Optimistic update - remove from local state and cache
    positions.delete(itemUri);
    positions = new Map(positions);

    await db.socialReadPositions.delete(position.id);

    const payload: SocialReadingPayload = {
      type: position.type,
      rkey: position.rkey,
      itemUri,
      authorDid: position.authorDid,
    };

    if (syncStore.isOnline) {
      try {
        await api.markSocialItemAsUnread(position.rkey);
      } catch (e) {
        console.error('Failed to mark social item as unread, queueing for retry:', e);
        await syncQueue.enqueue('delete', 'socialReading', itemUri, payload);
      }
    } else {
      // Offline - queue the operation
      await syncQueue.enqueue('delete', 'socialReading', itemUri, payload);
    }
  }

  return {
    get positions() {
      return positions;
    },
    get isLoading() {
      return isLoading;
    },
    load,
    isRead,
    markAsRead,
    markAllAsRead,
    markAsUnread,
  };
}

export const socialReadingStore = createSocialReadingStore();
