import { api } from './api';
import { liveDb } from './liveDb.svelte';
import { db, type FeedCursorEntry } from './db';
import { feedStatusStore, type V2FeedResult } from '$lib/stores/feedStatus.svelte';
import { socialStore } from '$lib/stores/social.svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { buildDocumentRequests, collectDocumentBatches } from './documentSync';
import { loadDigests, saveDigests, scopeKey } from './documentDigests';
import type { Subscription } from '$lib/types';

// Max authors per /documents request (matches the proxy/backend cap).
const DOCUMENT_BATCH_SIZE = 50;

const BATCH_SIZE = 50;
// Small first batch so the initial feeds land and the UI paints quickly;
// later batches use the full BATCH_SIZE for throughput.
const FIRST_BATCH_SIZE = 8;
const GUIDS_PER_FEED = 10;

// On a cold fetch (no stored cursor for a feed) the proxy cold-starts and serves
// a recent slice. With many subscriptions that's a lot of data to download and
// write to IndexedDB before the first paint, most of which the user will never
// scroll to. Cap the cold backlog; once a cursor is stored, incremental polls
// send `since_seq` and return only what's new, so steady state is unchanged.
const COLD_START_LIMIT = 30;

// Max consecutive drain rounds per sync. A returning reader whose backlog exceeds
// one `limit`-sized page gets paged across rounds (rather than one page per sync
// interval), but we bound the work so a pathological backlog can't spin forever —
// it just continues on the next sync. Logged when hit (no silent truncation).
const MAX_DRAIN_ROUNDS = 5;

/**
 * Check if a subscription's title should be updated from feed metadata.
 * Returns true when the current title is a fallback (URL, hostname, etc.)
 * and the feed provides a real title.
 */
function shouldUpdateTitle(
  currentTitle: string,
  feedUrl: string | undefined,
  fetchedTitle: string
): boolean {
  if (!fetchedTitle || fetchedTitle === 'Untitled Feed') return false;
  if (currentTitle === fetchedTitle) return false;

  // Update if current title is the feed URL
  if (feedUrl && currentTitle === feedUrl) return true;

  // Update if current title is just a hostname
  try {
    const hostname = feedUrl ? new URL(feedUrl).hostname : '';
    if (currentTitle === hostname) return true;
  } catch {
    // ignore invalid URL
  }

  return false;
}

export interface FetchResult {
  totalFeeds: number;
  successfulFeeds: number;
  failedFeeds: number;
  newArticles: number;
}

/**
 * Fetch all subscribed feeds using V2 batch API
 *
 * - Chunks feeds into batches of 50
 * - Uses GUID-based incremental sync (last 10 GUIDs per feed)
 * - Updates feedStatusStore with results
 * - Merges new articles into liveDb
 *
 * @param subscriptions - Array of subscriptions to fetch
 * @param savedGuids - Set of starred article GUIDs (to preserve during cleanup)
 */
export async function fetchAllFeeds(
  subscriptions: Subscription[],
  savedGuids: Set<string> = new Set()
): Promise<FetchResult> {
  const result: FetchResult = {
    totalFeeds: subscriptions.length,
    successfulFeeds: 0,
    failedFeeds: 0,
    newArticles: 0,
  };

  if (subscriptions.length === 0) return result;

  // Skip network requests when offline - cached articles are already loaded
  if (typeof navigator !== 'undefined' && !navigator.onLine) return result;

  // Load stored durable-log cursors once (one row per subscription we've polled).
  const cursors = new Map<number, FeedCursorEntry>();
  for (const c of await db.feedCursors.toArray()) cursors.set(c.subscriptionId, c);

  interface FeedRequest {
    url: string;
    since_guids?: string[];
    since_seq?: number;
    generation?: string;
    limit?: number;
    subscriptionId: number;
  }

  // Build the initial requests. A subscription with a stored cursor drains
  // incrementally via since_seq; one without cold-starts (sending recent GUIDs as
  // the migration boundary so a pre-cursor client still gets an incremental first
  // poll, else capping the cold backlog).
  const feedRequests: FeedRequest[] = [];
  for (const sub of subscriptions) {
    if (!sub.id || !sub.feedUrl) continue;

    // Skip AT Proto subscriptions (they don't have RSS feeds)
    if (sub.sourceType && sub.sourceType.startsWith('atproto.')) continue;

    // Skip feeds in circuit-breaker cooldown
    if (!feedStatusStore.canFetch(sub.feedUrl)) {
      continue;
    }

    const cursor = cursors.get(sub.id);
    if (cursor) {
      feedRequests.push({
        url: sub.feedUrl,
        since_seq: cursor.cursor,
        generation: cursor.generation,
        subscriptionId: sub.id,
      });
    } else {
      const recentGuids = liveDb.getRecentGuids(sub.id, GUIDS_PER_FEED);
      const hasGuids = recentGuids.length > 0;
      feedRequests.push({
        url: sub.feedUrl,
        since_guids: hasGuids ? recentGuids : undefined,
        limit: hasGuids ? undefined : COLD_START_LIMIT,
        subscriptionId: sub.id,
      });
    }
  }

  if (feedRequests.length === 0) return result;

  // Feeds whose backlog wasn't fully drained this round (hasMore), re-polled after
  // the initial pass. Only populated for batches whose merge succeeded.
  let drainQueue: Array<{ url: string; subscriptionId: number }> = [];
  // Cursor advances accumulate here (committed per-batch only after a successful
  // merge) and persist to Dexie once at the end.
  const cursorUpdates = new Map<number, FeedCursorEntry>();

  // Fetch a batch, merge its articles, advance cursors, and collect any feed that
  // still has backlog. `countStatus` is true only on the initial pass so drain
  // re-polls don't double-count successfulFeeds/failedFeeds in the result.
  async function processBatch(batch: FeedRequest[], countStatus: boolean): Promise<void> {
    try {
      const { feeds, readCursor } = await api.fetchFeedsBatchV2(
        batch.map((req) => ({
          url: req.url,
          since_guids: req.since_guids,
          since_seq: req.since_seq,
          generation: req.generation,
          limit: req.limit,
        }))
      );

      // Seed the forward-read-delta cursor from the first annotated batch (server
      // time at annotation), so the delta starts from bootstrap with no skew.
      if (readCursor) await itemLabelsStore.seedReadCursor(readCursor);

      // Articles are collected and merged once per batch (rather than once per
      // feed) so the in-memory article array is rebuilt and re-sorted a single
      // time — a big win on cold start with many feeds.
      const toMerge: Array<{ subscriptionId: number; items: V2FeedResult['items'] }> = [];

      // Read state stamped onto the response by the backend (inline annotation).
      // Applied additively after merge — read state arrives with its articles.
      const readGuids: string[] = [];

      // Cursor advances and drain re-polls for this batch are collected here and
      // committed to the shared state only AFTER the merge succeeds. Advancing a
      // cursor past items we failed to persist would skip them permanently on the
      // next poll (the proxy serves seq > cursor), so the cursor must never move
      // ahead of what actually landed in IndexedDB.
      const batchCursors: FeedCursorEntry[] = [];
      const batchDrain: Array<{ url: string; subscriptionId: number }> = [];

      for (const req of batch) {
        const feedResult = feeds[req.url] as V2FeedResult | undefined;

        if (!feedResult) {
          // No result for this feed (shouldn't happen)
          feedStatusStore.markError(req.url, 'No response from server');
          if (countStatus) result.failedFeeds++;
          continue;
        }

        // Update feed status
        feedStatusStore.updateFromV2Result(req.url, feedResult);

        if (feedResult.status === 'error') {
          if (countStatus) result.failedFeeds++;
          continue;
        }

        // Update subscription title/siteUrl from feed metadata (initial pass only)
        if (countStatus && feedResult.title) {
          const sub = liveDb.getSubscriptionById(req.subscriptionId);
          if (sub && shouldUpdateTitle(sub.title, sub.feedUrl, feedResult.title)) {
            await liveDb.updateSubscription(req.subscriptionId, {
              title: feedResult.title,
              siteUrl: feedResult.siteUrl ?? sub.siteUrl,
              localUpdatedAt: Date.now(),
            });
          }
        }

        // Stage the cursor advance (committed below, only if the merge succeeds).
        // The proxy handles generation internally (cold-starting on mismatch and
        // returning a fresh token), so we simply overwrite with whatever it hands
        // back — no client-side reset logic.
        if (feedResult.cursor != null && feedResult.generation) {
          batchCursors.push({
            subscriptionId: req.subscriptionId,
            cursor: feedResult.cursor,
            generation: feedResult.generation,
          });
        }

        // Queue new articles for a single batched merge below
        if (feedResult.items && feedResult.items.length > 0) {
          toMerge.push({ subscriptionId: req.subscriptionId, items: feedResult.items });
          for (const item of feedResult.items) {
            if (item.read) readGuids.push(item.guid);
          }
        }

        // Backlog not fully drained → stage a re-poll (committed below with the cursor).
        if (feedResult.hasMore) {
          batchDrain.push({ url: req.url, subscriptionId: req.subscriptionId });
        }

        if (countStatus) result.successfulFeeds++;
      }

      // Merge this batch's articles in one pass. This is the durable write; if it
      // throws (e.g. IndexedDB quota / aborted transaction) we fall to the catch
      // and the staged cursor advances below are NOT committed, so the next poll
      // re-requests these items from the old cursor rather than skipping them.
      if (toMerge.length > 0) {
        result.newArticles += await liveDb.mergeArticlesBatch(toMerge, savedGuids);
      }

      // Apply annotated read state additively (after merge, so the labels attach
      // to articles already in the store).
      if (readGuids.length > 0) {
        await itemLabelsStore.applyAnnotatedReads(readGuids, 'article');
      }

      // Merge succeeded — now it's safe to advance cursors and enqueue drains.
      for (const c of batchCursors) cursorUpdates.set(c.subscriptionId, c);
      for (const d of batchDrain) drainQueue.push(d);
    } catch (e) {
      // Batch request failed - mark all feeds in batch as error
      const errorMessage = e instanceof Error ? e.message : 'Batch request failed';
      for (const req of batch) {
        feedStatusStore.markError(req.url, errorMessage);
        if (countStatus) result.failedFeeds++;
      }
    }
  }

  // Initial pass. Each batch is merged (and repaints the UI) as it lands, so use
  // a small first batch to get content on screen fast, then ramp to full batches.
  let offset = 0;
  let isFirstBatch = true;
  while (offset < feedRequests.length) {
    const batchSize = isFirstBatch ? FIRST_BATCH_SIZE : BATCH_SIZE;
    const batch = feedRequests.slice(offset, offset + batchSize);
    offset += batchSize;
    isFirstBatch = false;
    await processBatch(batch, true);
  }

  // Drain loop: re-poll feeds that still had backlog, using their freshly-advanced
  // cursors, until none report more or we hit the round cap.
  let round = 0;
  while (drainQueue.length > 0 && round < MAX_DRAIN_ROUNDS) {
    round++;
    const thisRound = drainQueue;
    drainQueue = []; // processBatch repopulates with feeds still draining
    const reqs: FeedRequest[] = [];
    for (const q of thisRound) {
      const c = cursorUpdates.get(q.subscriptionId) ?? cursors.get(q.subscriptionId);
      if (c) {
        reqs.push({
          url: q.url,
          since_seq: c.cursor,
          generation: c.generation,
          subscriptionId: q.subscriptionId,
        });
      }
    }
    for (let i = 0; i < reqs.length; i += BATCH_SIZE) {
      await processBatch(reqs.slice(i, i + BATCH_SIZE), false);
    }
  }
  if (drainQueue.length > 0) {
    console.warn(
      `[feedFetcher] Drain cap (${MAX_DRAIN_ROUNDS} rounds) reached; ${drainQueue.length} feed(s) still have backlog and will continue on the next sync.`
    );
  }

  // Persist all cursor advances in one write.
  if (cursorUpdates.size > 0) {
    await db.feedCursors.bulkPut([...cursorUpdates.values()]);
  }

  return result;
}

/**
 * Fetch standard.site documents for all `atproto.documents` subscriptions via the
 * proxy batch endpoint and hand the results to the social store, which reconciles
 * them into the timeline (and IndexedDB).
 *
 * Each subscription maps to an author DID (`subjectDid`) scoped to a publication
 * (`feedUrl`: an at://...publication URI, or empty for all of the author's
 * documents). Each request echoes the per-scope content digest the client last
 * saw (`since_digest`); an unchanged scope returns a bodyless `unchanged` result
 * and re-downloads nothing, while a changed scope returns the full current set
 * (full-replace reconcile, so upstream edits and deletes self-heal).
 *
 * @param subscriptions - All subscriptions; non-document ones are ignored.
 */
export async function fetchAllDocuments(subscriptions: Subscription[]): Promise<void> {
  // Skip network requests when offline - cached documents are already loaded.
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  const digests = loadDigests();
  const requests = buildDocumentRequests(subscriptions, digests);
  if (requests.length === 0) return;

  // Collect every batch's results, then reconcile once. Applying per-batch would
  // clear + rewrite the whole IndexedDB table on each batch (O(batches × total));
  // a single apply at the end is one rewrite regardless of how many batches.
  let readCursor: number | undefined;
  const allAuthors = await collectDocumentBatches(requests, DOCUMENT_BATCH_SIZE, async (batch) => {
    const res = await api.fetchDocumentsBatchV2(batch);
    if (readCursor === undefined && res.readCursor) readCursor = res.readCursor;
    return res;
  });

  if (allAuthors.length > 0) {
    // Store the new per-scope digest from each changed (`ready`) scope so the next
    // poll can short-circuit. `unchanged`/`error` scopes keep the stored digest.
    let digestsChanged = false;
    for (const author of allAuthors) {
      if (author.status === 'ready' && author.digest) {
        digests[scopeKey(author.did, author.siteUri)] = author.digest;
        digestsChanged = true;
      }
    }
    if (digestsChanged) saveDigests(digests);

    // `unchanged` results are filtered out by reconcileDocuments' `status==='ready'`
    // check, so an empty-bodied scope never clears its documents.
    await socialStore.applyDocumentResults(allAuthors);

    // Apply annotated document read state additively, mirroring the article path.
    // Only `ready` entries carry documents; `unchanged`/`error` have none.
    if (readCursor) await itemLabelsStore.seedReadCursor(readCursor);
    const readUris: string[] = [];
    for (const author of allAuthors) {
      if (author.status !== 'ready' || !author.documents) continue;
      for (const doc of author.documents) {
        if (doc.read) readUris.push(doc.recordUri);
      }
    }
    if (readUris.length > 0) {
      await itemLabelsStore.applyAnnotatedReads(readUris, 'document');
    }
  }
}

export interface FetchSingleFeedResult {
  success: boolean;
  newArticles: number;
  title?: string;
  siteUrl?: string;
}

/**
 * Fetch a single feed using V2 API
 *
 * @param subscription - Subscription to fetch
 * @param force - If true, fetch from source ignoring cache
 * @param savedGuids - Set of starred article GUIDs
 */
export async function fetchSingleFeed(
  subscription: Subscription,
  force = false,
  savedGuids: Set<string> = new Set()
): Promise<FetchSingleFeedResult> {
  if (!subscription.id || !subscription.feedUrl) {
    return { success: false, newArticles: 0 };
  }

  // Skip if in circuit-breaker cooldown (unless forcing)
  if (!force && !feedStatusStore.canFetch(subscription.feedUrl)) {
    return { success: false, newArticles: 0 };
  }

  try {
    const recentGuids = force ? undefined : liveDb.getRecentGuids(subscription.id, GUIDS_PER_FEED);

    const feed = await api.fetchFeedV2(subscription.feedUrl, recentGuids);

    // Mark as ready
    feedStatusStore.markReady(subscription.feedUrl);

    // Update subscription title/siteUrl from feed metadata
    if (feed.title && shouldUpdateTitle(subscription.title, subscription.feedUrl, feed.title)) {
      await liveDb.updateSubscription(subscription.id, {
        title: feed.title,
        siteUrl: feed.siteUrl ?? subscription.siteUrl,
        localUpdatedAt: Date.now(),
      });
    }

    // Merge articles
    let newArticles = 0;
    if (feed.items && feed.items.length > 0) {
      newArticles = await liveDb.mergeArticles(subscription.id, feed.items, savedGuids);
    }

    return {
      success: true,
      newArticles,
      title: feed.title,
      siteUrl: feed.siteUrl,
    };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Failed to fetch feed';
    if (subscription.feedUrl) feedStatusStore.markError(subscription.feedUrl, errorMessage);
    return { success: false, newArticles: 0 };
  }
}

/**
 * Fetch feeds for newly added subscriptions
 * These are fetched one by one since they don't have any cached content yet
 *
 * @param subscriptions - New subscriptions to fetch
 * @param savedGuids - Set of starred article GUIDs
 * @param onProgress - Progress callback (current, total)
 */
export async function fetchNewSubscriptionFeeds(
  subscriptions: Subscription[],
  savedGuids: Set<string> = new Set(),
  onProgress?: (current: number, total: number) => void
): Promise<FetchResult> {
  const result: FetchResult = {
    totalFeeds: subscriptions.length,
    successfulFeeds: 0,
    failedFeeds: 0,
    newArticles: 0,
  };

  for (let i = 0; i < subscriptions.length; i++) {
    const sub = subscriptions[i];
    onProgress?.(i, subscriptions.length);

    const fetchResult = await fetchSingleFeed(sub, true, savedGuids);
    if (fetchResult.success) {
      result.successfulFeeds++;
      result.newArticles += fetchResult.newArticles;
    } else {
      result.failedFeeds++;
    }
  }

  onProgress?.(subscriptions.length, subscriptions.length);
  return result;
}

/**
 * Force refresh all feeds from source (bypass cache)
 *
 * @param subscriptions - Subscriptions to refresh
 * @param savedGuids - Set of starred article GUIDs
 * @param concurrency - Number of concurrent requests
 * @param delayMs - Delay between batches
 */
export async function forceRefreshAllFeeds(
  subscriptions: Subscription[],
  savedGuids: Set<string> = new Set(),
  concurrency = 3,
  delayMs = 1000
): Promise<FetchResult> {
  const result: FetchResult = {
    totalFeeds: subscriptions.length,
    successfulFeeds: 0,
    failedFeeds: 0,
    newArticles: 0,
  };

  if (subscriptions.length === 0) return result;

  // Process in batches with rate limiting
  for (let i = 0; i < subscriptions.length; i += concurrency) {
    const batch = subscriptions.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map((sub) => fetchSingleFeed(sub, true, savedGuids))
    );

    for (const batchResult of batchResults) {
      if (batchResult.status === 'fulfilled' && batchResult.value.success) {
        result.successfulFeeds++;
        result.newArticles += batchResult.value.newArticles;
      } else {
        result.failedFeeds++;
      }
    }

    // Delay between batches
    if (i + concurrency < subscriptions.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return result;
}
