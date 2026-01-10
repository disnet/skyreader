import { db } from '$lib/services/db';
import { syncQueue } from '$lib/services/sync-queue';
import type { ReadPosition } from '$lib/types';

function generateTid(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${now.toString(36)}${random}`;
}

function createReadingStore() {
  let readPositions = $state<Map<string, ReadPosition>>(new Map());
  let isLoading = $state(true);

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

    const id = await db.readPositions.add(position);
    readPositions.set(articleGuid, { ...position, id });
    readPositions = new Map(readPositions);

    await syncQueue.enqueue({
      operation: 'create',
      collection: 'com.at-rss.feed.readPosition',
      rkey,
      record: {
        subscriptionUri: subscriptionAtUri,
        itemGuid: articleGuid,
        itemUrl: articleUrl,
        itemTitle: articleTitle,
        readAt: now,
        starred: false,
      },
    });
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
      await syncQueue.enqueue({
        operation: 'update',
        collection: 'com.at-rss.feed.readPosition',
        rkey: position.rkey,
        record: {
          subscriptionUri: position.subscriptionAtUri,
          itemGuid: position.articleGuid,
          itemUrl: position.articleUrl,
          itemTitle: position.articleTitle,
          readAt: position.readAt,
          starred: newStarred,
        },
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
    toggleStar,
    getStarredArticles,
    getUnreadCount,
  };
}

export const readingStore = createReadingStore();
