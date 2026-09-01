import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { generateTid } from '../utils/tid';
import { ARTICLE_WINDOW_PER_FEED } from '../config/window';
import { rssSubscriptionPredicate } from './ingest';
import {
  afterCursorParams,
  afterCursorSql,
  clampClientUpdatedAt,
  encodeDeltaCursor,
  parseSince,
} from '../utils/delta-cursor';

const MAX_SQL_PARAMS = 90; // Conservative limit for D1 (empirically lower than SQLite's 999)

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

interface ItemLabelRow {
  id: number;
  item_key: string;
  item_type: string;
  props: string | null;
  rkey: string | null;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number | null;
}

export type ReadItemType = 'article' | 'document';

// Rows in one delta page. This used to be a 100 000-row "runaway guard" with no
// `hasMore` and no way to page: if it ever truncated, the client advanced its
// forward-only cursor to the newest row it saw and permanently skipped the
// older tail. It is now an ordinary page size — the client drains until
// `hasMore` is false.
const READ_POSITIONS_DEFAULT_LIMIT = 500;
const READ_POSITIONS_MAX_LIMIT = 1000;

/**
 * The conflict clause the read writers share — the same user-time
 * last-write-wins guard as the label route. See migration 0076.
 */
const READ_UPSERT_CONFLICT = `ON CONFLICT(user_did, item_key, label) DO UPDATE SET
        props = excluded.props,
        item_type = excluded.item_type,
        deleted_at = NULL,
        updated_at = excluded.updated_at,
        client_updated_at = excluded.client_updated_at
      WHERE excluded.client_updated_at >= COALESCE(item_labels_cache.client_updated_at, 0)`;

const UNREAD_UPSERT_CONFLICT = `ON CONFLICT(user_did, item_key, label) DO UPDATE SET
        deleted_at = excluded.deleted_at,
        updated_at = excluded.updated_at,
        client_updated_at = excluded.client_updated_at
      WHERE excluded.client_updated_at >= COALESCE(item_labels_cache.client_updated_at, 0)`;

/**
 * Read-state join used by the feed/document annotation path (see feeds-v2.ts).
 * Returns the subset of `keys` the user has an active (non-tombstoned) `read`
 * label for, scoped to `itemType`. Chunked to stay under D1's SQL variable limit.
 * The server holds every GUID the proxy just returned, so this join rides along
 * for free and stamps read state onto the per-user response.
 */
export async function getReadKeys(
  env: Env,
  userDid: string,
  itemType: ReadItemType,
  keys: string[]
): Promise<Set<string>> {
  const readKeys = new Set<string>();
  if (keys.length === 0) return readKeys;

  const chunks = chunkArray(keys, MAX_SQL_PARAMS - 2); // -2 for user_did + item_type
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `SELECT item_key FROM item_labels_cache
       WHERE user_did = ? AND label = 'read' AND item_type = ? AND deleted_at IS NULL
       AND item_key IN (${placeholders})`
    )
      .bind(userDid, itemType, ...chunk)
      .all<{ item_key: string }>();
    for (const row of result.results) readKeys.add(row.item_key);
  }
  return readKeys;
}

// GET /api/reading/positions - forward read delta for the current user.
//
// Read state for articles/documents the client is *holding* now rides the fetch
// response itself (inline annotation, see feeds-v2.ts). This endpoint only closes
// the residual gap: an item already in the client's cache that was read (or
// un-read) on another device, which this device will not re-fetch. The client
// persists a cursor and calls `?since=<cursor>`; the server returns every `read`
// row that changed since — live rows AND tombstones — across both item types.
// The client adds the live ones it holds and removes the tombstoned ones.
//
// The cost is bounded by read churn since the last refresh, not by cache or
// history. There is no full/windowed branch: bootstrap read state arrives via
// annotation, and the client seeds its cursor from the batch fetch response.
//
// The cursor is compound — `(updated_at, id)`, base64 `updatedAt:id` on the
// wire — because `updated_at` alone has one-second resolution and a
// strictly-greater timestamp predicate silently drops every row written in the
// same second as the cursor's max. Legacy numeric cursors are still accepted.
// Pages are bounded and report `hasMore`; the client drains before persisting.
export async function handleGetReadPositions(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(request.url);
    // A missing/invalid cursor falls back to "everything" (since 0). In practice
    // the client always sends a cursor (seeded from the batch fetch), so this is
    // only a safety net, never the steady-state path.
    const since = parseSince(url.searchParams.get('since')) ?? { updatedAt: 0, id: 0 };

    const limitParam = url.searchParams.get('limit');
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), READ_POSITIONS_MAX_LIMIT)
      : READ_POSITIONS_DEFAULT_LIMIT;

    const result = await env.DB.prepare(
      `
      SELECT id, item_key, item_type, props, rkey, updated_at, deleted_at, client_updated_at
        FROM item_labels_cache
      WHERE user_did = ? AND label = 'read' AND item_type IN ('article', 'document')
        AND ${afterCursorSql()}
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `
    )
      .bind(session.did, ...afterCursorParams(since), limit + 1)
      .all<ItemLabelRow>();

    const hasMore = result.results.length > limit;
    const rows = hasMore ? result.results.slice(0, limit) : result.results;

    const positions = rows.map((row) => {
      let readAt: number | string | null = null;
      if (row.props) {
        try {
          readAt = JSON.parse(row.props).readAt ?? null;
        } catch {
          // ignore parse errors
        }
      }

      return {
        item_guid: row.item_key,
        item_type: row.item_type,
        read_at: readAt,
        rkey: row.rkey,
        deleted: row.deleted_at != null,
        // When the user acted, unix ms. The client refuses a remote row older
        // than its own local intent for the same item.
        client_updated_at: row.client_updated_at,
      };
    });

    const last = rows[rows.length - 1];
    // `cursor` stays a plain unix-seconds max for the previous release's client,
    // which compares it numerically. New clients use `nextSince` — the compound
    // cursor of the last row actually DELIVERED, never a clock reading.
    const cursor = last ? last.updated_at : since.updatedAt;
    const nextSince = last
      ? encodeDeltaCursor(last.updated_at, last.id)
      : encodeDeltaCursor(since.updatedAt, since.id);

    return new Response(JSON.stringify({ positions, cursor, nextSince, hasMore }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get read positions:', error);
    return new Response(JSON.stringify({ error: 'Failed to get read positions' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface MarkAsReadRequest {
  itemGuid: string;
  // Defaults to 'article'. Documents pass 'document' (item_key is the recordUri)
  // and carry rkey/authorDid so the row mirrors the legacy document read shape.
  itemType?: ReadItemType;
  itemUrl?: string;
  itemTitle?: string;
  rkey?: string;
  authorDid?: string;
  // When the USER marked this read, unix ms. Optional — an older client omits
  // it and gets server-now, i.e. today's arrival-ordered behaviour.
  updatedAt?: number;
}

function buildReadProps(opts: {
  readAt: number;
  itemUrl?: string;
  itemTitle?: string;
  authorDid?: string;
}): string {
  const props: Record<string, unknown> = {
    readAt: opts.readAt,
    itemUrl: opts.itemUrl || null,
    itemTitle: opts.itemTitle || null,
  };
  if (opts.authorDid) props.authorDid = opts.authorDid;
  return JSON.stringify(props);
}

// POST /api/reading/mark-read - Mark an item (article or document) as read
export async function handleMarkAsRead(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: MarkAsReadRequest;
  try {
    body = (await request.json()) as MarkAsReadRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { itemGuid, itemUrl, itemTitle, authorDid } = body;
  const itemType: ReadItemType = body.itemType === 'document' ? 'document' : 'article';

  if (!itemGuid) {
    return new Response(JSON.stringify({ error: 'itemGuid is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rkey = body.rkey || generateTid();
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const clientUpdatedAt = clampClientUpdatedAt(body.updatedAt, nowMs);
  // The moment the user read it, not the moment the queue drained.
  const readAt = clientUpdatedAt;

  try {
    // Preserve the stable rkey for an existing live row, but never skip the
    // guarded upsert: a later read is itself new user intent and must advance
    // client_updated_at so an older, delayed unread cannot win afterward.
    const existing = await env.DB.prepare(
      "SELECT rkey FROM item_labels_cache WHERE user_did = ? AND item_key = ? AND label = 'read' AND deleted_at IS NULL"
    )
      .bind(session.did, itemGuid)
      .first<{ rkey: string | null }>();

    const props = buildReadProps({ readAt, itemUrl, itemTitle, authorDid });

    // Resurrecting upsert: a re-read of a tombstoned (un-read) row clears
    // deleted_at and bumps updated_at so the change carries on the forward
    // delta — but only if this read is at least as recent, in USER time, as
    // whatever last touched the row. Otherwise a queue draining late would
    // re-read something the user has since marked unread elsewhere.
    await env.DB.prepare(
      `
      INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
      VALUES (?, ?, ?, 'read', ?, ?, ?, ?, ?)
      ${READ_UPSERT_CONFLICT}
    `
    )
      .bind(
        session.did,
        itemGuid,
        itemType,
        props,
        existing?.rkey ?? rkey,
        now,
        now,
        clientUpdatedAt
      )
      .run();

    return new Response(
      JSON.stringify({ success: true, rkey: existing?.rkey ?? rkey, alreadyRead: !!existing }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Failed to mark as read:', error);
    return new Response(JSON.stringify({ error: 'Failed to mark as read' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface MarkAsUnreadRequest {
  itemGuid: string;
  updatedAt?: number;
}

// POST /api/reading/mark-unread - Mark an item as unread (soft-delete read label)
export async function handleMarkAsUnread(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: MarkAsUnreadRequest;
  try {
    body = (await request.json()) as MarkAsUnreadRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { itemGuid } = body;

  if (!itemGuid) {
    return new Response(JSON.stringify({ error: 'itemGuid is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Soft-delete (tombstone) instead of a hard DELETE, so the un-read surfaces in
    // other devices' `?since=` deltas as a removal and propagates losslessly. A
    // later re-read resurrects the row (handleMarkAsRead); the hourly cron GCs old
    // tombstones (label/type-agnostic). Keyed by item_key, so it covers both
    // articles and documents.
    //
    // Guarded by user time, symmetrically with mark-read: an un-read that the
    // user performed BEFORE a read recorded elsewhere must not win just because
    // its request arrived later.
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const clientUpdatedAt = clampClientUpdatedAt(body.updatedAt, nowMs);
    await env.DB.prepare(
      `INSERT INTO item_labels_cache
         (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, deleted_at, client_updated_at)
       VALUES (?, ?, 'article', 'read', NULL, ?, ?, ?, ?, ?)
       ${UNREAD_UPSERT_CONFLICT}`
    )
      .bind(session.did, itemGuid, generateTid(), now, now, now, clientUpdatedAt)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to mark as unread:', error);
    return new Response(JSON.stringify({ error: 'Failed to mark as unread' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface BulkMarkAsReadRequest {
  items: Array<{
    itemGuid: string;
    itemType?: ReadItemType;
    itemUrl?: string;
    itemTitle?: string;
    rkey?: string;
    authorDid?: string;
    updatedAt?: number;
  }>;
  // Per-request fallback when every item shares one intent time.
  updatedAt?: number;
}

// POST /api/reading/mark-read-bulk - Mark multiple items (articles or documents) as read
export async function handleBulkMarkAsRead(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: BulkMarkAsReadRequest;
  try {
    body = (await request.json()) as BulkMarkAsReadRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { items } = body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ error: 'items array is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Limit items to avoid exceeding SQL variable limit
  if (items.length > 500) {
    return new Response(JSON.stringify({ error: 'Too many items (max 500)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const results: Array<{ itemGuid: string; rkey: string }> = [];

  try {
    // Preserve stable rkeys for existing live rows. They still go through the
    // conditional upsert so this read intent advances client_updated_at.
    const existingRkeys = new Map<string, string>();
    const guidChunks = chunkArray(
      items.map((i) => i.itemGuid),
      MAX_SQL_PARAMS - 1
    ); // -1 for user_did param

    for (const chunk of guidChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const existingResult = await env.DB.prepare(
        `SELECT item_key, rkey FROM item_labels_cache WHERE user_did = ? AND label = 'read' AND deleted_at IS NULL AND item_key IN (${placeholders})`
      )
        .bind(session.did, ...chunk)
        .all<{ item_key: string; rkey: string | null }>();

      for (const row of existingResult.results) {
        if (row.rkey) existingRkeys.set(row.item_key, row.rkey);
      }
    }

    // Generate rkeys and prepare batch insert
    const itemsWithRkeys = items.map((item) => ({
      ...item,
      rkey: existingRkeys.get(item.itemGuid) ?? item.rkey ?? generateTid(),
    }));

    // Batch insert/resurrect read labels using D1 batch to avoid subrequest limit
    if (itemsWithRkeys.length > 0) {
      const insertStatements = itemsWithRkeys.map((item) => {
        const itemType: ReadItemType = item.itemType === 'document' ? 'document' : 'article';
        const clientUpdatedAt = clampClientUpdatedAt(item.updatedAt ?? body.updatedAt, nowMs);
        const props = buildReadProps({
          readAt: clientUpdatedAt,
          itemUrl: item.itemUrl,
          itemTitle: item.itemTitle,
          authorDid: item.authorDid,
        });

        return env.DB.prepare(
          `
          INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
          VALUES (?, ?, ?, 'read', ?, ?, ?, ?, ?)
          ${READ_UPSERT_CONFLICT}
        `
        ).bind(session.did, item.itemGuid, itemType, props, item.rkey, now, now, clientUpdatedAt);
      });
      await env.DB.batch(insertStatements);
    }

    // Build results
    for (const item of itemsWithRkeys) {
      results.push({ itemGuid: item.itemGuid, rkey: item.rkey });
    }

    return new Response(
      JSON.stringify({
        success: true,
        marked: results.length,
        skipped: items.length - results.length,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Failed to bulk mark as read:', error);
    return new Response(JSON.stringify({ error: 'Failed to bulk mark as read' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

interface MarkFeedReadRequest {
  // Omit to mark every subscribed RSS feed (the global "mark all read" action).
  feedUrl?: string;
  // The archive head the client saw. Items ingested after the user pressed the
  // button stay unread, which is what the user meant. Omit for "everything in
  // the window right now".
  beforeSeq?: number;
  updatedAt?: number;
}

// Statements per D1 batch when inserting read rows.
const MARK_FEED_CHUNK = 100;
// A global mark-all touches every subscribed feed; bound the work the same way
// the timeline's cold start does, and log rather than truncate silently.
const MARK_FEED_MAX_FEEDS = 500;

/**
 * POST /api/reading/mark-feed-read — mark the canonical window read, server-side.
 *
 * `markAllAsRead` used to iterate the articles the ACTING DEVICE happened to
 * hold, so items another device held below this device's window stayed unread
 * there: the one action that should force agreement didn't. Doing it on the
 * server, over the same newest-K window every device is meant to display, makes
 * the result identical everywhere — and the rows ride the existing forward
 * delta out to every other device, covering items the acting device never had.
 *
 * Deliberately per-item rows rather than a per-feed `readWatermark` label: a
 * watermark would be O(1) per action but introduces a second read-state
 * authority needing precedence rules against per-item unread overrides. At most
 * K rows per feed is cheap enough not to buy that.
 */
export async function handleMarkFeedRead(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: MarkFeedReadRequest;
  try {
    body = (await request.json()) as MarkFeedReadRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const clientUpdatedAt = clampClientUpdatedAt(body.updatedAt, nowMs);
  const beforeSeq =
    typeof body.beforeSeq === 'number' && Number.isFinite(body.beforeSeq)
      ? Math.floor(body.beforeSeq)
      : null;

  try {
    let feedUrls: string[];
    if (body.feedUrl) {
      // Scoped to the caller's own subscriptions: this endpoint writes read
      // state, so it must not be usable to probe feeds the user doesn't follow.
      const subscribed = await env.DB.prepare(
        `SELECT 1 FROM subscriptions_cache
          WHERE user_did = ? AND feed_url = ? AND active = 1
            AND ${rssSubscriptionPredicate()}
          LIMIT 1`
      )
        .bind(session.did, body.feedUrl)
        .first();
      if (!subscribed) {
        return new Response(JSON.stringify({ error: 'Not subscribed to that feed' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      feedUrls = [body.feedUrl];
    } else {
      const rows = await env.DB.prepare(
        `SELECT DISTINCT feed_url FROM subscriptions_cache
          WHERE user_did = ? AND active = 1
            AND feed_url IS NOT NULL AND feed_url <> ''
            AND ${rssSubscriptionPredicate()}
          ORDER BY feed_url`
      )
        .bind(session.did)
        .all<{ feed_url: string }>();
      feedUrls = rows.results.map((r) => r.feed_url);
      if (feedUrls.length > MARK_FEED_MAX_FEEDS) {
        console.warn(
          `[reading] mark-feed-read covering ${MARK_FEED_MAX_FEEDS} of ${feedUrls.length} feeds for ${session.did}.`
        );
        feedUrls = feedUrls.slice(0, MARK_FEED_MAX_FEEDS);
      }
    }

    // Select and write one feed-chunk at a time rather than accumulating every
    // row first: on a large account the full set is tens of thousands of rows,
    // and a Worker has no business holding all of them to do work it can do
    // incrementally.
    let marked = 0;
    for (let i = 0; i < feedUrls.length; i += MARK_FEED_CHUNK) {
      const chunk = feedUrls.slice(i, i + MARK_FEED_CHUNK);

      // Every GUID inside each feed's newest-K window. Already-live rows still
      // need the guarded upsert: mark-all-read is fresh user intent and must
      // advance its user-time clock so an older queued unread cannot beat it.
      const selects = chunk.map((feedUrl) =>
        env.DB.prepare(
          `SELECT w.guid, json_extract(w.item_json, '$.url') AS url,
                  json_extract(w.item_json, '$.title') AS title
             FROM (SELECT fi.guid, fi.item_json FROM feed_items fi
                    WHERE fi.feed_url = ?2 ${beforeSeq !== null ? 'AND fi.seq <= ?4' : ''}
                    ORDER BY fi.published_at DESC, fi.seq DESC
                    LIMIT ?3) w`
        ).bind(
          ...(beforeSeq !== null
            ? [session.did, feedUrl, ARTICLE_WINDOW_PER_FEED, beforeSeq]
            : [session.did, feedUrl, ARTICLE_WINDOW_PER_FEED])
        )
      );
      const results = await env.DB.batch<{
        guid: string;
        url: string | null;
        title: string | null;
      }>(selects);

      const rows = results.flatMap((result) => result.results ?? []);
      for (let j = 0; j < rows.length; j += MARK_FEED_CHUNK) {
        await env.DB.batch(
          rows.slice(j, j + MARK_FEED_CHUNK).map((row) =>
            env.DB.prepare(
              `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
               VALUES (?, ?, 'article', 'read', ?, ?, ?, ?, ?)
               ${READ_UPSERT_CONFLICT}`
            ).bind(
              session.did,
              row.guid,
              buildReadProps({
                readAt: clientUpdatedAt,
                itemUrl: row.url ?? undefined,
                itemTitle: row.title ?? undefined,
              }),
              generateTid(),
              now,
              now,
              clientUpdatedAt
            )
          )
        );
      }
      marked += rows.length;
    }

    return new Response(JSON.stringify({ success: true, marked }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to mark feed as read:', error);
    return new Response(JSON.stringify({ error: 'Failed to mark feed as read' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
