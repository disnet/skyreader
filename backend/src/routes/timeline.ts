import type { Env, FeedItem, Session } from '../types';
import {
  CRAWLER_HEARTBEAT_KEY,
  CRAWLER_HEARTBEAT_FRESH_SECONDS,
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
const COLD_START_PER_FEED = 30;
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
 */
export async function readFeedSlice(
  env: Env,
  userDid: string,
  feedUrl: string,
  limit: number
): Promise<TimelineItem[]> {
  const rows = await env.DB.prepare(
    `SELECT fi.seq, fi.feed_url, fi.item_json, ${READ_FLAG_SQL}
       FROM feed_items fi
      WHERE fi.feed_url = ?2
      ORDER BY fi.seq DESC
      LIMIT ?3`
  )
    .bind(userDid, feedUrl, limit)
    .all<ItemRow>();
  return toTimelineItems(rows.results);
}

export interface FeedMetadataRow {
  title: string | null;
  site_url: string | null;
  description: string | null;
  image_url: string | null;
  last_ingest_at: number | null;
}

export async function readFeedMetadata(env: Env, feedUrl: string): Promise<FeedMetadataRow | null> {
  return env.DB.prepare(
    `SELECT title, site_url, description, image_url, last_ingest_at FROM feeds WHERE feed_url = ?`
  )
    .bind(feedUrl)
    .first<FeedMetadataRow>();
}

export interface ArchiveState {
  generation: string;
  // True when this environment's crawler has checked in recently. False means
  // nothing is filling this D1 (no INGEST_URL on the paired proxy, or the proxy
  // is down), so the client must not treat an empty/partial archive as the truth.
  ingestActive: boolean;
}

/**
 * Generation token + crawler liveness in one `sync_state` read (the timeline
 * needs both on every request, and they live one row apart).
 */
export async function readArchiveState(env: Env): Promise<ArchiveState> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM sync_state WHERE key IN ('items_generation', ?)`
  )
    .bind(CRAWLER_HEARTBEAT_KEY)
    .all<{ key: string; value: string }>();

  let generation = '';
  let heartbeat = 0;
  for (const row of rows.results) {
    if (row.key === 'items_generation') generation = row.value;
    else if (row.key === CRAWLER_HEARTBEAT_KEY) heartbeat = parseInt(row.value, 10) || 0;
  }

  const age = Math.floor(Date.now() / 1000) - heartbeat;
  return { generation, ingestActive: heartbeat > 0 && age <= CRAWLER_HEARTBEAT_FRESH_SECONDS };
}

/** The archive's current head; 0 when nothing has ever been ingested. */
async function archiveHead(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT MAX(seq) AS max_seq FROM feed_items').first<{
    max_seq: number | null;
  }>();
  return row?.max_seq ?? 0;
}

/**
 * Subscribed RSS feed URLs in a STABLE order — the cold start pages through this
 * list by index, so the ordering has to be the same from one page to the next.
 */
async function subscribedFeedUrls(env: Env, userDid: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT feed_url FROM subscriptions_cache
      WHERE user_did = ? AND active = 1
        AND feed_url IS NOT NULL AND feed_url <> ''
        AND ${rssSubscriptionPredicate()}
      ORDER BY feed_url`
  )
    .bind(userDid)
    .all<{ feed_url: string }>();
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
  const rows = await env.DB.prepare(
    `SELECT f.feed_url, f.title, f.site_url, f.image_url
       FROM feeds f
       JOIN (SELECT DISTINCT feed_url FROM subscriptions_cache
              WHERE user_did = ? AND active = 1
                AND ${rssSubscriptionPredicate()}) sc
         ON sc.feed_url = f.feed_url`
  )
    .bind(userDid)
    .all<{
      feed_url: string;
      title: string | null;
      site_url: string | null;
      image_url: string | null;
    }>();

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

  const url = new URL(request.url);
  const sinceSeqParam = url.searchParams.get('since_seq');
  const generationParam = url.searchParams.get('generation');
  const limitParam = url.searchParams.get('limit');
  const coldOffsetParam = url.searchParams.get('cold_offset');

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

  const { generation, ingestActive } = await readArchiveState(env);
  // Server time (unix seconds) at annotation. The client seeds its forward
  // read-delta cursor from this, exactly as /batch does today, so the delta
  // starts from bootstrap with no client/server clock skew.
  const readCursor = Math.floor(Date.now() / 1000);

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
      const rows = await env.DB.prepare(
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
      )
        .bind(session.did, sinceSeq, limit + 1)
        .all<ItemRow>();

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
            ORDER BY fi.seq DESC
            LIMIT ?3`
        ).bind(session.did, feedUrl, COLD_START_PER_FEED)
      );
      const results = await env.DB.batch<ItemRow>(statements);
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
