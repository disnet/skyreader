# Frontend State Architecture

This document describes how Skyreader's frontend manages subscriptions, articles, and feed data with reactive UI updates using Svelte 5 runes.

## Overview

The frontend uses a **cache-first, reactive-by-default** architecture:

1. **Cache-first**: Show data from IndexedDB immediately, refresh from backend in background
2. **Reactive**: All state uses Svelte 5 runes (`$state`, `$derived`) for automatic UI updates
3. **Centralized orchestration**: Single entry point (`appManager`) coordinates all data loading
4. **Separation of concerns**: Each module has a single responsibility

```
┌─────────────────────────────────────────────────────────────────┐
│                         UI Components                            │
│  (+page.svelte, Sidebar.svelte, FeedListView.svelte, etc.)      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      View Stores (Display Logic)                 │
│  feedViewStore: filtering, pagination, view mode selection       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Domain Stores (Business Logic)               │
│  articlesStore: article queries, unread counts                   │
│  subscriptionsStore: subscription CRUD                           │
│  feedStatusStore: per-feed error tracking                        │
│  readingStore: read/starred state                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Data Layer (Storage + Sync)                  │
│  liveDb: reactive IndexedDB wrapper                              │
│  feedFetcher: V2 batch API calls                                 │
│  appManager: initialization orchestrator                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Infrastructure                               │
│  db.ts: Dexie IndexedDB schema                                   │
│  api.ts: HTTP client for backend                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Modules

### 1. LiveDatabase (`liveDb.svelte.ts`)

The reactive IndexedDB wrapper. Holds in-memory copies of data with version counters that trigger Svelte reactivity.

```typescript
class LiveDatabase {
	// Version counters - bump to trigger reactive updates
	subscriptionsVersion = $state(0);
	articlesVersion = $state(0);

	// In-memory data (reactive)
	private _subscriptions = $state<Subscription[]>([]);
	private _articles = $state<Article[]>([]);

	// Getters for external access
	get subscriptions() {
		return this._subscriptions;
	}
	get articles() {
		return this._articles;
	}
}
```

**Key Methods:**

- `loadSubscriptions()` / `loadArticles()` - Load from IndexedDB into memory
- `addSubscription()` / `updateSubscription()` / `deleteSubscription()` - CRUD with version bumps
- `mergeArticles(subscriptionId, items, starredGuids)` - Dedupe and add new articles
- `getRecentGuids(subscriptionId, count)` - For incremental sync

**Reactivity Pattern:**

```typescript
// Any component/store that accesses liveDb.subscriptions will re-render
// when subscriptionsVersion changes
let subscriptions = $derived.by(() => {
	const _version = liveDb.subscriptionsVersion; // Track version
	return liveDb.subscriptions;
});
```

---

### 2. App Manager (`app.svelte.ts`)

Central orchestrator that coordinates initialization and refresh cycles.

```typescript
type AppPhase = 'idle' | 'hydrating' | 'refreshing' | 'ready' | 'error';

function createAppManager() {
	let phase = $state<AppPhase>('idle');

	async function initialize() {
		phase = 'hydrating';
		// Phase 1: Load from cache (parallel)
		await Promise.all([
			liveDb.loadSubscriptions(),
			liveDb.loadArticles(),
			readingStore.load(),
			// ...
		]);

		phase = 'refreshing';
		// Phase 2: Sync with backend
		await refreshFromBackend();

		phase = 'ready';
	}
}
```

**Phases:**
| Phase | Description | UI State |
|-------|-------------|----------|
| `idle` | Not started | - |
| `hydrating` | Loading from IndexedDB | Show loading if no cached data |
| `refreshing` | Syncing with backend | Show cached data, fetch in background |
| `ready` | Fully loaded | Normal operation |
| `error` | Initialization failed | Show error state |

---

### 3. Feed Status Store (`feedStatus.svelte.ts`)

Tracks per-feed status for error display and circuit breaker awareness.

```typescript
type FeedStatusType = 'ready' | 'pending' | 'error' | 'circuit-open';

interface FeedStatus {
	status: FeedStatusType;
	errorCount: number;
	errorMessage?: string;
	errorType?: 'transient' | 'permanent';
	nextRetryAt?: number; // Circuit breaker cooldown
}

function createFeedStatusStore() {
	let statuses = $state<Map<string, FeedStatus>>(new Map());

	// Derived: feeds that can be fetched (not in cooldown)
	let fetchableFeeds = $derived.by(() => {
		const now = Date.now();
		// Filter out feeds in circuit-breaker cooldown
		return [...statuses.keys()].filter((url) => {
			const status = statuses.get(url);
			if (status?.status === 'circuit-open' && status.nextRetryAt > now) {
				return false;
			}
			return true;
		});
	});
}
```

**Error Classification:**
| Error Type | HTTP Codes | UI Display |
|------------|------------|------------|
| Permanent | 401, 403, 404, 410 | "Feed unavailable" |
| Transient | 429, 5xx | "Temporarily unavailable" |
| Circuit Open | Has `nextRetryAt` | "Retry in X min" |

---

### 4. Feed Fetcher (`feedFetcher.ts`)

V2-only batch fetching with GUID-based incremental sync.

```typescript
const BATCH_SIZE = 50;
const GUIDS_PER_FEED = 10;

async function fetchAllFeeds(
	subscriptions: Subscription[],
	starredGuids: Set<string>
): Promise<FetchResult> {
	// Build requests with since_guids per feed
	const feedRequests = subscriptions.map((sub) => ({
		url: sub.feedUrl,
		since_guids: liveDb.getRecentGuids(sub.id, GUIDS_PER_FEED),
		subscriptionId: sub.id,
	}));

	// Process in batches of 50
	for (let i = 0; i < feedRequests.length; i += BATCH_SIZE) {
		const batch = feedRequests.slice(i, i + BATCH_SIZE);
		const { feeds } = await api.fetchFeedsBatchV2(batch);

		// Update feedStatusStore and merge articles
		for (const req of batch) {
			const result = feeds[req.url];
			feedStatusStore.updateFromV2Result(req.url, result);

			if (result.status === 'ready' && result.items.length > 0) {
				await liveDb.mergeArticles(req.subscriptionId, result.items, starredGuids);
			}
		}
	}
}
```

**Incremental Sync:**

- Each feed request includes the last 10 article GUIDs
- Backend returns only articles newer than those GUIDs
- Reduces bandwidth and processing time

---

### 5. Articles Store (`articles.svelte.ts`)

Provides derived views of articles from liveDb.

```typescript
function createArticlesStore() {
	// Derived: all articles (reactive via liveDb.articlesVersion)
	let allArticles = $derived.by(() => {
		const _version = liveDb.articlesVersion;
		return liveDb.articles;
	});

	// Derived: article lookup by guid
	let articlesByGuid = $derived(new Map(allArticles.map((a) => [a.guid, a])));

	// Derived: unread articles
	let unreadArticles = $derived.by(() => {
		const positions = readingStore.readPositions;
		return allArticles.filter((a) => !positions.has(a.guid));
	});

	// Derived: starred GUIDs (for article retention)
	let starredGuids = $derived.by(() => {
		const positions = readingStore.readPositions;
		const starred = new Set<string>();
		for (const [guid, pos] of positions) {
			if (pos.starred) starred.add(guid);
		}
		return starred;
	});
}
```

---

### 6. Subscriptions Store (`subscriptions.svelte.ts`)

CRUD operations for subscriptions. Uses liveDb for storage.

```typescript
function createSubscriptionsStore() {
	// Derived: subscriptions from liveDb
	let subscriptions = $derived.by(() => {
		const _version = liveDb.subscriptionsVersion;
		return liveDb.subscriptions;
	});

	async function add(feedUrl: string, title: string) {
		// 1. Sync to backend first
		await api.createSubscription({ rkey, feedUrl, title });

		// 2. Store locally after success
		await liveDb.addSubscription(subscription);

		// 3. Mark feed as pending
		feedStatusStore.markPending(feedUrl);
	}

	async function remove(id: number) {
		const sub = liveDb.getSubscriptionById(id);

		// 1. Delete from backend
		await api.deleteSubscription(sub.rkey);

		// 2. Delete locally (includes articles)
		await liveDb.deleteSubscription(id);

		// 3. Clear feed status
		feedStatusStore.clearStatus(sub.feedUrl);
	}
}
```

---

### 7. Feed View Store (`feedView.svelte.ts`)

Manages the unified feed view display. Handles filtering, view modes, and pagination.

```typescript
type ViewMode = 'articles' | 'shares' | 'userShares' | 'combined';

function createFeedViewStore() {
	// UI state
	let showOnlyUnread = $state(true);
	let loadedArticleCount = $state(50);

	// URL filters
	let feedFilter = $state<string | null>(null);
	let starredFilter = $state<string | null>(null);

	// Derived: view mode based on URL params
	let viewMode = $derived.by((): ViewMode => {
		if (sharedFilter) return 'userShares';
		if (sharerFilter || followingFilter) return 'shares';
		if (feedFilter || starredFilter) return 'articles';
		return 'combined';
	});

	// Derived: filtered articles
	let filteredArticles = $derived.by(() => {
		const allArticles = articlesStore.allArticles;
		const positions = readingStore.readPositions;

		let articles = allArticles;

		if (feedFilter) {
			articles = articles.filter((a) => a.subscriptionId === parseInt(feedFilter));
		}

		if (showOnlyUnread) {
			articles = articles.filter((a) => !positions.has(a.guid));
		}

		return articles;
	});

	// Derived: paginated articles
	let displayedArticles = $derived(filteredArticles.slice(0, loadedArticleCount));
}
```

---

## Data Flow

### Initialization Flow

```
┌─────────────────┐
│  User opens app │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  appManager.initialize()            │
│  phase = 'hydrating'                │
└────────┬────────────────────────────┘
         │
         ▼ (parallel)
┌─────────────────────────────────────────────────────────────────┐
│  liveDb.loadSubscriptions()  │  liveDb.loadArticles()           │
│  readingStore.load()         │  sharesStore.load()              │
└────────┬────────────────────────────────────────────────────────┘
         │
         │  UI renders immediately with cached data
         │
         ▼
┌─────────────────────────────────────┐
│  phase = 'refreshing'               │
│  refreshFromBackend()               │
└────────┬────────────────────────────┘
         │
         ▼ (parallel)
┌─────────────────────────────────────────────────────────────────┐
│  syncSubscriptions()         │  socialStore.loadFollowedUsers() │
│  fetchAllFeeds()             │  socialStore.loadFeed()          │
└────────┬────────────────────────────────────────────────────────┘
         │
         │  New articles merged → liveDb.articlesVersion++
         │  UI updates reactively
         │
         ▼
┌─────────────────────────────────────┐
│  phase = 'ready'                    │
└─────────────────────────────────────┘
```

### Adding a Subscription

```
┌──────────────────────────────┐
│  User enters feed URL        │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  subscriptionsStore.add()    │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  api.createSubscription()    │  → Backend syncs to user's PDS
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  liveDb.addSubscription()    │
│  subscriptionsVersion++      │  → Sidebar re-renders
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  feedStatusStore.markPending │
└────────┬─────────────────────┘
         │
         ▼ (background)
┌──────────────────────────────┐
│  fetchSingleFeed()           │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  api.fetchFeedV2()           │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  liveDb.mergeArticles()      │
│  articlesVersion++           │  → Feed list re-renders
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  feedStatusStore.markReady() │  → Sidebar shows ready state
└──────────────────────────────┘
```

### Background Refresh (Tab Visibility)

```
┌──────────────────────────────┐
│  Tab becomes visible         │
│  after > 5 minutes           │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  appManager.refreshFromBackend()
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  syncSubscriptions()         │  → Detect subs added/removed
│                              │    on other devices
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  fetchAllFeeds() with        │
│  since_guids for incremental │
│  sync                        │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  New articles merged         │
│  articlesVersion++           │  → UI updates reactively
└──────────────────────────────┘
```

---

## Reactivity Chain

The key to understanding UI updates is following the reactivity chain:

```
liveDb.articlesVersion++
         │
         ▼
articlesStore.allArticles (re-computed)
         │
         ▼
feedViewStore.filteredArticles (re-computed)
         │
         ▼
feedViewStore.displayedArticles (re-computed)
         │
         ▼
feedViewStore.currentItems (re-computed)
         │
         ▼
FeedListView.svelte re-renders
```

**Example: New article arrives**

1. `fetchAllFeeds()` receives new articles from API
2. `liveDb.mergeArticles()` adds them to `_articles` and bumps `articlesVersion`
3. `articlesStore.allArticles` (derived from liveDb) re-computes
4. `feedViewStore.filteredArticles` (derived from articlesStore) re-computes
5. `feedViewStore.currentItems` (derived from filteredArticles) re-computes
6. Components using `feedViewStore.currentItems` re-render

---

## IndexedDB Schema

```typescript
class SkyreaderDatabase extends Dexie {
  subscriptions: Table<Subscription>;  // ++id, rkey, feedUrl, ...
  articles: Table<Article>;            // ++id, subscriptionId, guid, publishedAt
  readPositionsCache: Table<...>;      // articleGuid (primary), starred
  socialShares: Table<SocialShare>;    // ++id, authorDid, recordUri, ...
  userShares: Table<UserShare>;        // ++id, rkey, articleGuid, ...
  shareReadPositions: Table<...>;      // ++id, shareUri, ...
}
```

**Article Indexes:**

- `subscriptionId` - For filtering by feed
- `guid` - For deduplication
- `publishedAt` - For sorting

---

## Article Retention

To prevent unbounded growth, articles are limited per feed:

```typescript
const MAX_ARTICLES_PER_FEED = 100;

async function enforceArticleLimit(subscriptionId, starredGuids) {
	const feedArticles = this._articles
		.filter((a) => a.subscriptionId === subscriptionId)
		.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

	if (feedArticles.length <= MAX_ARTICLES_PER_FEED) return;

	// Keep all starred + newest non-starred up to limit
	const starred = feedArticles.filter((a) => starredGuids.has(a.guid));
	const nonStarred = feedArticles.filter((a) => !starredGuids.has(a.guid));

	const keepCount = Math.max(0, MAX_ARTICLES_PER_FEED - starred.length);
	const toKeep = new Set([
		...starred.map((a) => a.guid),
		...nonStarred.slice(0, keepCount).map((a) => a.guid),
	]);

	// Delete excess articles from IndexedDB
	const toDelete = feedArticles.filter((a) => !toKeep.has(a.guid));
	await db.articles.bulkDelete(toDelete.map((a) => a.id));
}
```

---

## Error Handling

### Network Errors

```typescript
// In feedFetcher.ts
try {
	const { feeds } = await api.fetchFeedsBatchV2(batch);
	// Process results...
} catch (e) {
	// Batch failed - mark all feeds in batch as error
	for (const req of batch) {
		feedStatusStore.markError(req.url, e.message);
	}
}
```

### Per-Feed Errors

The V2 API returns per-feed status:

```typescript
{
  feeds: {
    "https://example.com/feed": {
      status: "error",
      error: "Feed not found",
      errorCount: 3,
      nextRetryAt: 1706000000  // Unix timestamp
    }
  }
}
```

This is mapped to `feedStatusStore`:

```typescript
feedStatusStore.updateFromV2Result(feedUrl, result);
// Updates status to 'error' or 'circuit-open' based on nextRetryAt
```

---

## Testing Checklist

1. **Cache-first works**: Clear network, reload page → see cached feeds
2. **Incremental sync works**: Add article to feed, refresh → only new article fetched
3. **Sub sync works**: Add sub on another device, refresh → new sub appears
4. **Errors display**: Point to invalid feed URL → see error badge
5. **Reactivity works**: Articles appear without page refresh after fetch completes
6. **Circuit breaker works**: Feed with errors shows "Retry in X min"
7. **Article retention works**: Feed with 150 articles → only keeps 100 (plus starred)

---

## File Reference

| File                                     | Responsibility               |
| ---------------------------------------- | ---------------------------- |
| `src/lib/services/liveDb.svelte.ts`      | Reactive IndexedDB wrapper   |
| `src/lib/services/feedFetcher.ts`        | V2 batch fetch logic         |
| `src/lib/stores/app.svelte.ts`           | Initialization orchestrator  |
| `src/lib/stores/subscriptions.svelte.ts` | Subscription CRUD            |
| `src/lib/stores/articles.svelte.ts`      | Article queries              |
| `src/lib/stores/feedStatus.svelte.ts`    | Per-feed error tracking      |
| `src/lib/stores/feedView.svelte.ts`      | Display filtering/pagination |
| `src/lib/stores/reading.svelte.ts`       | Read/starred state           |
| `src/lib/services/db.ts`                 | Dexie schema                 |
| `src/lib/services/api.ts`                | HTTP client                  |
