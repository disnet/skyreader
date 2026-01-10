import { db } from '$lib/services/db';
import { syncQueue } from '$lib/services/sync-queue';
import type { UserShare } from '$lib/types';

function generateTid(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${now.toString(36)}${random}`;
}

function createSharesStore() {
  let userShares = $state<Map<string, UserShare>>(new Map());
  let isLoading = $state(true);

  async function load() {
    isLoading = true;
    try {
      const shares = await db.userShares.toArray();
      userShares = new Map(shares.map((s) => [s.articleGuid, s]));
    } finally {
      isLoading = false;
    }
  }

  function isShared(articleGuid: string): boolean {
    return userShares.has(articleGuid);
  }

  function getShareNote(articleGuid: string): string | undefined {
    return userShares.get(articleGuid)?.note;
  }

  async function share(
    subscriptionAtUri: string,
    articleGuid: string,
    articleUrl: string,
    articleTitle?: string,
    articleAuthor?: string,
    articleDescription?: string,
    articleImage?: string
  ) {
    await createShare(
      subscriptionAtUri,
      articleGuid,
      articleUrl,
      articleTitle,
      articleAuthor,
      articleDescription,
      articleImage,
      undefined
    );
  }

  async function shareWithNote(
    subscriptionAtUri: string,
    articleGuid: string,
    articleUrl: string,
    articleTitle?: string,
    articleAuthor?: string,
    articleDescription?: string,
    articleImage?: string,
    note?: string
  ) {
    await createShare(
      subscriptionAtUri,
      articleGuid,
      articleUrl,
      articleTitle,
      articleAuthor,
      articleDescription,
      articleImage,
      note
    );
  }

  async function createShare(
    subscriptionAtUri: string,
    articleGuid: string,
    articleUrl: string,
    articleTitle?: string,
    articleAuthor?: string,
    articleDescription?: string,
    articleImage?: string,
    note?: string
  ) {
    // Already shared - skip
    if (userShares.has(articleGuid)) return;

    const rkey = generateTid();
    const now = new Date().toISOString();

    const shareData: Omit<UserShare, 'id'> = {
      rkey,
      subscriptionAtUri,
      articleGuid,
      articleUrl,
      articleTitle,
      articleAuthor,
      articleDescription,
      articleImage,
      note,
      createdAt: now,
      syncStatus: 'pending',
    };

    // Update map immediately
    userShares.set(articleGuid, { ...shareData });
    userShares = new Map(userShares);

    const id = await db.userShares.add(shareData);
    userShares.set(articleGuid, { ...shareData, id });
    userShares = new Map(userShares);

    // Build record for AT Protocol
    const record: Record<string, unknown> = {
      itemUrl: articleUrl,
      createdAt: now,
    };

    if (subscriptionAtUri && subscriptionAtUri.startsWith('at://')) {
      record.subscriptionUri = subscriptionAtUri;
    }
    if (articleTitle) {
      record.itemTitle = articleTitle;
    }
    if (articleAuthor) {
      record.itemAuthor = articleAuthor;
    }
    if (articleDescription) {
      record.itemDescription = articleDescription.slice(0, 1000);
    }
    if (articleImage && (articleImage.startsWith('http://') || articleImage.startsWith('https://'))) {
      record.itemImage = articleImage;
    }
    if (note) {
      record.note = note.slice(0, 3000);
    }

    await syncQueue.enqueue({
      operation: 'create',
      collection: 'com.at-rss.social.share',
      rkey,
      record,
    });
  }

  async function unshare(articleGuid: string) {
    const existingShare = userShares.get(articleGuid);
    if (!existingShare) return;

    // Remove from map immediately
    userShares.delete(articleGuid);
    userShares = new Map(userShares);

    // Delete from IndexedDB
    if (existingShare.id) {
      await db.userShares.delete(existingShare.id);
    }

    // Queue delete if already synced
    if (existingShare.syncStatus === 'synced' && existingShare.rkey) {
      await syncQueue.enqueue({
        operation: 'delete',
        collection: 'com.at-rss.social.share',
        rkey: existingShare.rkey,
      });
    }
  }

  async function getSharedArticles(): Promise<UserShare[]> {
    return db.userShares.orderBy('createdAt').reverse().toArray();
  }

  return {
    get userShares() {
      return userShares;
    },
    get isLoading() {
      return isLoading;
    },
    load,
    isShared,
    getShareNote,
    share,
    shareWithNote,
    unshare,
    getSharedArticles,
  };
}

export const sharesStore = createSharesStore();
