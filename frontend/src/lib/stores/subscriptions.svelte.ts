import { db } from '$lib/services/db';
import { syncQueue } from '$lib/services/sync-queue';
import { api } from '$lib/services/api';
import { realtime, type NewArticlesPayload, type FeedReadyPayload } from '$lib/services/realtime';
import type { Subscription, Article, ParsedFeed } from '$lib/types';

export const MAX_SUBSCRIPTIONS = 100;

// Backend batch endpoint limit
const BATCH_SIZE = 50;

// Helper to chunk arrays for batched API calls
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

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
    if (collection === 'app.skyreader.feed.subscription') {
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
    // Find subscription by feed URL and refresh from cache (cron already updated it)
    const sub = subscriptions.find((s) => s.feedUrl === data.feedUrl);
    if (sub?.id) {
      await fetchFeed(sub.id);
    }
  });

  // Listen for feed_ready notifications (for bulk import tracking)
  realtime.on('feed_ready', async (payload) => {
    const data = payload as FeedReadyPayload;
    // Find subscription by feed URL and update its fetchStatus
    const sub = subscriptions.find((s) => s.feedUrl === data.feedUrl);
    if (sub?.id) {
      // Update local DB
      await db.subscriptions.update(sub.id, {
        fetchStatus: 'ready',
        lastFetchedAt: data.timestamp,
      });
      // Update in-memory state
      subscriptions = subscriptions.map((s) =>
        s.id === sub.id ? { ...s, fetchStatus: 'ready' as const, lastFetchedAt: data.timestamp } : s
      );
      // Fetch the newly ready feed
      await fetchFeed(sub.id);
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
    if (subscriptions.length >= MAX_SUBSCRIPTIONS) {
      throw new Error(`Feed limit reached. You can have up to ${MAX_SUBSCRIPTIONS} feeds.`);
    }

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
      collection: 'app.skyreader.feed.subscription',
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

  async function addBulk(
    feeds: Array<{ feedUrl: string; title: string; siteUrl?: string; category?: string; externalRef?: string }>,
    onProgress?: (current: number, total: number) => void,
    options?: { source?: 'manual' | 'opml' | 'leaflet' }
  ): Promise<{ added: number[]; skipped: string[]; failed: Array<{ url: string; error: string }>; truncated: number }> {
    const added: number[] = [];
    const skipped: string[] = [];
    const failed: Array<{ url: string; error: string }> = [];
    let truncated = 0;
    const source = options?.source || 'manual';

    // Get existing feed URLs for duplicate detection
    const existingUrls = new Set(subscriptions.map((s) => s.feedUrl.toLowerCase()));

    // Filter out duplicates first
    let feedsToAdd = feeds.filter((feed) => {
      if (existingUrls.has(feed.feedUrl.toLowerCase())) {
        skipped.push(feed.feedUrl);
        return false;
      }
      existingUrls.add(feed.feedUrl.toLowerCase());
      return true;
    });

    // Check subscription limit and truncate if needed
    const availableSlots = MAX_SUBSCRIPTIONS - subscriptions.length;
    if (feedsToAdd.length > availableSlots) {
      truncated = feedsToAdd.length - availableSlots;
      feedsToAdd = feedsToAdd.slice(0, availableSlots);
    }

    if (feedsToAdd.length === 0) {
      return { added, skipped, failed, truncated };
    }

    onProgress?.(0, feedsToAdd.length);

    // Create all subscriptions locally first
    const now = new Date().toISOString();
    const localRecords: Array<{ id: number; rkey: string; feed: typeof feedsToAdd[0] }> = [];

    for (const feed of feedsToAdd) {
      const rkey = generateTid();
      const subscription: Omit<Subscription, 'id'> = {
        atUri: '',
        rkey,
        feedUrl: feed.feedUrl,
        title: feed.title,
        siteUrl: feed.siteUrl,
        category: feed.category,
        tags: [],
        createdAt: now,
        syncStatus: 'pending',
        localUpdatedAt: Date.now(),
        fetchStatus: 'pending',
        source,
        externalRef: feed.externalRef,
      };

      try {
        const id = await db.subscriptions.add(subscription);
        subscriptions = [...subscriptions, { ...subscription, id }];
        localRecords.push({ id, rkey, feed });
        added.push(id);
      } catch (e) {
        failed.push({
          url: feed.feedUrl,
          error: e instanceof Error ? e.message : 'Failed to save locally',
        });
      }
    }

    onProgress?.(Math.floor(feedsToAdd.length / 2), feedsToAdd.length);

    // Bulk sync to PDS
    if (localRecords.length > 0) {
      try {
        const operations = localRecords.map(({ rkey, feed }) => ({
          operation: 'create' as const,
          collection: 'app.skyreader.feed.subscription',
          rkey,
          record: {
            feedUrl: feed.feedUrl,
            title: feed.title,
            siteUrl: feed.siteUrl,
            category: feed.category,
            createdAt: now,
            source,
            externalRef: feed.externalRef,
          },
        }));

        const result = await api.bulkSyncRecords(operations);

        // Update local records with URIs from PDS
        for (const res of result.results) {
          const local = localRecords.find((r) => r.rkey === res.rkey);
          if (local && res.uri) {
            await db.subscriptions.update(local.id, {
              atUri: res.uri,
              syncStatus: 'synced',
            });
            subscriptions = subscriptions.map((s) =>
              s.id === local.id ? { ...s, atUri: res.uri, syncStatus: 'synced' as const } : s
            );
          }
        }
      } catch (e) {
        // Bulk sync failed - records are saved locally with pending status
        // They'll sync individually via the sync queue later
        console.error('Bulk sync failed, will retry individually:', e);

        // Queue individual syncs as fallback
        for (const { rkey, feed } of localRecords) {
          await syncQueue.enqueue({
            operation: 'create',
            collection: 'app.skyreader.feed.subscription',
            rkey,
            record: {
              feedUrl: feed.feedUrl,
              title: feed.title,
              siteUrl: feed.siteUrl,
              category: feed.category,
              createdAt: now,
              source,
              externalRef: feed.externalRef,
            },
          });
        }
      }
    }

    onProgress?.(feedsToAdd.length, feedsToAdd.length);

    return { added, skipped, failed, truncated };
  }

  async function update(id: number, updates: Partial<Subscription>) {
    const sub = await db.subscriptions.get(id);
    if (!sub) return;

    const now = new Date().toISOString();

    // Build the updated record for PDS sync
    const updatedRecord = {
      feedUrl: updates.feedUrl ?? sub.feedUrl,
      title: updates.title ?? sub.title,
      siteUrl: updates.siteUrl ?? sub.siteUrl,
      category: updates.category ?? sub.category,
      tags: updates.tags ?? sub.tags,
      createdAt: sub.createdAt,
      updatedAt: now,
    };

    // Update local DB
    await db.subscriptions.update(id, {
      ...updates,
      updatedAt: now,
      localUpdatedAt: Date.now(),
      syncStatus: 'pending',
    });

    subscriptions = subscriptions.map((s) =>
      s.id === id ? { ...s, ...updates, updatedAt: now, syncStatus: 'pending' as const } : s
    );

    // Try to update any pending create operation in the sync queue
    const pendingCreateItems = await db.syncQueue
      .where('rkey')
      .equals(sub.rkey)
      .filter((item) => item.operation === 'create' && item.collection === 'app.skyreader.feed.subscription')
      .toArray();

    if (pendingCreateItems.length > 0) {
      // Update the pending create with new data
      for (const item of pendingCreateItems) {
        if (item.id && item.record) {
          await db.syncQueue.update(item.id, {
            record: {
              ...item.record,
              ...updatedRecord,
            },
          });
        }
      }
    } else {
      // No pending create found - either already synced or will be soon
      // Enqueue an update operation to ensure PDS gets the latest data
      await syncQueue.enqueue({
        operation: 'update',
        collection: 'app.skyreader.feed.subscription',
        rkey: sub.rkey,
        record: updatedRecord,
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
        collection: 'app.skyreader.feed.subscription',
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
      // Use cached endpoint by default, direct fetch only when forced
      const feed = force
        ? await api.fetchFeed(sub.feedUrl, true)
        : await api.fetchCachedFeed(sub.feedUrl);

      // If cache miss (no items), don't treat as error - cron will populate
      if (!feed.items || feed.items.length === 0) {
        feedLoadingStates = new Map(feedLoadingStates);
        feedLoadingStates.delete(id);
        return feed;
      }

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

  // Fetch recent items across all subscribed feeds from the backend
  async function fetchRecentItems(hours = 24): Promise<Article[]> {
    try {
      const { items } = await api.getRecentItems(hours);

      // Find subscription IDs for each item
      const subsByUrl = new Map(subscriptions.map(s => [s.feedUrl, s.id]));

      // Convert to Article format and store in IndexedDB
      const articles: Article[] = [];
      for (const item of items) {
        const subscriptionId = subsByUrl.get(item.feedUrl);
        if (!subscriptionId) continue;

        // Check if already exists
        const existing = await db.articles.where('guid').equals(item.guid).first();
        if (existing) continue;

        const article: Article = {
          subscriptionId,
          guid: item.guid,
          url: item.url,
          title: item.title,
          author: item.author,
          content: item.content,
          summary: item.summary,
          imageUrl: item.imageUrl,
          publishedAt: item.publishedAt,
          fetchedAt: Date.now(),
        };

        await db.articles.add(article);
        articles.push(article);
      }

      if (articles.length > 0) {
        articlesVersion++;
      }

      return articles;
    } catch (e) {
      console.error('Failed to fetch recent items:', e);
      return [];
    }
  }

  // Search articles across all feeds
  async function searchArticles(query: string, limit = 50): Promise<(Article & { feedTitle?: string })[]> {
    try {
      const { items } = await api.getItems({ search: query, limit });

      // Map to Article format
      const subsByUrl = new Map(subscriptions.map(s => [s.feedUrl, s.id]));

      return items.map(item => ({
        subscriptionId: subsByUrl.get(item.feedUrl) || 0,
        guid: item.guid,
        url: item.url,
        title: item.title,
        author: item.author,
        content: item.content,
        summary: item.summary,
        imageUrl: item.imageUrl,
        publishedAt: item.publishedAt,
        fetchedAt: Date.now(),
        feedTitle: item.feedTitle,
      }));
    } catch (e) {
      console.error('Failed to search articles:', e);
      return [];
    }
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
      }>('app.skyreader.feed.subscription');

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

  // Check feed statuses from backend and update local state
  async function checkFeedStatuses(feedUrls: string[]): Promise<void> {
    if (feedUrls.length === 0) return;

    try {
      const statuses = await api.getFeedStatuses(feedUrls);

      // Update local subscriptions with status
      for (const sub of subscriptions) {
        const status = statuses[sub.feedUrl];
        if (status) {
          const newFetchStatus = status.cached ? 'ready' : (status.error ? 'error' : 'pending');
          const updates: Partial<Subscription> = {
            fetchStatus: newFetchStatus as 'pending' | 'ready' | 'error',
          };
          if (status.lastFetchedAt) {
            updates.lastFetchedAt = status.lastFetchedAt;
          }
          if (status.error) {
            updates.fetchError = status.error;
          }

          if (sub.id) {
            await db.subscriptions.update(sub.id, updates);
          }
        }
      }

      // Reload subscriptions from DB
      subscriptions = await db.subscriptions.toArray();
    } catch (e) {
      console.error('Failed to check feed statuses:', e);
    }
  }

  // Fetch all feeds that need content: ready feeds from cache (batch), pending feeds from source
  // When force=true, bypass all caches and fetch all feeds from source
  async function fetchAllNewFeeds(concurrency = 2, delayMs = 1000, force = false): Promise<void> {
    if (force) {
      // Force refresh ALL feeds from source, bypassing all caches
      const allFeeds = subscriptions.filter((s) => s.id);
      console.log(`Force refreshing ${allFeeds.length} feeds from source...`);

      // Process in batches with rate limiting
      for (let i = 0; i < allFeeds.length; i += concurrency) {
        const batch = allFeeds.slice(i, i + concurrency);

        await Promise.allSettled(
          batch.map(async (sub) => {
            if (!sub.id) return;
            const result = await fetchFeed(sub.id, true); // force=true bypasses backend cache
            // Update status if we got items
            if (result && result.items && result.items.length > 0) {
              await db.subscriptions.update(sub.id, {
                fetchStatus: 'ready',
                lastFetchedAt: Date.now(),
              });
              subscriptions = subscriptions.map((s) =>
                s.id === sub.id ? { ...s, fetchStatus: 'ready' as const, lastFetchedAt: Date.now() } : s
              );
            }
          })
        );

        // Delay between batches
        if (i + concurrency < allFeeds.length) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      console.log('Force refresh complete');
      return;
    }

    // Non-force path: batch fetch ready feeds from cache, then fetch pending from source
    const readyFeeds = subscriptions.filter((s) => s.fetchStatus === 'ready' && s.id);
    if (readyFeeds.length > 0) {
      console.log(`Batch fetching ${readyFeeds.length} ready feeds from cache...`);
      try {
        const feedUrls = readyFeeds.map((s) => s.feedUrl);

        // Chunk URLs into batches to respect backend limit
        const urlChunks = chunkArray(feedUrls, BATCH_SIZE);

        // Fetch batches sequentially to avoid UI lockup
        const feeds: Record<string, { title: string; items: ParsedFeed['items'] }> = {};
        for (const chunk of urlChunks) {
          const result = await api.fetchFeedsBatch(chunk, {});
          Object.assign(feeds, result.feeds);
        }

        // Process batch response and store articles
        for (const sub of readyFeeds) {
          if (!sub.id) continue;
          const feedData = feeds[sub.feedUrl];
          if (!feedData || feedData.items.length === 0) continue;

          // Store new articles (backend already filtered by 'since', but double-check GUIDs)
          const existingArticles = await db.articles
            .where('subscriptionId')
            .equals(sub.id)
            .toArray();
          const existingGuids = new Set(existingArticles.map((a) => a.guid));

          const newArticles: Article[] = feedData.items
            .filter((item) => !existingGuids.has(item.guid))
            .map((item) => ({
              subscriptionId: sub.id!,
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
        }
      } catch (e) {
        console.error('Batch feed fetch failed, falling back to individual fetches:', e);
        // Fallback to individual fetches
        await Promise.all(
          readyFeeds.map((sub) => sub.id && fetchFeed(sub.id, false))
        );
      }
    }

    // Then gradually fetch pending feeds from source (these need actual backend fetches)
    await fetchPendingFeedsGradually(concurrency, delayMs);
  }

  // Gradually fetch pending feeds in background with rate limiting
  // Uses force=true to trigger actual backend fetches for feeds not yet cached
  async function fetchPendingFeedsGradually(concurrency = 2, delayMs = 1000): Promise<void> {
    const pendingFeeds = subscriptions.filter((s) => s.fetchStatus === 'pending' && s.id);

    if (pendingFeeds.length === 0) return;

    console.log(`Fetching ${pendingFeeds.length} pending feeds gradually...`);

    // Process in batches with delay
    for (let i = 0; i < pendingFeeds.length; i += concurrency) {
      const batch = pendingFeeds.slice(i, i + concurrency);

      await Promise.allSettled(
        batch.map(async (sub) => {
          if (!sub.id) return;
          // Use force=true to trigger actual backend fetch if not cached
          const result = await fetchFeed(sub.id, true);
          // If we got items, mark as ready
          if (result && result.items && result.items.length > 0) {
            await db.subscriptions.update(sub.id, {
              fetchStatus: 'ready',
              lastFetchedAt: Date.now(),
            });
            subscriptions = subscriptions.map((s) =>
              s.id === sub.id ? { ...s, fetchStatus: 'ready' as const, lastFetchedAt: Date.now() } : s
            );
          }
        })
      );

      // Delay between batches to avoid overwhelming the backend
      if (i + concurrency < pendingFeeds.length) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    console.log('Finished fetching pending feeds');
  }

  // Sync Leaflet subscriptions using batched resolution
  async function syncLeaflet(
    onProgress?: (stage: string, current: number, total: number) => void
  ): Promise<{ added: number; skipped: number; errors: string[] }> {
    const BATCH_SIZE = 10;
    const errors: string[] = [];

    // 1. Fetch Leaflet subscriptions from backend
    onProgress?.('Fetching subscriptions...', 0, 0);
    const { subscriptions: leafletSubs } = await api.getLeafletSubscriptions();

    if (leafletSubs.length === 0) {
      return { added: 0, skipped: 0, errors: [] };
    }

    // 2. Filter out already-imported (check externalRef)
    const existingRefs = new Set(
      subscriptions.filter((s) => s.externalRef).map((s) => s.externalRef)
    );
    const toImport = leafletSubs.filter((s) => !existingRefs.has(s.uri));
    const alreadyImported = leafletSubs.length - toImport.length;

    if (toImport.length === 0) {
      return { added: 0, skipped: alreadyImported, errors: [] };
    }

    // 3. Resolve in batches of 10
    const resolved: Array<{ feedUrl: string; title: string; siteUrl?: string; externalRef: string }> = [];

    for (let i = 0; i < toImport.length; i += BATCH_SIZE) {
      const batch = toImport.slice(i, i + BATCH_SIZE);
      onProgress?.('Resolving feeds...', i, toImport.length);

      try {
        const { results } = await api.resolveLeafletPublications(batch.map((s) => s.publication));

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.resolved) {
            resolved.push({
              feedUrl: result.resolved.rssUrl,
              title: result.resolved.title || result.resolved.rssUrl,
              siteUrl: result.resolved.siteUrl,
              externalRef: batch[j].uri,
            });
          } else {
            errors.push(`Could not resolve: ${result.publication}`);
          }
        }
      } catch (e) {
        errors.push(`Batch resolution failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    onProgress?.('Resolving feeds...', toImport.length, toImport.length);

    if (resolved.length === 0) {
      return { added: 0, skipped: alreadyImported, errors };
    }

    // 4. Add via existing addBulk with source='leaflet'
    onProgress?.('Adding feeds...', 0, resolved.length);
    const result = await addBulk(resolved, (current, total) => {
      onProgress?.('Adding feeds...', current, total);
    }, { source: 'leaflet' });

    // 5. Fetch new feeds
    if (result.added.length > 0) {
      onProgress?.('Fetching feed content...', 0, result.added.length);
      await fetchAllNewFeeds();
    }

    return {
      added: result.added.length,
      skipped: alreadyImported + result.skipped.length,
      errors: [...errors, ...result.failed.map((f) => f.error)],
    };
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
    addBulk,
    update,
    remove,
    fetchFeed,
    getArticles,
    getAllArticles,
    fetchRecentItems,
    searchArticles,
    syncFromPds,
    clearFeedError,
    checkFeedStatuses,
    fetchPendingFeedsGradually,
    fetchAllNewFeeds,
    syncLeaflet,
  };
}

export const subscriptionsStore = createSubscriptionsStore();
