import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
import type { Subscription, Article, ParsedFeed } from '$lib/types';

export const MAX_SUBSCRIPTIONS = 100;

// Generate a TID (Timestamp Identifier) for AT Protocol records
function generateTid(): string {
	const now = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `${now.toString(36)}${random}`;
}

const DEFAULT_PAGE_SIZE = 50;

function createSubscriptionsStore() {
	let subscriptions = $state<Subscription[]>([]);
	let isLoading = $state(true);
	let error = $state<string | null>(null);
	let articlesVersion = $state(0);
	let feedLoadingStates = $state<Map<number, 'loading' | 'error'>>(new Map());
	let feedErrors = $state<Map<number, string>>(new Map());

	// Pagination state
	let articlesCursor = $state<number | null>(null);
	let articlesHasMore = $state(true);
	let articlesIsLoadingMore = $state(false);

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
			rkey,
			feedUrl,
			title,
			siteUrl: options?.siteUrl,
			category: options?.category,
			tags: options?.tags || [],
			createdAt: now,
			localUpdatedAt: Date.now(),
		};

		// Sync to backend using dedicated endpoint
		await api.createSubscription({
			rkey,
			feedUrl,
			title,
			siteUrl: options?.siteUrl,
			category: options?.category,
			tags: options?.tags,
		});

		// Store locally after successful backend sync
		const id = await db.subscriptions.add(subscription);
		subscriptions = [...subscriptions, { ...subscription, id }];

		return id;
	}

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

		// Create all subscriptions with rkeys
		const now = new Date().toISOString();
		const localRecords: Array<{ rkey: string; feed: (typeof feedsToAdd)[0] }> = [];

		for (const feed of feedsToAdd) {
			localRecords.push({ rkey: generateTid(), feed });
		}

		onProgress?.(Math.floor(feedsToAdd.length / 4), feedsToAdd.length);

		// Bulk sync to backend using dedicated endpoint
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
					const id = await db.subscriptions.add(subscription);
					subscriptions = [...subscriptions, { ...subscription, id }];
					added.push(id);
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

	async function update(id: number, updates: Partial<Subscription>) {
		const sub = await db.subscriptions.get(id);
		if (!sub) return;

		const now = new Date().toISOString();

		// For updates, we delete and recreate since the new API doesn't have update
		// First delete the old subscription
		await api.deleteSubscription(sub.rkey);

		// Create new subscription with updated values
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
		await db.subscriptions.update(id, {
			...updates,
			rkey: newRkey,
			updatedAt: now,
			localUpdatedAt: Date.now(),
		});

		subscriptions = subscriptions.map((s) =>
			s.id === id ? { ...s, ...updates, rkey: newRkey, updatedAt: now } : s
		);
	}

	async function remove(id: number) {
		const sub = await db.subscriptions.get(id);
		if (!sub) return;

		// Sync delete to backend using dedicated endpoint
		await api.deleteSubscription(sub.rkey);

		// Delete articles for this subscription
		await db.articles.where('subscriptionId').equals(id).delete();
		await db.subscriptions.delete(id);
		subscriptions = subscriptions.filter((s) => s.id !== id);
	}

	async function removeAll(): Promise<void> {
		const allSubs = await db.subscriptions.toArray();
		if (allSubs.length === 0) return;

		// Build bulk delete request using dedicated endpoint
		const rkeys = allSubs.map((sub) => sub.rkey);

		// Single bulk request to backend
		await api.bulkDeleteSubscriptions(rkeys);

		// Clear all local data
		await db.articles.clear();
		await db.subscriptions.clear();
		subscriptions = [];
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
			const existingArticles = await db.articles.where('subscriptionId').equals(id).toArray();
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

	// Get first page of articles from IndexedDB (paginated)
	async function getArticlesPaginated(
		subscriptionId?: number,
		limit = DEFAULT_PAGE_SIZE
	): Promise<Article[]> {
		let query = subscriptionId
			? db.articles.where('subscriptionId').equals(subscriptionId)
			: db.articles.orderBy('publishedAt');

		const articles = await query.reverse().limit(limit).toArray();

		// Sort by publishedAt for subscription-filtered queries (since we indexed by subscriptionId)
		if (subscriptionId) {
			articles.sort(
				(a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
			);
		}

		// Set cursor to oldest article's timestamp
		if (articles.length > 0) {
			const oldest = articles[articles.length - 1];
			articlesCursor = new Date(oldest.publishedAt).getTime();
			articlesHasMore = articles.length === limit;
		} else {
			articlesCursor = null;
			articlesHasMore = false;
		}

		return articles;
	}

	// Load more articles from IndexedDB (older than cursor)
	async function loadMoreArticles(
		subscriptionId?: number,
		limit = DEFAULT_PAGE_SIZE
	): Promise<Article[]> {
		if (articlesIsLoadingMore || !articlesHasMore || !articlesCursor) return [];

		articlesIsLoadingMore = true;

		try {
			// Query IndexedDB for articles older than cursor
			let articles: Article[];

			if (subscriptionId) {
				// For a specific feed, filter by subscriptionId and publishedAt
				articles = await db.articles
					.where('subscriptionId')
					.equals(subscriptionId)
					.filter((a) => new Date(a.publishedAt).getTime() < articlesCursor!)
					.reverse()
					.sortBy('publishedAt');
				// Take only the first `limit` items (sortBy doesn't support limit)
				articles = articles.slice(0, limit);
			} else {
				// For all feeds, we need to filter by publishedAt
				// Since publishedAt is indexed, we can use a range query
				articles = await db.articles
					.where('publishedAt')
					.below(new Date(articlesCursor).toISOString())
					.reverse()
					.limit(limit)
					.toArray();
			}

			// Sort by publishedAt descending (newest first within this batch)
			articles.sort(
				(a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
			);

			// Update cursor to oldest article in this batch
			if (articles.length > 0) {
				const oldest = articles[articles.length - 1];
				articlesCursor = new Date(oldest.publishedAt).getTime();
				articlesHasMore = articles.length === limit;
			} else {
				articlesHasMore = false;
			}

			return articles;
		} catch (e) {
			console.error('Failed to load more articles:', e);
			error = e instanceof Error ? e.message : 'Failed to load more articles';
			return [];
		} finally {
			articlesIsLoadingMore = false;
		}
	}

	// Reset pagination state (call when filters change)
	function resetArticlesPagination() {
		articlesCursor = null;
		articlesHasMore = true;
		articlesIsLoadingMore = false;
	}

	// Fetch recent items across all subscribed feeds from the backend
	async function fetchRecentItems(hours = 24): Promise<Article[]> {
		try {
			const { items } = await api.getRecentItems(hours);

			// Find subscription IDs for each item
			const subsByUrl = new Map(subscriptions.map((s) => [s.feedUrl, s.id]));

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
	async function searchArticles(
		query: string,
		limit = 50
	): Promise<(Article & { feedTitle?: string })[]> {
		try {
			const { items } = await api.getItems({ search: query, limit });

			// Map to Article format
			const subsByUrl = new Map(subscriptions.map((s) => [s.feedUrl, s.id]));

			return items.map((item) => ({
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

	async function syncFromBackend(): Promise<void> {
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
				// Extract rkey from URI (local://did/collection/rkey or at://did/collection/rkey)
				const rkey = record.uri.split('/').pop() || '';
				const existing = localByRkey.get(rkey);

				const subscription: Omit<Subscription, 'id'> = {
					rkey,
					feedUrl: record.value.feedUrl,
					title: record.value.title || record.value.feedUrl,
					siteUrl: record.value.siteUrl,
					category: record.value.category,
					tags: record.value.tags || [],
					createdAt: record.value.createdAt,
					updatedAt: record.value.updatedAt,
					localUpdatedAt: Date.now(),
				};

				if (existing) {
					// Update existing record
					await db.subscriptions.update(existing.id!, subscription);
				} else {
					// Add new record from backend
					await db.subscriptions.add(subscription);
				}
			}

			// Reload subscriptions from DB
			subscriptions = await db.subscriptions.toArray();
		} catch (e) {
			console.error('Failed to sync from backend:', e);
			error = e instanceof Error ? e.message : 'Failed to sync from backend';
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
					const newFetchStatus = status.cached ? 'ready' : status.error ? 'error' : 'pending';
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
	async function fetchAllNewFeeds(concurrency = 1, delayMs = 5000, force = false): Promise<void> {
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
								s.id === sub.id
									? { ...s, fetchStatus: 'ready' as const, lastFetchedAt: Date.now() }
									: s
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
				// Collect most recent article timestamp per feed for delta sync
				const since: Record<string, number> = {};
				for (const sub of readyFeeds) {
					if (!sub.id) continue;
					// Get the most recent article for this subscription
					const mostRecent = await db.articles
						.where('subscriptionId')
						.equals(sub.id)
						.reverse()
						.sortBy('publishedAt')
						.then((articles) => articles[0]);

					if (mostRecent?.publishedAt) {
						since[sub.feedUrl] = new Date(mostRecent.publishedAt).getTime();
					}
				}

				// Process in chunks of 50 (backend limit)
				const BATCH_CHUNK_SIZE = 50;
				for (let i = 0; i < readyFeeds.length; i += BATCH_CHUNK_SIZE) {
					const chunk = readyFeeds.slice(i, i + BATCH_CHUNK_SIZE);
					const feedUrls = chunk.map((s) => s.feedUrl);

					// Filter since to only include URLs in this chunk
					const chunkSince: Record<string, number> = {};
					for (const url of feedUrls) {
						if (since[url]) chunkSince[url] = since[url];
					}

					const { feeds } = await api.fetchFeedsBatch(feedUrls, chunkSince);

					// Process batch response and store articles
					for (const sub of chunk) {
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
				}
			} catch (e) {
				console.error('Batch feed fetch failed, falling back to individual fetches:', e);
				// Fallback to individual fetches
				await Promise.all(readyFeeds.map((sub) => sub.id && fetchFeed(sub.id, false)));
			}
		}

		// Then gradually fetch pending feeds from source (these need actual backend fetches)
		await fetchPendingFeedsGradually(concurrency, delayMs);
	}

	// Gradually fetch pending feeds in background with rate limiting
	// Uses force=true to trigger actual backend fetches for feeds not yet cached
	async function fetchPendingFeedsGradually(concurrency = 1, delayMs = 5000): Promise<void> {
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
							s.id === sub.id
								? { ...s, fetchStatus: 'ready' as const, lastFetchedAt: Date.now() }
								: s
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
		get articlesCursor() {
			return articlesCursor;
		},
		get articlesHasMore() {
			return articlesHasMore;
		},
		get articlesIsLoadingMore() {
			return articlesIsLoadingMore;
		},
		load,
		add,
		addBulk,
		update,
		remove,
		removeAll,
		fetchFeed,
		getArticles,
		getAllArticles,
		getArticlesPaginated,
		loadMoreArticles,
		resetArticlesPagination,
		fetchRecentItems,
		searchArticles,
		syncFromBackend,
		clearFeedError,
		checkFeedStatuses,
		fetchPendingFeedsGradually,
		fetchAllNewFeeds,
	};
}

export const subscriptionsStore = createSubscriptionsStore();
