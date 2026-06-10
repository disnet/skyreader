import { db } from './db';
import { safeAdd, safeUpdate, safeBulkAdd } from './safeDb.svelte';
import { dedupeSubscriptionsByRkey, dedupeSubscriptionsByFeed } from './subscriptionDedup';
import { selectNewArticles, computeArticleLimitDeletions, toLightArticle } from './articleMerge';
import type { Subscription, Article, FeedItem } from '$lib/types';

/**
 * LiveDatabase - Reactive IndexedDB wrapper using Svelte 5 runes
 *
 * Provides cache-first access to subscriptions and articles with
 * version counters that trigger UI updates when data changes.
 */
class LiveDatabase {
  // Version counters for reactivity - bump these when data changes
  subscriptionsVersion = $state(0);
  articlesVersion = $state(0);

  // Reactive state
  private _subscriptions = $state<Subscription[]>([]);
  private _articles = $state<Article[]>([]);
  private _articlesLoaded = $state(false);
  private _subscriptionsLoaded = $state(false);

  // Getters for external access
  get subscriptions() {
    return this._subscriptions;
  }
  get articles() {
    return this._articles;
  }
  get articlesLoaded() {
    return this._articlesLoaded;
  }
  get subscriptionsLoaded() {
    return this._subscriptionsLoaded;
  }

  /**
   * Load all subscriptions from IndexedDB into memory
   */
  async loadSubscriptions(): Promise<Subscription[]> {
    try {
      const all = await db.subscriptions.toArray();
      // Heal any pre-existing duplicates (same rkey) that an older build's
      // add/sync race may have persisted to the cache.
      this._subscriptions = await this.dedupeSubscriptions(all);
      this._subscriptionsLoaded = true;
      this.subscriptionsVersion++;
      return this._subscriptions;
    } catch (e) {
      console.error('Failed to load subscriptions from IndexedDB:', e);
      return [];
    }
  }

  /**
   * Heal duplicate subscriptions in the cache, deleting the redundant rows from
   * IndexedDB. Two classes are collapsed:
   *  1. Same rkey — two rows of one AT Protocol record (an add/sync race).
   *  2. Same feed, different rkey — two records pointing at one feed (a
   *     concurrent add or the same feed added on two devices).
   * The oldest row in each group is kept; the rest are deleted. PDS-side
   * cleanup of class 2 happens in the sync flow (see syncSubscriptions).
   */
  private async dedupeSubscriptions(subs: Subscription[]): Promise<Subscription[]> {
    const byRkey = dedupeSubscriptionsByRkey(subs);
    const byFeed = dedupeSubscriptionsByFeed(byRkey.kept);
    const dupeIds = [...byRkey.dupeIds, ...byFeed.dupeIds];
    if (dupeIds.length > 0) {
      console.warn(`Removing ${dupeIds.length} duplicate subscription(s) from cache`);
      try {
        await db.subscriptions.bulkDelete(dupeIds);
      } catch (e) {
        console.error('Failed to delete duplicate subscriptions:', e);
      }
    }
    return byFeed.kept;
  }

  /**
   * Load all articles from IndexedDB into memory
   */
  async loadArticles(): Promise<Article[]> {
    try {
      // Load articles sorted by publishedAt descending. Strip each body to a
      // light copy (metadata + precomputed stats) — the full content stays in
      // IndexedDB and is lazy-loaded on expand, keeping the heap from holding
      // every article's HTML at once.
      const full = await db.articles.orderBy('publishedAt').reverse().toArray();
      this._articles = full.map(toLightArticle);
      this._articlesLoaded = true;
      this.articlesVersion++;
      return this._articles;
    } catch (e) {
      console.error('Failed to load articles from IndexedDB:', e);
      return [];
    }
  }

  /**
   * Add a new subscription to both IndexedDB and memory
   */
  async addSubscription(subscription: Omit<Subscription, 'id'>): Promise<number> {
    // Idempotent on rkey. The user's own add() and a background sync (e.g. on
    // tab refocus) can both try to insert the same record — without this guard
    // they create duplicate rows with identical rkeys. Return the existing id.
    if (subscription.rkey) {
      const existing = this._subscriptions.find((s) => s.rkey === subscription.rkey);
      if (existing?.id != null) return existing.id;
    }

    const id = await safeAdd(db.subscriptions, subscription);

    // Re-check after the await: a concurrent caller may have inserted the same
    // rkey while this write was in flight. If so, drop our row and reuse theirs.
    if (subscription.rkey) {
      const raced = this._subscriptions.find((s) => s.rkey === subscription.rkey);
      if (raced?.id != null) {
        await db.subscriptions.delete(id);
        return raced.id;
      }
    }

    this._subscriptions = [...this._subscriptions, { ...subscription, id }];
    this.subscriptionsVersion++;
    return id;
  }

  /**
   * Update an existing subscription
   */
  async updateSubscription(id: number, updates: Partial<Subscription>): Promise<void> {
    await safeUpdate(db.subscriptions, id, updates);
    this._subscriptions = this._subscriptions.map((s) => (s.id === id ? { ...s, ...updates } : s));
    this.subscriptionsVersion++;
  }

  /**
   * Update subscription locally only (no backend sync)
   * Used for local-only fields like customTitle and customIconUrl
   */
  async updateSubscriptionLocal(
    id: number,
    updates: {
      customTitle?: string;
      customIconUrl?: string;
      category?: string | null;
    }
  ): Promise<void> {
    // Dexie doesn't accept null — use undefined to clear fields
    const dexieUpdates: Record<string, string | undefined> = {};
    if (updates.customTitle !== undefined) dexieUpdates.customTitle = updates.customTitle;
    if (updates.customIconUrl !== undefined) dexieUpdates.customIconUrl = updates.customIconUrl;
    if (updates.category !== undefined) dexieUpdates.category = updates.category ?? undefined;
    await safeUpdate(db.subscriptions, id, dexieUpdates);
    this._subscriptions = this._subscriptions.map((s) =>
      s.id === id ? { ...s, ...dexieUpdates } : s
    );
    this.subscriptionsVersion++;
  }

  /**
   * Delete a subscription and its articles
   */
  async deleteSubscription(id: number): Promise<void> {
    await db.articles.where('subscriptionId').equals(id).delete();
    await db.subscriptions.delete(id);
    this._subscriptions = this._subscriptions.filter((s) => s.id !== id);
    this._articles = this._articles.filter((a) => a.subscriptionId !== id);
    this.subscriptionsVersion++;
    this.articlesVersion++;
  }

  /**
   * Clear all subscriptions and articles
   */
  async clearAllSubscriptions(): Promise<void> {
    await db.articles.clear();
    await db.subscriptions.clear();
    this._subscriptions = [];
    this._articles = [];
    this.subscriptionsVersion++;
    this.articlesVersion++;
  }

  /**
   * Replace all subscriptions (used during sync from backend)
   */
  async replaceSubscriptions(subscriptions: Subscription[]): Promise<void> {
    await db.subscriptions.clear();
    if (subscriptions.length > 0) {
      await safeBulkAdd(db.subscriptions, subscriptions);
    }
    this._subscriptions = subscriptions;
    this._subscriptionsLoaded = true;
    this.subscriptionsVersion++;
  }

  /**
   * Merge new articles into a subscription's article list
   * - Deduplicates by GUID
   * - Enforces MAX_ARTICLES_PER_FEED limit
   * - Preserves starred articles
   *
   * @returns Number of new articles added
   */
  async mergeArticles(
    subscriptionId: number,
    items: FeedItem[],
    savedGuids: Set<string> = new Set()
  ): Promise<number> {
    return this.mergeArticlesBatch([{ subscriptionId, items }], savedGuids);
  }

  /**
   * Merge new articles for many subscriptions in a single pass.
   *
   * This is the throughput-oriented path used on initial/full sync, where
   * processing each feed individually would rebuild and re-sort the entire
   * in-memory article array once per feed (O(feeds × total) on cold start).
   * Instead we dedupe, convert, bulk-insert, rebuild/sort, and enforce the
   * per-feed limit a single time for the whole batch — and bump the reactive
   * version once, so the UI repaints per batch rather than per feed.
   *
   * @returns Total number of new articles added across all feeds
   */
  async mergeArticlesBatch(
    feeds: Array<{ subscriptionId: number; items: FeedItem[] }>,
    savedGuids: Set<string> = new Set()
  ): Promise<number> {
    if (feeds.length === 0) return 0;

    const { newArticles, affected } = selectNewArticles(this._articles, feeds, Date.now());
    if (newArticles.length === 0) return 0;

    // One bulk insert — the full body is persisted to IndexedDB here.
    await safeBulkAdd(db.articles, newArticles);

    // One in-memory rebuild + sort (newest first). The in-memory array holds
    // light copies (no body) — the full content went to IndexedDB just above.
    this._articles = [...this._articles, ...newArticles.map(toLightArticle)].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );

    // One limit-enforcement pass across every feed we touched. _articles is
    // sorted newest-first, which computeArticleLimitDeletions relies on.
    const { ids, dropByFeed } = computeArticleLimitDeletions(this._articles, affected, savedGuids);
    if (ids.length > 0) {
      // One delete from IndexedDB.
      await db.articles.bulkDelete(ids);
      // One in-memory filter.
      this._articles = this._articles.filter((a) => {
        const drop = dropByFeed.get(a.subscriptionId);
        return !drop || !drop.has(a.guid);
      });
    }

    this.articlesVersion++;
    return newArticles.length;
  }

  /**
   * Delete all articles for a subscription
   */
  async deleteArticlesForSubscription(subscriptionId: number): Promise<void> {
    await db.articles.where('subscriptionId').equals(subscriptionId).delete();
    this._articles = this._articles.filter((a) => a.subscriptionId !== subscriptionId);
    this.articlesVersion++;
  }

  /**
   * Get articles for a specific subscription (sorted by publishedAt desc)
   */
  getArticlesForSubscription(subscriptionId: number): Article[] {
    return this._articles.filter((a) => a.subscriptionId === subscriptionId);
  }

  /**
   * Get recent GUIDs for a subscription (for incremental sync)
   */
  getRecentGuids(subscriptionId: number, count: number = 10): string[] {
    return this._articles
      .filter((a) => a.subscriptionId === subscriptionId)
      .slice(0, count)
      .map((a) => a.guid);
  }

  /**
   * Get a subscription by ID
   */
  getSubscriptionById(id: number): Subscription | undefined {
    return this._subscriptions.find((s) => s.id === id);
  }

  /**
   * Get a subscription by rkey
   */
  getSubscriptionByRkey(rkey: string): Subscription | undefined {
    return this._subscriptions.find((s) => s.rkey === rkey);
  }

  /**
   * Get a subscription by feed URL
   */
  getSubscriptionByUrl(feedUrl: string): Subscription | undefined {
    return this._subscriptions.find((s) => s.feedUrl?.toLowerCase() === feedUrl.toLowerCase());
  }

  /**
   * Get articles by their GUIDs
   */
  getArticlesByGuids(guids: string[]): Article[] {
    const guidSet = new Set(guids);
    return this._articles.filter((a) => guidSet.has(a.guid));
  }
}

export const liveDb = new LiveDatabase();
