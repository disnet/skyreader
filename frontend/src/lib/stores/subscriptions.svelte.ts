import { liveDb } from '$lib/services/liveDb.svelte';
import { feedStatusStore } from './feedStatus.svelte';
import { api } from '$lib/services/api';
import { auth } from './auth.svelte';
import type { Subscription, SubscriptionSourceType } from '$lib/types';

// Generate a TID (Timestamp Identifier) for AT Protocol records
function generateTid(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${now.toString(36)}${random}`;
}

/**
 * Subscriptions Store - CRUD operations for feed subscriptions
 *
 * Uses liveDb for storage. Feed fetching is handled separately by feedFetcher.
 * Article queries are handled by articlesStore.
 */
function createSubscriptionsStore() {
  let isLoading = $state(false);
  let error = $state<string | null>(null);

  // Derived: subscriptions from liveDb (reactive via version)
  let subscriptions = $derived.by(() => {
    const _version = liveDb.subscriptionsVersion;
    return liveDb.subscriptions;
  });

  // Derived: subscription count
  let count = $derived(subscriptions.length);

  // Derived: max subscriptions from user tier (fallback to 100 for free)
  let maxSubscriptions = $derived(auth.user?.limits?.maxSubscriptions ?? 100);

  // Derived: can add more subscriptions
  let canAddMore = $derived(count < maxSubscriptions);

  /**
   * Load subscriptions from IndexedDB
   * Note: This is typically called by appManager.initialize()
   */
  async function load(): Promise<void> {
    isLoading = true;
    error = null;
    try {
      await liveDb.loadSubscriptions();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load subscriptions';
    } finally {
      isLoading = false;
    }
  }

  /**
   * Add a new subscription (RSS or AT Proto content stream)
   */
  async function add(
    feedUrl: string | undefined,
    title: string,
    options?: Partial<Subscription>
  ): Promise<number> {
    if (count >= maxSubscriptions) {
      throw new Error(`Feed limit reached. You can have up to ${maxSubscriptions} feeds.`);
    }

    const isAtProto = options?.sourceType && options.sourceType.startsWith('atproto.');

    // Check for duplicate
    if (isAtProto && options?.subjectDid && options?.sourceType) {
      // For AT Proto subs, check by subjectDid + sourceType + feedUrl (publication URI)
      const existing = subscriptions.find(
        (s) =>
          s.sourceType === options.sourceType &&
          s.subjectDid === options.subjectDid &&
          (s.feedUrl || '') === (options.feedUrl || feedUrl || '')
      );
      if (existing) {
        throw new Error('You are already subscribed to this content stream');
      }
    } else if (feedUrl) {
      if (liveDb.getSubscriptionByUrl(feedUrl)) {
        throw new Error('You are already subscribed to this feed');
      }
    }

    const rkey = generateTid();
    const now = new Date().toISOString();

    // Sync to backend first
    await api.createSubscription({
      rkey,
      feedUrl: feedUrl || undefined,
      title,
      siteUrl: options?.siteUrl,
      category: options?.category,
      tags: options?.tags,
      sourceType: options?.sourceType,
      subjectDid: options?.subjectDid,
      collectionNsid: options?.collectionNsid,
    });

    // Store locally after successful backend sync
    const subscription: Omit<Subscription, 'id'> = {
      rkey,
      feedUrl,
      title,
      siteUrl: options?.siteUrl,
      category: options?.category,
      tags: options?.tags || [],
      createdAt: now,
      localUpdatedAt: Date.now(),
      fetchStatus: isAtProto ? 'ready' : 'pending',
      source: options?.source,
      sourceType: options?.sourceType,
      subjectDid: options?.subjectDid,
      collectionNsid: options?.collectionNsid,
    };

    const id = await liveDb.addSubscription(subscription);
    if (!isAtProto && feedUrl) {
      feedStatusStore.markPending(feedUrl);
    }

    return id;
  }

  /**
   * Bulk add subscriptions (for OPML import)
   */
  async function addBulk(
    feeds: Array<{
      feedUrl: string;
      title: string;
      siteUrl?: string;
      category?: string;
    }>,
    onProgress?: (current: number, total: number) => void,
    options?: { source?: 'manual' | 'opml' }
  ): Promise<{
    added: number[];
    skipped: string[];
    failed: Array<{ url: string; error: string }>;
    truncated: number;
  }> {
    const added: number[] = [];
    const skipped: string[] = [];
    const failed: Array<{ url: string; error: string }> = [];
    let truncated = 0;
    const source = options?.source || 'manual';

    // Get existing feed URLs for duplicate detection
    const existingUrls = new Set(
      subscriptions.filter((s) => s.feedUrl).map((s) => s.feedUrl!.toLowerCase())
    );

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
    const availableSlots = maxSubscriptions - count;
    if (feedsToAdd.length > availableSlots) {
      truncated = feedsToAdd.length - availableSlots;
      feedsToAdd = feedsToAdd.slice(0, availableSlots);
    }

    if (feedsToAdd.length === 0) {
      return { added, skipped, failed, truncated };
    }

    onProgress?.(0, feedsToAdd.length);

    // Create all subscriptions with rkeys
    const now = new Date().toISOString();
    const localRecords: Array<{ rkey: string; feed: (typeof feedsToAdd)[0] }> = [];

    for (const feed of feedsToAdd) {
      localRecords.push({ rkey: generateTid(), feed });
    }

    onProgress?.(Math.floor(feedsToAdd.length / 4), feedsToAdd.length);

    // Bulk sync to backend
    try {
      const subscriptionsToCreate = localRecords.map(({ rkey, feed }) => ({
        rkey,
        feedUrl: feed.feedUrl,
        title: feed.title,
        siteUrl: feed.siteUrl,
        category: feed.category,
        source,
      }));

      await api.bulkCreateSubscriptions(subscriptionsToCreate);

      onProgress?.(Math.floor(feedsToAdd.length / 2), feedsToAdd.length);

      // Store locally after successful backend sync
      for (const { rkey, feed } of localRecords) {
        const subscription: Omit<Subscription, 'id'> = {
          rkey,
          feedUrl: feed.feedUrl,
          title: feed.title,
          siteUrl: feed.siteUrl,
          category: feed.category,
          tags: [],
          createdAt: now,
          localUpdatedAt: Date.now(),
          fetchStatus: 'pending',
          source,
        };

        try {
          const id = await liveDb.addSubscription(subscription);
          added.push(id);
          feedStatusStore.markPending(feed.feedUrl);
        } catch (e) {
          failed.push({
            url: feed.feedUrl,
            error: e instanceof Error ? e.message : 'Failed to save locally',
          });
        }
      }
    } catch (e) {
      // Bulk sync failed
      const errorMessage = e instanceof Error ? e.message : 'Bulk sync failed';
      for (const { feed } of localRecords) {
        failed.push({ url: feed.feedUrl, error: errorMessage });
      }
    }

    onProgress?.(feedsToAdd.length, feedsToAdd.length);

    return { added, skipped, failed, truncated };
  }

  /**
   * Update a subscription
   */
  async function update(id: number, updates: Partial<Subscription>): Promise<void> {
    const sub = liveDb.getSubscriptionById(id);
    if (!sub) return;

    const now = new Date().toISOString();

    // Delete old and recreate (API limitation)
    await api.deleteSubscription(sub.rkey);

    const newRkey = generateTid();
    await api.createSubscription({
      rkey: newRkey,
      feedUrl: updates.feedUrl ?? sub.feedUrl,
      title: updates.title ?? sub.title,
      siteUrl: updates.siteUrl ?? sub.siteUrl,
      category: updates.category ?? sub.category,
      tags: updates.tags ?? sub.tags,
    });

    // Update local DB with new rkey
    await liveDb.updateSubscription(id, {
      ...updates,
      rkey: newRkey,
      updatedAt: now,
      localUpdatedAt: Date.now(),
    });
  }

  /**
   * Update subscription custom fields (instant local + background sync to PDS)
   */
  async function updateLocal(
    id: number,
    updates: { customTitle?: string; customIconUrl?: string; category?: string | null }
  ): Promise<void> {
    // Update IndexedDB immediately for instant UI
    await liveDb.updateSubscriptionLocal(id, updates);

    // Sync to backend in background — only send fields that were explicitly passed
    const sub = liveDb.getSubscriptionById(id);
    if (sub) {
      const patch: {
        customTitle?: string | null;
        customIconUrl?: string | null;
        category?: string | null;
      } = {};
      if (updates.customTitle !== undefined) patch.customTitle = updates.customTitle ?? null;
      if (updates.customIconUrl !== undefined) patch.customIconUrl = updates.customIconUrl ?? null;
      if (updates.category !== undefined) patch.category = updates.category ?? null;

      api.updateSubscription(sub.rkey, patch).catch((err) => {
        console.error('[Subscriptions] Failed to sync custom fields to backend:', err);
      });
    }
  }

  /**
   * Bulk update subscription custom fields (instant local + single backend request)
   */
  async function bulkUpdateLocal(
    ids: number[],
    updates: { customTitle?: string; customIconUrl?: string; category?: string | null }
  ): Promise<void> {
    // Update IndexedDB immediately for instant UI
    await Promise.all(ids.map((id) => liveDb.updateSubscriptionLocal(id, updates)));

    // Sync to backend in a single request
    const rkeys = ids
      .map((id) => liveDb.getSubscriptionById(id)?.rkey)
      .filter((rkey): rkey is string => !!rkey);

    if (rkeys.length > 0) {
      const patch: {
        customTitle?: string | null;
        customIconUrl?: string | null;
        category?: string | null;
      } = {};
      if (updates.customTitle !== undefined) patch.customTitle = updates.customTitle ?? null;
      if (updates.customIconUrl !== undefined) patch.customIconUrl = updates.customIconUrl ?? null;
      if (updates.category !== undefined) patch.category = updates.category ?? null;

      api.bulkUpdateSubscriptions(rkeys, patch).catch((err) => {
        console.error('[Subscriptions] Failed to bulk sync custom fields to backend:', err);
      });
    }
  }

  /**
   * Remove a subscription
   */
  async function remove(id: number): Promise<void> {
    const sub = liveDb.getSubscriptionById(id);
    if (!sub) return;

    // Sync delete to backend
    await api.deleteSubscription(sub.rkey);

    // Delete locally (includes articles)
    await liveDb.deleteSubscription(id);
    if (sub.feedUrl) feedStatusStore.clearStatus(sub.feedUrl);
  }

  /**
   * Remove all subscriptions
   */
  async function removeAll(): Promise<void> {
    const allSubs = subscriptions;
    if (allSubs.length === 0) return;

    // Build bulk delete request
    const rkeys = allSubs.map((sub) => sub.rkey);

    // Single bulk request to backend
    await api.bulkDeleteSubscriptions(rkeys);

    // Clear all local data
    await liveDb.clearAllSubscriptions();
    feedStatusStore.clearAll();
  }

  /**
   * Get a subscription by ID
   */
  function getById(id: number): Subscription | undefined {
    return liveDb.getSubscriptionById(id);
  }

  /**
   * Get a subscription by rkey
   */
  function getByRkey(rkey: string): Subscription | undefined {
    return liveDb.getSubscriptionByRkey(rkey);
  }

  /**
   * Get a subscription by feed URL
   */
  function getByUrl(feedUrl: string): Subscription | undefined {
    return liveDb.getSubscriptionByUrl(feedUrl);
  }

  return {
    // State
    get subscriptions() {
      return subscriptions;
    },
    get isLoading() {
      return isLoading;
    },
    get error() {
      return error;
    },
    get count() {
      return count;
    },
    get canAddMore() {
      return canAddMore;
    },
    get maxSubscriptions() {
      return maxSubscriptions;
    },

    // CRUD operations
    load,
    add,
    addBulk,
    update,
    updateLocal,
    bulkUpdateLocal,
    remove,
    removeAll,

    // Lookups
    getById,
    getByRkey,
    getByUrl,
  };
}

export const subscriptionsStore = createSubscriptionsStore();
