import type { Env, FeedItem, Session } from '../types';
import { ARTICLE_WINDOW_PER_FEED } from '../config/window';
import { log } from '../utils/logger';
import { timedAll, timedBatch, timedFirst, getD1Timings, d1Summary } from '../utils/d1-timing';
import {
  CRAWLER_HEARTBEAT_KEY,
  CRAWLER_HEARTBEAT_FRESH_SECONDS,
  FEED_HEALTH_REV_KEY,
  TIMELINE_ENABLED_KEY,
  rssSubscriptionPredicate,
} from './ingest';

/**
 * GET /api/v2/timeline — the whole feed refresh, in one request.
 *
 * Replaces the `1 + ceil((N-8)/50)` batched `POST /api/v2/feeds/batch` calls
 * (each a Worker → Fly hop plus `ceil(GUIDs/88)` chunked read-key queries). The
 * crawler pushes items into D1; this serves them with subscriptions AND read
 * state resolved in the same query, so `getReadKeys` never runs on the feed path.
 *
 * Named `/timeline` rather than `/sync` to avoid colliding with the existing
 * PDS-subscription `/api/sync/*` routes.
 */

// Max items in one page. Also the cap on how much a single response can weigh —
// items carry (capped) content bodies.
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 200;

// Cold start delivers a per-feed newest slice, not a global one: a global
// `ORDER BY seq DESC LIMIT n` would let one chatty feed starve every other.
//
// This is K — the same window the client caps its local set at and the same
// window the unread counts below are computed over. It was 30 while the client
// kept 100, which is why a fresh device and an established one showed different
// unread numbers for the same feed however well read state synced. Cold start
// is paged (COLD_START_MAX_ITEMS), so the larger value costs more pages, not a
// heavier response.
const COLD_START_PER_FEED = ARTICLE_WINDOW_PER_FEED;
// Statements per D1 batch on the cold-start path.
const COLD_START_CHUNK = 25;
// A cold start touches every subscribed feed; bound the work (and log if hit —
// no silent truncation).
const COLD_START_MAX_FEEDS = 500;
// Rows one cold-start PAGE may accumulate. A cold start walks feeds in a stable
// order and stops once it passes this budget, handing back `nextColdOffset` for
// the next page — so a 150-feed reader (or everyone at once after a generation
// bump) can't ask the Worker to buffer thousands of content-bearing items in a
// single response. Checked per chunk, so a page can overshoot by at most
// COLD_START_CHUNK × COLD_START_PER_FEED.
const COLD_START_MAX_ITEMS = 750;

export interface TimelineItem extends FeedItem {
  seq: number;
  feedUrl: string;
  read: boolean;
}

interface ItemRow {
  seq: number;
  feed_url: string;
  item_json: string;
  read: number;
}

// The per-user read probe. An EXISTS (rather than a LEFT JOIN) keeps the result
// one row per item even if a user somehow holds duplicate label rows, while
// probing the same (user_did, item_key) index a join would.
const READ_FLAG_SQL = `EXISTS (
        SELECT 1 FROM item_labels_cache il
         WHERE il.user_did = ?1 AND il.item_key = fi.guid
           AND il.item_type = 'article' AND il.label = 'read' AND il.deleted_at IS NULL
      ) AS read`;

function toTimelineItems(rows: ItemRow[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const row of rows) {
    try {
      const item = JSON.parse(row.item_json) as FeedItem;
      items.push({ ...item, seq: row.seq, feedUrl: row.feed_url, read: row.read === 1 });
    } catch {
      // A corrupt row must not poison the whole page; skip it. The cursor still
      // advances past it, so it can't wedge the client's drain loop.
      console.error(`[timeline] Unparseable item_json at seq ${row.seq}`);
    }
  }
  return items;
}

/**
 * Newest slice of one feed, read-annotated — the single-feed read path
 * (`GET /api/v2/feeds/fetch`), which now serves D1 like everything else.
 *
 * `offset` pages DOWN into the archive: the client's local set is capped at K
 * per feed and trims oldest-first, so anything below that is invisible to it
 * even though D1 never pruned a thing. The "Show older" affordance starts at
 * `offset = K` and walks down — which is what turns local eviction back into a
 * cache miss instead of something the reader experiences as lost data.
 *
 * Offset rather than a keyset cursor because the client doesn't hold `seq` for
 * its own articles, and the ordering key (`published_at`) is not unique. This is
 * a manual, transient browse of an append-mostly list: an item ingested
 * mid-browse can shift a row by one, which is not worth a wire-level cursor.
 */
export async function readFeedSlice(
  env: Env,
  userDid: string,
  feedUrl: string,
  limit: number,
  offset = 0
): Promise<TimelineItem[]> {
  const rows = await timedAll<ItemRow>(
    'feed_slice',
    env.DB.prepare(
      `SELECT fi.seq, fi.feed_url, fi.item_json, ${READ_FLAG_SQL}
         FROM feed_items fi
        WHERE fi.feed_url = ?2
        ORDER BY fi.published_at DESC, fi.seq DESC
        LIMIT ?3 OFFSET ?4`
    ).bind(userDid, feedUrl, limit, offset)
  );
  return toTimelineItems(rows.results);
}

export interface FeedMetadataRow {
  title: string | null;
  site_url: string | null;
  description: string | null;
  image_url: string | null;
  last_ingest_at: number | null;
  // Crawl health (unix seconds), so a single-feed read can report a broken feed
  // even while it serves the archived items the feed still has.
  error_count: number;
  last_error: string | null;
  last_error_at: number | null;
  next_retry_at: number | null;
  last_fetch_at: number | null;
}

export async function readFeedMetadata(env: Env, feedUrl: string): Promise<FeedMetadataRow | null> {
  return timedFirst<FeedMetadataRow>(
    'feed_meta_row',
    env.DB.prepare(
      `SELECT title, site_url, description, image_url, last_ingest_at,
              error_count, last_error, last_error_at, next_retry_at, last_fetch_at
         FROM feeds WHERE feed_url = ?`
    ).bind(feedUrl)
  );
}

export interface ArchiveState {
  generation: string;
  // True when this environment's crawler has checked in recently. False means
  // nothing is filling this D1 (no INGEST_URL on the paired proxy, or the proxy
  // is down), so the client must not treat an empty/partial archive as the truth.
  crawlerFresh: boolean;
  // The operator's rollout gate (`timeline_enabled`, migration 0071). A fresh
  // heartbeat only proves a crawler is attached — it arrives seconds into a
  // backfill that takes hours — so this is the switch that actually moves readers
  // onto the timeline, and the switch that moves them back.
  timelineEnabled: boolean;
  // Revision of the unhealthy-feed set. A client that echoes this back unchanged
  // already holds current health and is sent no health payload.
  healthRev: string;
}

/**
 * Generation token, crawler liveness, the rollout gate and the feed-health
 * revision in one `sync_state` read (the timeline needs all four on every
 * request, and they are four rows of the same small table).
 */
export async function readArchiveState(env: Env): Promise<ArchiveState> {
  const rows = await timedAll<{ key: string; value: string }>(
    'archive_state',
    env.DB.prepare(
      `SELECT key, value FROM sync_state WHERE key IN ('items_generation', ?, ?, ?)`
    ).bind(CRAWLER_HEARTBEAT_KEY, FEED_HEALTH_REV_KEY, TIMELINE_ENABLED_KEY)
  );

  let generation = '';
  let heartbeat = 0;
  let healthRev = '';
  // Absent means enabled: only an explicit '0' holds clients on the batch path,
  // so an environment that never learned about this key behaves as it did before.
  let timelineEnabled = true;
  for (const row of rows.results) {
    if (row.key === 'items_generation') generation = row.value;
    else if (row.key === CRAWLER_HEARTBEAT_KEY) heartbeat = parseInt(row.value, 10) || 0;
    else if (row.key === FEED_HEALTH_REV_KEY) healthRev = row.value;
    else if (row.key === TIMELINE_ENABLED_KEY) timelineEnabled = row.value !== '0';
  }

  const age = Math.floor(Date.now() / 1000) - heartbeat;
  return {
    generation,
    crawlerFresh: heartbeat > 0 && age <= CRAWLER_HEARTBEAT_FRESH_SECONDS,
    timelineEnabled,
    healthRev,
  };
}

/**
 * Per-feed crawl health for the caller's subscriptions — the timeline path's
 * replacement for the per-feed `status: 'error'` the legacy batch response
 * carried inline.
 *
 * Only broken feeds are returned: the client treats absence as healthy, which is
 * what makes recovery work without sending a row per subscription. Driven from
 * the (small, partially indexed) unhealthy set rather than from the caller's
 * subscriptions, because on a healthy system that set is empty and this costs
 * nothing.
 *
 * Timestamps go out in MILLISECONDS — D1 stores seconds like the rest of the
 * backend, but the client's FeedStatus contract has always been ms.
 */
export async function subscribedFeedHealth(
  env: Env,
  userDid: string
): Promise<Record<string, FeedHealth>> {
  const rows = await timedAll<{
    feed_url: string;
    error_count: number;
    last_error: string | null;
    last_error_at: number | null;
    next_retry_at: number | null;
    last_fetch_at: number | null;
  }>(
    'feed_health',
    env.DB.prepare(
      `SELECT f.feed_url, f.error_count, f.last_error, f.last_error_at, f.next_retry_at, f.last_fetch_at
         FROM feeds f
        WHERE f.error_count > 0
          AND EXISTS (
                SELECT 1 FROM subscriptions_cache sc
                 WHERE sc.user_did = ? AND sc.feed_url = f.feed_url AND sc.active = 1
                   AND ${rssSubscriptionPredicate('sc')}
              )`
    ).bind(userDid)
  );

  const health: Record<string, FeedHealth> = {};
  for (const row of rows.results) {
    health[row.feed_url] = {
      errorCount: row.error_count,
      error: row.last_error ?? undefined,
      lastErrorAt: row.last_error_at ? row.last_error_at * 1000 : undefined,
      nextRetryAt: row.next_retry_at ? row.next_retry_at * 1000 : undefined,
      lastFetchedAt: row.last_fetch_at ? row.last_fetch_at * 1000 : undefined,
    };
  }
  return health;
}

/** One broken feed as the timeline reports it. Timestamps are unix ms. */
export interface FeedHealth {
  errorCount: number;
  error?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
  lastFetchedAt?: number;
}

/** The archive's current head; 0 when nothing has ever been ingested. */
async function archiveHead(env: Env): Promise<number> {
  const row = await timedFirst<{ max_seq: number | null }>(
    'archive_head',
    env.DB.prepare('SELECT MAX(seq) AS max_seq FROM feed_items')
  );
  return row?.max_seq ?? 0;
}

/**
 * Subscribed RSS feed URLs in a STABLE order — the cold start pages through this
 * list by index, so the ordering has to be the same from one page to the next.
 */
async function subscribedFeedUrls(env: Env, userDid: string): Promise<string[]> {
  const rows = await timedAll<{ feed_url: string }>(
    'cold_feed_urls',
    env.DB.prepare(
      `SELECT DISTINCT feed_url FROM subscriptions_cache
        WHERE user_did = ? AND active = 1
          AND feed_url IS NOT NULL AND feed_url <> ''
          AND ${rssSubscriptionPredicate()}
        ORDER BY feed_url`
    ).bind(userDid)
  );
  return rows.results.map((r) => r.feed_url);
}

/**
 * Feed-level metadata for the feeds the caller subscribes to. Small (tens of
 * rows) and only sent alongside a non-empty page, so a steady-state poll that
 * returns nothing costs exactly one query.
 */
async function subscribedFeedMetadata(
  env: Env,
  userDid: string
): Promise<Record<string, { title?: string; siteUrl?: string; imageUrl?: string }>> {
  const rows = await timedAll<{
    feed_url: string;
    title: string | null;
    site_url: string | null;
    image_url: string | null;
  }>(
    'feed_metadata',
    env.DB.prepare(
      `SELECT f.feed_url, f.title, f.site_url, f.image_url
         FROM feeds f
         JOIN (SELECT DISTINCT feed_url FROM subscriptions_cache
                WHERE user_did = ? AND active = 1
                  AND ${rssSubscriptionPredicate()}) sc
           ON sc.feed_url = f.feed_url`
    ).bind(userDid)
  );

  const feeds: Record<string, { title?: string; siteUrl?: string; imageUrl?: string }> = {};
  for (const row of rows.results) {
    feeds[row.feed_url] = {
      title: row.title ?? undefined,
      siteUrl: row.site_url ?? undefined,
      imageUrl: row.image_url ?? undefined,
    };
  }
  return feeds;
}

// Statements per D1 batch on the counts path.
const COUNTS_CHUNK = 25;

/**
 * Per-feed unread counts over the canonical newest-K window.
 *
 * These numbers were derived client-side, over whatever articles the device
 * happened to hold — and no two devices hold the same slice, so the same feed
 * showed different unread numbers on a phone and a laptop even with read state
 * perfectly in sync. Computing them here, over one window every device agrees
 * on, is what makes them converge; the client displays these when online and
 * falls back to its local derivation offline.
 *
 * One per-feed index seek (`idx_feed_items_feed_seq` / the published_at order
 * the cold start already uses), bounded by K × subscriptions, and only on
 * requests that ask for it — once per refresh, not per drain page.
 */
async function subscribedUnreadCounts(
  env: Env,
  userDid: string,
  allFeedUrls: string[]
): Promise<Record<string, number>> {
  // Same bound as the cold start, for the same reason: one request must not turn
  // into unbounded work. A feed past the cap simply has no server count and the
  // client keeps deriving that one locally — degraded, not wrong.
  const feedUrls = allFeedUrls.slice(0, COLD_START_MAX_FEEDS);
  if (allFeedUrls.length > feedUrls.length) {
    console.warn(
      `[timeline] Unread counts covering ${feedUrls.length} of ${allFeedUrls.length} feeds for ${userDid}.`
    );
  }

  const counts: Record<string, number> = {};
  for (let i = 0; i < feedUrls.length; i += COUNTS_CHUNK) {
    const chunk = feedUrls.slice(i, i + COUNTS_CHUNK);
    const statements = chunk.map((feedUrl) =>
      env.DB.prepare(
        `SELECT ?2 AS feed_url, COUNT(*) AS unread FROM (
                SELECT fi.guid FROM feed_items fi
                 WHERE fi.feed_url = ?2
                 ORDER BY fi.published_at DESC, fi.seq DESC
                 LIMIT ?3) w
          WHERE NOT EXISTS (
                  SELECT 1 FROM item_labels_cache il
                   WHERE il.user_did = ?1 AND il.item_key = w.guid
                     AND il.item_type = 'article' AND il.label = 'read'
                     AND il.deleted_at IS NULL)`
      ).bind(userDid, feedUrl, ARTICLE_WINDOW_PER_FEED)
    );
    const results = await timedBatch<{ feed_url: string; unread: number }>(
      'unread_counts',
      env.DB,
      statements
    );
    for (const result of results) {
      for (const row of result.results ?? []) counts[row.feed_url] = row.unread;
    }
  }
  return counts;
}

export async function handleTimeline(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const startedAt = Date.now();
  try {
    return await runTimeline(request, env, session);
  } finally {
    logTimelineTiming(Date.now() - startedAt);
  }
}

/**
 * One `timeline_timing` line per request: which of the three shapes ran, and the
 * per-query breakdown underneath it.
 *
 * `d1WallMs - d1Ms` is the gap between the round trip the Worker measured and
 * the execution time D1 reports — i.e. the network between them. On a route that
 * makes four *sequential* round trips that gap is what dominates, and it is what
 * `[placement] mode = "smart"` moves, so this line is the before/after for that
 * change.
 *
 * Mind the windows: `handlerMs` is time inside this handler, while the `d1*`
 * fields cover every query in the REQUEST — including the `session_lookup` that
 * ran in the dispatcher before the handler was reached. That is deliberate (the
 * session round trip is part of what a reader waits for) but it means
 * `handlerMs - d1WallMs` is not Worker-side work and can go negative. For the
 * whole-request arithmetic use the `request` line, whose `durationMs` and `d1*`
 * fields do share a window.
 *
 * Logged unconditionally: `index.ts` already emits a `request` line per request,
 * so this is one extra line on one route rather than a step change in volume. If
 * it ever needs gating, threshold it on `handlerMs` here — nothing else reads it.
 */
function logTimelineTiming(handlerMs: number): void {
  const timings = getD1Timings();
  const summary = d1Summary();

  // Derived from which queries ran rather than threaded back out of the handler:
  // the cold-start path is the only one that lists feed URLs, and the incremental
  // query only runs when a valid cursor and generation arrived.
  const labels = new Set(timings.map((t) => t.label));
  const path = labels.has('cold_feed_urls')
    ? 'cold_start'
    : labels.has('timeline_incremental')
      ? 'incremental'
      : 'gated';

  log.info('timeline_timing', {
    path,
    handlerMs,
    ...summary,
    // Per-query breakdown, so a regression names the query instead of just the
    // route: label → [round-trip ms, D1 execution ms, rows read].
    queries: timings.map((t) => [t.label, t.wallMs, t.d1Ms, t.rowsRead]),
  });
}

async function runTimeline(request: Request, env: Env, session: Session): Promise<Response> {
  const url = new URL(request.url);
  const sinceSeqParam = url.searchParams.get('since_seq');
  const generationParam = url.searchParams.get('generation');
  const limitParam = url.searchParams.get('limit');
  const coldOffsetParam = url.searchParams.get('cold_offset');
  // The feed-health revision this client already holds. Absent (a fresh page
  // load, whose status store is empty) means "send it".
  const healthRevParam = url.searchParams.get('health_rev');
  // Server-authoritative per-feed unread counts. Asked for once per refresh (the
  // first page), never on drain pages — the numbers don't change between them.
  const wantsCounts = url.searchParams.get('include_counts') === '1';

  const parsedLimit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const parsedSince = sinceSeqParam !== null ? parseInt(sinceSeqParam, 10) : NaN;
  const sinceSeq = Number.isInteger(parsedSince) && parsedSince >= 0 ? parsedSince : undefined;

  // Continuation index into the caller's (stably ordered) subscribed-feed list.
  const parsedColdOffset = coldOffsetParam !== null ? parseInt(coldOffsetParam, 10) : NaN;
  const coldOffset =
    Number.isInteger(parsedColdOffset) && parsedColdOffset > 0 ? parsedColdOffset : 0;

  const { generation, crawlerFresh, timelineEnabled, healthRev } = await readArchiveState(env);
  // Two independent conditions, one wire field. The client's contract is
  // unchanged — `ingestActive: false` has always meant "stay on the batch path" —
  // and it does not need to know WHY, only the operator does.
  const ingestActive = timelineEnabled && crawlerFresh;

  // Server time (unix seconds) at annotation. The client seeds its forward
  // read-delta cursor from this, exactly as /batch does today, so the delta
  // starts from bootstrap with no client/server clock skew.
  const readCursor = Math.floor(Date.now() / 1000);

  // A client told `ingestActive: false` discards the page and refetches through
  // /batch, so building one is pure waste — and during a gated rollout that waste
  // is every reader, every poll, for as long as the gate stays shut. Answer with
  // the state and nothing else. `coldStart: true` keeps the older
  // empty-cold-start heuristic pointing the same way as the flag, so a client
  // reading either signal reaches the same conclusion.
  if (!ingestActive) {
    return json({
      items: [],
      cursor: 0,
      generation,
      ingestActive,
      hasMore: false,
      readCursor,
      coldStart: true,
      healthRev,
    });
  }

  // Send health when the client's copy is stale. A cold start always gets it:
  // it is the one page that delivers already-archived items for a feed that may
  // have broken since, and its blanket "these feeds delivered, so they're fine"
  // pass would otherwise clear a live error.
  const healthStale = healthRevParam !== healthRev;

  const incremental =
    sinceSeq !== undefined &&
    coldOffset === 0 &&
    generationParam === generation &&
    generation !== '';

  try {
    if (incremental) {
      // Drain oldest-unseen first so a backlog larger than one page is paged
      // across polls, never skipped. limit+1 probes hasMore without a second query.
      //
      // Scaling note: this walks the `feed_items` rowid range above the cursor and
      // probes the subscription set per row, so the cost tracks GLOBAL ingest above
      // the cursor rather than the caller's own new items. That is the accepted
      // fan-out-on-read trade at ~1,300 feeds; if D1 row-reads ever become the
      // constraint, the fix is to bound the scan with per-feed `(feed_url, seq)`
      // seeks (idx_feed_items_feed_seq already supports them), not to materialize
      // per-user timelines.
      const rows = await timedAll<ItemRow>(
        'timeline_incremental',
        env.DB.prepare(
          `SELECT fi.seq, fi.feed_url, fi.item_json, ${READ_FLAG_SQL}
             FROM feed_items fi
            WHERE fi.seq > ?2
              AND EXISTS (
                    SELECT 1 FROM subscriptions_cache sc
                     WHERE sc.user_did = ?1 AND sc.feed_url = fi.feed_url AND sc.active = 1
                       AND ${rssSubscriptionPredicate('sc')}
                  )
            ORDER BY fi.seq ASC
            LIMIT ?3`
        ).bind(session.did, sinceSeq, limit + 1)
      );

      const hasMore = rows.results.length > limit;
      const page = hasMore ? rows.results.slice(0, limit) : rows.results;

      // Rewound-archive guard, the D1 twin of the proxy's snapshot-restore check.
      // A Time Travel restore (or a rebuild from export) rewinds `feed_items` seqs
      // while `items_generation` comes back unchanged, leaving every client cursor
      // above the head: `seq > ?` then returns nothing on every poll, forever. A
      // cursor can never legitimately exceed the head, so treat that as a cold
      // start instead of silently starving the client. Only costs a MAX(seq) on
      // an otherwise empty page — never on a page that carried items.
      if (page.length === 0 && sinceSeq > (await archiveHead(env))) {
        console.warn(
          `[timeline] Cursor ${sinceSeq} is above the archive head; cold-starting (archive rewound?).`
        );
      } else {
        // Cursor comes from the returned rows, never a separate MAX(seq): the
        // latter races ingest and would skip everything written in between.
        const cursor = page.length > 0 ? page[page.length - 1].seq : sinceSeq;
        const items = toTimelineItems(page);

        return json({
          items,
          cursor,
          generation,
          ingestActive,
          hasMore,
          readCursor,
          coldStart: false,
          feeds: items.length > 0 ? await subscribedFeedMetadata(env, session.did) : undefined,
          healthRev,
          feedHealth: healthStale ? await subscribedFeedHealth(env, session.did) : undefined,
          unreadCounts: wantsCounts
            ? await subscribedUnreadCounts(
                env,
                session.did,
                await subscribedFeedUrls(env, session.did)
              )
            : undefined,
          // The archive head as of this response — what the client passes back as
          // `beforeSeq` when it marks a feed read, so items ingested after the
          // user pressed the button stay unread.
          head: wantsCounts ? await archiveHead(env) : undefined,
        });
      }
    }

    // Cold start: no cursor, a generation mismatch (D1 recreated / restored), a
    // rewound archive, or a continuation page of one already in progress.
    const allFeedUrls = await subscribedFeedUrls(env, session.did);
    const feedUrls = allFeedUrls.slice(0, COLD_START_MAX_FEEDS);
    if (allFeedUrls.length > feedUrls.length) {
      console.warn(
        `[timeline] Cold start covering ${feedUrls.length} of ${allFeedUrls.length} feeds for ${session.did}; the rest fill in as new items arrive.`
      );
    }

    // The cold-start cursor is the archive head read BEFORE the per-feed slices,
    // and the client keeps the first page's value across a paged cold start.
    // Reading it first is what makes it safe: an item ingested while we page gets
    // a seq above this head, so it arrives on the first incremental poll instead
    // of being skipped. (Re-delivering a handful of items is harmless — the merge
    // dedupes by GUID.) The incremental path still derives its cursor from the
    // rows it returned.
    const cursor = await archiveHead(env);

    // Walk feeds from the continuation point until the page budget is spent. The
    // client re-requests with `cold_offset=nextColdOffset` until hasMore is false.
    // A subscription added or removed mid-cold-start shifts the offsets by one, so
    // a feed can be missed by this bootstrap; the client's per-feed backfill picks
    // up any subscription that ends up with no articles.
    const rows: ItemRow[] = [];
    let nextIndex = Math.min(coldOffset, feedUrls.length);
    while (nextIndex < feedUrls.length && rows.length < COLD_START_MAX_ITEMS) {
      const chunk = feedUrls.slice(nextIndex, nextIndex + COLD_START_CHUNK);
      const statements = chunk.map((feedUrl) =>
        env.DB.prepare(
          `SELECT fi.seq, fi.feed_url, fi.item_json, ${READ_FLAG_SQL}
             FROM feed_items fi
            WHERE fi.feed_url = ?2
            ORDER BY fi.published_at DESC, fi.seq DESC
            LIMIT ?3`
        ).bind(session.did, feedUrl, COLD_START_PER_FEED)
      );
      const results = await timedBatch<ItemRow>('cold_slice', env.DB, statements);
      for (const result of results) rows.push(...(result.results ?? []));
      nextIndex += chunk.length;
    }
    const hasMore = nextIndex < feedUrls.length;

    const items = toTimelineItems(rows);
    return json({
      items,
      cursor,
      generation,
      ingestActive,
      hasMore,
      nextColdOffset: hasMore ? nextIndex : undefined,
      readCursor,
      coldStart: true,
      feeds: items.length > 0 ? await subscribedFeedMetadata(env, session.did) : undefined,
      healthRev,
      feedHealth: await subscribedFeedHealth(env, session.did),
      // Counts cover every subscribed feed, not just the page's slice — a paged
      // cold start would otherwise report a partial picture on its first page.
      unreadCounts: wantsCounts
        ? await subscribedUnreadCounts(env, session.did, allFeedUrls)
        : undefined,
      head: wantsCounts ? cursor : undefined,
    });
  } catch (error) {
    console.error('[timeline] Query error:', error);
    return new Response(JSON.stringify({ error: 'Failed to load timeline' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}
