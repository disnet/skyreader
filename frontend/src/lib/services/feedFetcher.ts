import { api, ApiError } from './api';
import { liveDb } from './liveDb.svelte';
import { db, getMetadata, setMetadata, type FeedCursorEntry } from './db';
import { feedStatusStore, type V2FeedResult } from '$lib/stores/feedStatus.svelte';
import { socialStore } from '$lib/stores/social.svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { buildDocumentRequests, collectDocumentBatches } from './documentSync';
import {
  buildSubscriptionIndex,
  groupTimelineItems,
  isRssSubscription,
  pruneAttemptedBackfills,
  selectBackfillTargets,
  shouldFallBackToBatch,
  shouldUpdateTitle,
  subscriptionMetaUpdate,
} from './timelineSync';
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

export interface FetchResult {
  totalFeeds: number;
  successfulFeeds: number;
  failedFeeds: number;
  newArticles: number;
}

// Dexie `metadata` key holding the global timeline cursor (one per client, not
// one per subscription — that's the whole point of the timeline).
const TIMELINE_CURSOR_KEY = 'timelineCursor';

// Dexie `metadata` key holding the feed URLs we've already tried to backfill
// through the per-feed endpoint (see backfillMissingSubscriptions).
const TIMELINE_BACKFILL_KEY = 'timelineBackfilledFeeds';
// Last feed selected for a backfill attempt. This rotates retryable failures so
// a broken prefix cannot consume every sync's bounded backfill budget.
const TIMELINE_BACKFILL_CURSOR_KEY = 'timelineBackfillCursor';

// Items per timeline page (the server caps at 200 too).
const TIMELINE_PAGE_LIMIT = 200;

// Cold-start pages are per-feed slices bounded by a server-side item budget, so a
// large subscription list takes several of them. A cold start is a one-time
// bootstrap, so it gets a much larger round budget than an incremental drain.
const MAX_COLD_START_ROUNDS = 25;

// Per-sync cap on the one-off per-feed backfills for subscriptions that arrived
// from another device. The rest continue on the next sync.
const MAX_BACKFILLS_PER_SYNC = 10;

interface TimelineCursor {
  cursor: number;
  generation: string;
}

// Set for the session once the backend answers 404 for /api/v2/timeline (an old
// or rolled-back Worker), so we stop probing and stay on the legacy batch path.
let timelineUnavailable = false;

/**
 * The whole refresh in ONE request (plus drain pages): `GET /api/v2/timeline`
 * returns every item newer than the client's global cursor across every
 * subscription, with read state already joined in.
 *
 * Returns null when the caller should fall back to the legacy per-feed batch
 * path — either the endpoint doesn't exist (old/rolled-back backend) or the
 * server says its crawler isn't filling the archive (`ingestActive: false`, the
 * whole pre-rollout window). The cursor is never committed in that case, so a
 * later switch to the timeline still cold-starts correctly.
 */
async function fetchTimeline(
  subscriptions: Subscription[],
  savedGuids: Set<string>
): Promise<FetchResult | null> {
  const rssSubs = subscriptions.filter(isRssSubscription);
  const result: FetchResult = {
    totalFeeds: rssSubs.length,
    successfulFeeds: 0,
    failedFeeds: 0,
    newArticles: 0,
  };
  if (rssSubs.length === 0) return result;

  // feedUrl → subscriptionId. Items for feeds we don't hold locally are skipped;
  // races with an unsubscribe are benign.
  const subIdByUrl = buildSubscriptionIndex(rssSubs);

  const stored = await getMetadata<TimelineCursor>(TIMELINE_CURSOR_KEY);
  let cursor = stored?.cursor;
  let generation = stored?.generation;

  // Cold-start paging state. The server hands back a continuation index into the
  // caller's feed list; the cursor to keep is the FIRST page's (the archive head
  // as of the moment the cold start began), committed only once the last page has
  // merged — a cold start abandoned halfway simply starts over next sync rather
  // than committing a cursor past feeds it never delivered.
  let coldOffset: number | undefined;
  let coldCursor: TimelineCursor | undefined;
  let incrementalRounds = 0;
  let coldRounds = 0;
  // Set when we stop because of a round cap rather than because we're done.
  let cappedOut = false;

  for (;;) {
    if (
      coldOffset === undefined
        ? incrementalRounds >= MAX_DRAIN_ROUNDS
        : coldRounds >= MAX_COLD_START_ROUNDS
    ) {
      cappedOut = true;
      break;
    }
    if (coldOffset === undefined) incrementalRounds++;
    else coldRounds++;

    let page;
    try {
      page = await api.fetchTimeline(
        coldOffset === undefined
          ? { since_seq: cursor, generation, limit: TIMELINE_PAGE_LIMIT }
          : { cold_offset: coldOffset, limit: TIMELINE_PAGE_LIMIT }
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Backend predates the timeline (or was rolled back): stay on /batch.
        timelineUnavailable = true;
        return null;
      }
      throw e;
    }

    // The server says whether this environment's crawler is actually filling the
    // archive. Until it is, use the legacy batch path and commit no cursor.
    if (shouldFallBackToBatch(page, rssSubs.length)) return null;

    if (page.readCursor) await itemLabelsStore.seedReadCursor(page.readCursor);

    const { toMerge, readGuids, feedUrls } = groupTimelineItems(page.items, subIdByUrl);

    // One merge per page (rebuild + re-sort the in-memory array once), same
    // discipline as the batch path. If it throws, the cursor below is NOT
    // committed, so the next poll re-requests these items instead of skipping them.
    if (toMerge.length > 0) {
      result.newArticles += await liveDb.mergeArticlesBatch(toMerge, savedGuids);
    }
    if (readGuids.length > 0) {
      await itemLabelsStore.applyAnnotatedReads(readGuids, 'article');
    }

    // Backfill subscription title/siteUrl from the archive's feed metadata.
    if (page.feeds) {
      for (const [feedUrl, meta] of Object.entries(page.feeds)) {
        const subscriptionId = subIdByUrl.get(feedUrl);
        if (!subscriptionId) continue;
        const sub = liveDb.getSubscriptionById(subscriptionId);
        if (!sub) continue;
        const updates = subscriptionMetaUpdate(sub, meta);
        if (updates) {
          await liveDb.updateSubscription(subscriptionId, {
            ...updates,
            localUpdatedAt: Date.now(),
          });
        }
      }
    }

    // A feed that just delivered items is demonstrably healthy; clear any stale
    // error state. Feeds that delivered nothing are left alone — the archive
    // carries no per-feed fetch status (that lives with the crawler).
    for (const feedUrl of feedUrls) feedStatusStore.markReady(feedUrl);

    if (page.coldStart) {
      // Keep the first cold page's cursor; page through the rest before committing.
      if (!coldCursor) coldCursor = { cursor: page.cursor, generation: page.generation };
      if (page.hasMore && page.nextColdOffset != null) {
        coldOffset = page.nextColdOffset;
        continue;
      }
      await setMetadata<TimelineCursor>(TIMELINE_CURSOR_KEY, coldCursor);
      coldOffset = undefined;
      break;
    }

    // Merge succeeded — commit the cursor.
    cursor = page.cursor;
    generation = page.generation;
    await setMetadata<TimelineCursor>(TIMELINE_CURSOR_KEY, { cursor, generation });

    if (!page.hasMore) break;
  }

  if (cappedOut) {
    console.warn(
      coldOffset !== undefined
        ? `[feedFetcher] Cold-start page cap (${MAX_COLD_START_ROUNDS} rounds) reached; the rest continues on the next sync.`
        : `[feedFetcher] Timeline drain cap (${MAX_DRAIN_ROUNDS} rounds) reached; the rest continues on the next sync.`
    );
  }

  // Subscriptions that arrived from another device sit below the global cursor,
  // so only the per-feed endpoint can deliver their history.
  result.newArticles += await backfillMissingSubscriptions(rssSubs, savedGuids);

  result.successfulFeeds = rssSubs.length;
  return result;
}

/**
 * One-off per-feed backfill for subscriptions the timeline can't reach.
 *
 * A subscription synced in from another device is already below the global
 * cursor, so the drain will never deliver its existing items — the legacy path
 * got this for free because every subscription carried its own cursor. Each feed
 * is successfully checked once (the success is recorded in Dexie), and only a
 * handful per sync, so this can't turn into a request storm after a large sync.
 */
async function backfillMissingSubscriptions(
  rssSubs: Subscription[],
  savedGuids: Set<string>
): Promise<number> {
  const hasArticles = (sub: Subscription) => liveDb.getRecentGuids(sub.id!, 1).length > 0;
  // Steady state: every subscription holds articles, so this costs one in-memory
  // scan and never touches Dexie metadata.
  if (!rssSubs.some((sub) => sub.id && !hasArticles(sub))) return 0;

  const attempted = new Set((await getMetadata<string[]>(TIMELINE_BACKFILL_KEY)) ?? []);
  const afterFeedUrl = (await getMetadata<string>(TIMELINE_BACKFILL_CURSOR_KEY)) ?? undefined;
  const targets = selectBackfillTargets(
    rssSubs,
    attempted,
    hasArticles,
    MAX_BACKFILLS_PER_SYNC,
    afterFeedUrl
  );
  if (targets.length === 0) return 0;

  let newArticles = 0;
  for (const sub of targets) {
    // Not `force`: the archive read is already current, and the backend still
    // pulls the feed through the crawler if it holds nothing for it.
    const fetched = await fetchSingleFeed(sub, false, savedGuids);
    newArticles += fetched.newArticles;
    // A successful empty response is still a completed backfill. Failures are
    // left eligible for a later sync (for example after reconnecting or after a
    // circuit-breaker cooldown expires).
    if (fetched.success) attempted.add(sub.feedUrl!);
  }

  await setMetadata<string>(TIMELINE_BACKFILL_CURSOR_KEY, targets.at(-1)!.feedUrl!);
  await setMetadata<string[]>(TIMELINE_BACKFILL_KEY, pruneAttemptedBackfills(attempted, rssSubs));
  return newArticles;
}

/**
 * Fetch all subscribed feeds.
 *
 * Preferred path: one `GET /api/v2/timeline` request (plus drain pages) served
 * from the server-side archive, with read state joined in. Falls back to the
 * legacy per-feed `POST /api/v2/feeds/batch` fan-out when the timeline isn't
 * available — an older backend, a rollback, or an environment whose crawler
 * isn't pushing into D1 yet.
 *
 * @param subscriptions - Array of subscriptions to fetch
 * @param savedGuids - Set of starred article GUIDs (to preserve during cleanup)
 */
export async function fetchAllFeeds(
  subscriptions: Subscription[],
  savedGuids: Set<string> = new Set()
): Promise<FetchResult> {
  // Skip network requests when offline - cached articles are already loaded
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { totalFeeds: subscriptions.length, successfulFeeds: 0, failedFeeds: 0, newArticles: 0 };
  }

  if (!timelineUnavailable) {
    try {
      const timelineResult = await fetchTimeline(subscriptions, savedGuids);
      if (timelineResult) return timelineResult;
    } catch (e) {
      console.error('[feedFetcher] Timeline sync failed, falling back to batch fetch:', e);
    }
  }

  return fetchAllFeedsViaBatch(subscriptions, savedGuids);
}

/**
 * Legacy path: per-feed batches against the proxy-backed `/api/v2/feeds/batch`,
 * with per-subscription durable-log cursors. Kept for one release so a rollback
 * (or a not-yet-ingesting environment) can't strand clients; removed in the
 * timeline cleanup phase.
 *
 * - Chunks feeds into batches of 50
 * - Uses GUID-based incremental sync (last 10 GUIDs per feed)
 * - Updates feedStatusStore with results
 * - Merges new articles into liveDb
 */
async function fetchAllFeedsViaBatch(
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

        // Update subscription title/siteUrl from feed metadata (initial pass only).
        // Title and siteUrl are backfilled independently: a sub added before
        // siteUrl tracking existed already has its proper title, so gating the
        // siteUrl write on a title change would leave it siteUrl-less forever —
        // which hides it from cross-type duplicate detection (findCrossTypeDuplicates).
        if (countStatus) {
          const sub = liveDb.getSubscriptionById(req.subscriptionId);
          if (sub) {
            const updates: { title?: string; siteUrl?: string; localUpdatedAt?: number } = {};
            if (feedResult.title && shouldUpdateTitle(sub.title, sub.feedUrl, feedResult.title)) {
              updates.title = feedResult.title;
            }
            if (feedResult.siteUrl && feedResult.siteUrl !== sub.siteUrl) {
              updates.siteUrl = feedResult.siteUrl;
            }
            if (updates.title !== undefined || updates.siteUrl !== undefined) {
              updates.localUpdatedAt = Date.now();
              await liveDb.updateSubscription(req.subscriptionId, updates);
            }
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
 * Fetch a single feed's newest slice from the server-side archive.
 *
 * This is how a brand-new subscription gets its history: its items sit BELOW the
 * client's global timeline cursor, so the timeline alone would never deliver
 * them. The backend pulls the feed through the crawler on a first-ever fetch.
 *
 * @param subscription - Subscription to fetch
 * @param force - Skips the client-side circuit-breaker check (the archive read
 *   itself is always current; there is no cache to bypass any more)
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

    // `force` asks the backend to re-crawl the feed before serving the archive
    // (a fresh subscription, or the user retrying a feed that looked broken).
    const feed = await api.fetchFeedV2(subscription.feedUrl, recentGuids, undefined, force);

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

// Pacing for the new-subscription backfill (OPML import is the big case: one
// per-feed request each). Small concurrent groups with a pause between them keep
// a 250-feed import comfortably under the endpoint's per-minute limit — the old
// unpaced loop would 429 partway through and finish with a screen of "broken"
// feeds that were only rate-limited.
const NEW_SUBSCRIPTION_CONCURRENCY = 3;
const NEW_SUBSCRIPTION_DELAY_MS = 1000;

/**
 * Fetch feeds for newly added subscriptions.
 *
 * These need the per-feed endpoint: their items sit below the global timeline
 * cursor, so the timeline alone would never deliver them. The backend already
 * crawled and ingested the first feeds at subscribe time, so this is normally a
 * plain archive read — no `force`, which would make each one a synchronous crawl.
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

  for (let i = 0; i < subscriptions.length; i += NEW_SUBSCRIPTION_CONCURRENCY) {
    onProgress?.(i, subscriptions.length);
    const group = subscriptions.slice(i, i + NEW_SUBSCRIPTION_CONCURRENCY);

    const groupResults = await Promise.allSettled(
      group.map((sub) => fetchSingleFeed(sub, false, savedGuids))
    );

    for (const groupResult of groupResults) {
      if (groupResult.status === 'fulfilled' && groupResult.value.success) {
        result.successfulFeeds++;
        result.newArticles += groupResult.value.newArticles;
      } else {
        result.failedFeeds++;
      }
    }

    if (i + NEW_SUBSCRIPTION_CONCURRENCY < subscriptions.length) {
      await new Promise((resolve) => setTimeout(resolve, NEW_SUBSCRIPTION_DELAY_MS));
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
