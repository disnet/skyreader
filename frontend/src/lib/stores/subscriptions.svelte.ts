import { db } from '$lib/services/db';
import { syncQueue } from '$lib/services/sync-queue';
import { api } from '$lib/services/api';
import { realtime, type NewArticlesPayload } from '$lib/services/realtime';
import type { Subscription, Article, ParsedFeed } from '$lib/types';

// Generate a TID (Timestamp Identifier) for AT Protocol records
function generateTid(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${now.toString(36)}${random}`;
}

function createSubscriptionsStore() {
  let subscriptions = $state<Subscription[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let articlesVersion = $state(0);
  let feedLoadingStates = $state<Map<number, 'loading' | 'error'>>(new Map());
  let feedErrors = $state<Map<number, string>>(new Map());

  // Listen for sync completions and update local state
  syncQueue.onSyncComplete(async (collection, rkey) => {
    if (collection === 'com.at-rss.feed.subscription') {
      const sub = await db.subscriptions.where('rkey').equals(rkey).first();
      if (sub) {
        subscriptions = subscriptions.map((s) =>
          s.rkey === rkey ? { ...s, atUri: sub.atUri, syncStatus: 'synced' as const } : s
        );
      }
    }
  });

  // Listen for realtime new articles notifications
  realtime.on('new_articles', async (payload) => {
    const data = payload as NewArticlesPayload;
    // Find subscription by feed URL and refresh it
    const sub = subscriptions.find((s) => s.feedUrl === data.feedUrl);
    if (sub?.id) {
      await fetchFeed(sub.id, true);
    }
  });

  async function load() {
    isLoading = true;
    try {
      subscriptions = await db.subscriptions.toArray();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load subscriptions';
    } finally {
      isLoading = false;
    }
  }

  async function add(feedUrl: string, title: string, options?: Partial<Subscription>) {
    const rkey = generateTid();
    const now = new Date().toISOString();

    const subscription: Omit<Subscription, 'id'> = {
      atUri: '',
      rkey,
      feedUrl,
      title,
      siteUrl: options?.siteUrl,
      category: options?.category,
      tags: options?.tags || [],
      createdAt: now,
      syncStatus: 'pending',
      localUpdatedAt: Date.now(),
    };

    const id = await db.subscriptions.add(subscription);
    subscriptions = [...subscriptions, { ...subscription, id }];

    await syncQueue.enqueue({
      operation: 'create',
      collection: 'com.at-rss.feed.subscription',
      rkey,
      record: {
        feedUrl,
        title,
        siteUrl: options?.siteUrl,
        category: options?.category,
        tags: options?.tags,
        createdAt: now,
      },
    });

    return id;
  }

  async function update(id: number, updates: Partial<Subscription>) {
    const sub = await db.subscriptions.get(id);
    if (!sub) return;

    const now = new Date().toISOString();
    await db.subscriptions.update(id, {
      ...updates,
      updatedAt: now,
      localUpdatedAt: Date.now(),
      syncStatus: 'pending',
    });

    subscriptions = subscriptions.map((s) =>
      s.id === id ? { ...s, ...updates, updatedAt: now, syncStatus: 'pending' as const } : s
    );

    if (sub.syncStatus === 'synced') {
      await syncQueue.enqueue({
        operation: 'update',
        collection: 'com.at-rss.feed.subscription',
        rkey: sub.rkey,
        record: {
          feedUrl: updates.feedUrl ?? sub.feedUrl,
          title: updates.title ?? sub.title,
          siteUrl: updates.siteUrl ?? sub.siteUrl,
          category: updates.category ?? sub.category,
          tags: updates.tags ?? sub.tags,
          createdAt: sub.createdAt,
          updatedAt: now,
        },
      });
    }
  }

  async function remove(id: number) {
    const sub = await db.subscriptions.get(id);
    if (!sub) return;

    // Delete articles for this subscription
    await db.articles.where('subscriptionId').equals(id).delete();
    await db.subscriptions.delete(id);
    subscriptions = subscriptions.filter((s) => s.id !== id);

    if (sub.syncStatus === 'synced') {
      await syncQueue.enqueue({
        operation: 'delete',
        collection: 'com.at-rss.feed.subscription',
        rkey: sub.rkey,
      });
    }
  }

  async function fetchFeed(id: number, force = false): Promise<ParsedFeed | null> {
    const sub = await db.subscriptions.get(id);
    if (!sub) return null;

    // Set loading state
    feedLoadingStates = new Map(feedLoadingStates).set(id, 'loading');
    feedErrors = new Map(feedErrors);
    feedErrors.delete(id);

    try {
      const feed = await api.fetchFeed(sub.feedUrl, force);

      // Store articles
      const existingArticles = await db.articles
        .where('subscriptionId')
        .equals(id)
        .toArray();
      const existingGuids = new Set(existingArticles.map((a) => a.guid));

      const newArticles: Article[] = feed.items
        .filter((item) => !existingGuids.has(item.guid))
        .map((item) => ({
          subscriptionId: id,
          guid: item.guid,
          url: item.url,
          title: item.title,
          author: item.author,
          content: item.content,
          summary: item.summary,
          imageUrl: item.imageUrl,
          publishedAt: item.publishedAt,
          fetchedAt: Date.now(),
        }));

      if (newArticles.length > 0) {
        await db.articles.bulkAdd(newArticles);
        articlesVersion++;
      }

      // Clear loading state on success
      feedLoadingStates = new Map(feedLoadingStates);
      feedLoadingStates.delete(id);

      return feed;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to fetch feed';
      // Set error state
      feedLoadingStates = new Map(feedLoadingStates).set(id, 'error');
      feedErrors = new Map(feedErrors).set(id, errorMessage);
      return null;
    }
  }

  function clearFeedError(id: number) {
    feedLoadingStates = new Map(feedLoadingStates);
    feedLoadingStates.delete(id);
    feedErrors = new Map(feedErrors);
    feedErrors.delete(id);
  }

  async function getArticles(subscriptionId: number): Promise<Article[]> {
    return db.articles
      .where('subscriptionId')
      .equals(subscriptionId)
      .reverse()
      .sortBy('publishedAt');
  }

  async function getAllArticles(): Promise<Article[]> {
    return db.articles.orderBy('publishedAt').reverse().toArray();
  }

  async function syncFromPds(): Promise<void> {
    try {
      const response = await api.listRecords<{
        feedUrl: string;
        title?: string;
        siteUrl?: string;
        category?: string;
        tags?: string[];
        createdAt: string;
        updatedAt?: string;
      }>('com.at-rss.feed.subscription');

      // Get existing local subscriptions
      const localSubs = await db.subscriptions.toArray();
      const localByRkey = new Map(localSubs.map((s) => [s.rkey, s]));

      for (const record of response.records) {
        // Extract rkey from URI (at://did/collection/rkey)
        const rkey = record.uri.split('/').pop() || '';
        const existing = localByRkey.get(rkey);

        const subscription: Omit<Subscription, 'id'> = {
          atUri: record.uri,
          rkey,
          feedUrl: record.value.feedUrl,
          title: record.value.title || record.value.feedUrl,
          siteUrl: record.value.siteUrl,
          category: record.value.category,
          tags: record.value.tags || [],
          createdAt: record.value.createdAt,
          updatedAt: record.value.updatedAt,
          syncStatus: 'synced',
          localUpdatedAt: Date.now(),
        };

        if (existing) {
          // Update existing record
          await db.subscriptions.update(existing.id!, subscription);
        } else {
          // Add new record from PDS
          await db.subscriptions.add(subscription);
        }
      }

      // Reload subscriptions from DB
      subscriptions = await db.subscriptions.toArray();
    } catch (e) {
      console.error('Failed to sync from PDS:', e);
      error = e instanceof Error ? e.message : 'Failed to sync from PDS';
    }
  }

  return {
    get subscriptions() {
      return subscriptions;
    },
    get isLoading() {
      return isLoading;
    },
    get error() {
      return error;
    },
    get articlesVersion() {
      return articlesVersion;
    },
    get feedLoadingStates() {
      return feedLoadingStates;
    },
    get feedErrors() {
      return feedErrors;
    },
    load,
    add,
    update,
    remove,
    fetchFeed,
    getArticles,
    getAllArticles,
    syncFromPds,
    clearFeedError,
  };
}

export const subscriptionsStore = createSubscriptionsStore();
