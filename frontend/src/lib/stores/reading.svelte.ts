import { db } from '$lib/services/db';
import { syncQueue } from '$lib/services/sync-queue';
import type { ReadPosition } from '$lib/types';

function generateTid(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${now.toString(36)}${random}`;
}

// Debounce delay for batching read state updates (ms)
const READ_BATCH_DELAY = 500;

function createReadingStore() {
  let readPositions = $state<Map<string, ReadPosition>>(new Map());
  let isLoading = $state(true);

  // Pending read positions waiting to be enqueued
  let pendingReads: Array<{
    rkey: string;
    record: Record<string, unknown>;
  }> = [];
  let flushTimeout: ReturnType<typeof setTimeout> | null = null;

  async function flushPendingReads() {
    if (pendingReads.length === 0) return;

    const toEnqueue = pendingReads;
    pendingReads = [];
    flushTimeout = null;

    // Enqueue all pending reads as a batch
    for (const { rkey, record } of toEnqueue) {
      await syncQueue.enqueue({
        operation: 'create',
        collection: 'com.at-rss.feed.readPosition',
        rkey,
        record,
      });
    }
  }

  function scheduleFlush() {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
    }
    flushTimeout = setTimeout(() => {
      flushPendingReads();
    }, READ_BATCH_DELAY);
  }

  async function load() {
    isLoading = true;
    try {
      const positions = await db.readPositions.toArray();
      readPositions = new Map(positions.map((p) => [p.articleGuid, p]));
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
    subscriptionAtUri: string,
    articleGuid: string,
    articleUrl: string,
    articleTitle?: string
  ) {
    // Check if already read - skip if so
    if (readPositions.has(articleGuid)) return;

    const rkey = generateTid();
    const now = new Date().toISOString();

    const position: Omit<ReadPosition, 'id'> = {
      rkey,
      subscriptionAtUri,
      articleGuid,
      articleUrl,
      articleTitle,
      readAt: now,
      starred: false,
      syncStatus: 'pending',
    };

    // Update map immediately to prevent race conditions
    readPositions.set(articleGuid, { ...position });
    readPositions = new Map(readPositions);

    const id = await db.readPositions.add(position);
    readPositions.set(articleGuid, { ...position, id });
    readPositions = new Map(readPositions);

    // Build record, only including optional fields if they have valid values
    const record: Record<string, unknown> = {
      itemGuid: articleGuid,
      readAt: now,
      starred: false,
    };
    // Only include subscriptionUri if it's a valid AT URI
    if (subscriptionAtUri && subscriptionAtUri.startsWith('at://')) {
      record.subscriptionUri = subscriptionAtUri;
    }
    // Only include itemUrl if it looks like a valid URL
    if (articleUrl && (articleUrl.startsWith('http://') || articleUrl.startsWith('https://'))) {
      record.itemUrl = articleUrl;
    }
    // Only include itemTitle if present
    if (articleTitle) {
      record.itemTitle = articleTitle;
    }

    // Add to pending batch and schedule debounced flush
    pendingReads.push({ rkey, record });
    scheduleFlush();
  }

  async function markAsUnread(articleGuid: string) {
    const position = readPositions.get(articleGuid);
    if (!position || !position.id) return;

    // Delete from local DB
    await db.readPositions.delete(position.id);

    // Remove from map
    readPositions.delete(articleGuid);
    readPositions = new Map(readPositions);

    // Queue delete to sync to server
    if (position.syncStatus === 'synced' && position.rkey) {
      await syncQueue.enqueue({
        operation: 'delete',
        collection: 'com.at-rss.feed.readPosition',
        rkey: position.rkey,
      });
    }
  }

  async function toggleStar(articleGuid: string) {
    const position = readPositions.get(articleGuid);
    if (!position || !position.id) return;

    const newStarred = !position.starred;
    await db.readPositions.update(position.id, { starred: newStarred });

    position.starred = newStarred;
    readPositions.set(articleGuid, position);
    readPositions = new Map(readPositions);

    if (position.syncStatus === 'synced' && position.rkey) {
      // Build record, only including optional fields if they have valid values
      const record: Record<string, unknown> = {
        itemGuid: position.articleGuid,
        readAt: position.readAt,
        starred: newStarred,
      };
      // Only include subscriptionUri if it's a valid AT URI
      if (position.subscriptionAtUri && position.subscriptionAtUri.startsWith('at://')) {
        record.subscriptionUri = position.subscriptionAtUri;
      }
      // Only include itemUrl if it looks like a valid URL
      if (position.articleUrl && (position.articleUrl.startsWith('http://') || position.articleUrl.startsWith('https://'))) {
        record.itemUrl = position.articleUrl;
      }
      // Only include itemTitle if present
      if (position.articleTitle) {
        record.itemTitle = position.articleTitle;
      }

      await syncQueue.enqueue({
        operation: 'update',
        collection: 'com.at-rss.feed.readPosition',
        rkey: position.rkey,
        record,
      });
    }
  }

  async function getStarredArticles(): Promise<ReadPosition[]> {
    return db.readPositions.filter((p) => p.starred).toArray();
  }

  async function getUnreadCount(subscriptionId: number): Promise<number> {
    const articles = await db.articles.where('subscriptionId').equals(subscriptionId).toArray();
    return articles.filter((a) => !readPositions.has(a.guid)).length;
  }

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
    markAsUnread,
    toggleStar,
    getStarredArticles,
    getUnreadCount,
    flushPendingReads,
  };
}

export const readingStore = createReadingStore();
