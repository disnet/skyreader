import { db } from './db';
import type { Subscription, Article, FeedItem } from '$lib/types';

const MAX_ARTICLES_PER_FEED = 100;

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
			this._subscriptions = await db.subscriptions.toArray();
			this._subscriptionsLoaded = true;
			this.subscriptionsVersion++;
			return this._subscriptions;
		} catch (e) {
			console.error('Failed to load subscriptions from IndexedDB:', e);
			return [];
		}
	}

	/**
	 * Load all articles from IndexedDB into memory
	 */
	async loadArticles(): Promise<Article[]> {
		try {
			// Load articles sorted by publishedAt descending
			this._articles = await db.articles.orderBy('publishedAt').reverse().toArray();
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
		const id = await db.subscriptions.add(subscription);
		this._subscriptions = [...this._subscriptions, { ...subscription, id }];
		this.subscriptionsVersion++;
		return id;
	}

	/**
	 * Update an existing subscription
	 */
	async updateSubscription(id: number, updates: Partial<Subscription>): Promise<void> {
		await db.subscriptions.update(id, updates);
		this._subscriptions = this._subscriptions.map((s) => (s.id === id ? { ...s, ...updates } : s));
		this.subscriptionsVersion++;
	}

	/**
	 * Update subscription locally only (no backend sync)
	 * Used for local-only fields like customTitle and customIconUrl
	 */
	async updateSubscriptionLocal(
		id: number,
		updates: { customTitle?: string; customIconUrl?: string }
	): Promise<void> {
		await db.subscriptions.update(id, updates);
		this._subscriptions = this._subscriptions.map((s) => (s.id === id ? { ...s, ...updates } : s));
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
			await db.subscriptions.bulkAdd(subscriptions);
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
		starredGuids: Set<string> = new Set()
	): Promise<number> {
		if (items.length === 0) return 0;

		// Get existing GUIDs for this subscription
		const existingGuids = new Set(
			this._articles.filter((a) => a.subscriptionId === subscriptionId).map((a) => a.guid)
		);

		// Filter to only new items
		const newItems = items.filter((item) => !existingGuids.has(item.guid));
		if (newItems.length === 0) return 0;

		// Convert to Article format
		const now = Date.now();
		const newArticles: Article[] = newItems.map((item) => ({
			subscriptionId,
			guid: item.guid,
			url: item.url,
			title: item.title,
			author: item.author,
			content: item.content,
			summary: item.summary,
			imageUrl: item.imageUrl,
			publishedAt: item.publishedAt,
			fetchedAt: now,
		}));

		// Add to IndexedDB
		await db.articles.bulkAdd(newArticles);

		// Update in-memory state
		this._articles = [...this._articles, ...newArticles].sort(
			(a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
		);

		// Enforce per-feed limit (preserve starred articles)
		await this.enforceArticleLimit(subscriptionId, starredGuids);

		this.articlesVersion++;
		return newArticles.length;
	}

	/**
	 * Enforce the MAX_ARTICLES_PER_FEED limit for a subscription
	 * Preserves starred articles even if over the limit
	 */
	private async enforceArticleLimit(
		subscriptionId: number,
		starredGuids: Set<string>
	): Promise<void> {
		const feedArticles = this._articles
			.filter((a) => a.subscriptionId === subscriptionId)
			.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

		if (feedArticles.length <= MAX_ARTICLES_PER_FEED) return;

		// Split into starred and non-starred
		const starred = feedArticles.filter((a) => starredGuids.has(a.guid));
		const nonStarred = feedArticles.filter((a) => !starredGuids.has(a.guid));

		// Keep all starred + up to MAX non-starred (newest first)
		const keepCount = Math.max(0, MAX_ARTICLES_PER_FEED - starred.length);
		const toKeep = new Set([
			...starred.map((a) => a.guid),
			...nonStarred.slice(0, keepCount).map((a) => a.guid),
		]);

		const toDelete = feedArticles.filter((a) => !toKeep.has(a.guid));
		if (toDelete.length === 0) return;

		// Delete from IndexedDB
		const idsToDelete = toDelete.map((a) => a.id!).filter((id) => id !== undefined);
		await db.articles.bulkDelete(idsToDelete);

		// Update in-memory state
		this._articles = this._articles.filter(
			(a) => a.subscriptionId !== subscriptionId || toKeep.has(a.guid)
		);
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
	 * Get a subscription by feed URL
	 */
	getSubscriptionByUrl(feedUrl: string): Subscription | undefined {
		return this._subscriptions.find((s) => s.feedUrl.toLowerCase() === feedUrl.toLowerCase());
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
