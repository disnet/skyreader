import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { generateTid } from '../utils/tid';

const MAX_SQL_PARAMS = 90; // Conservative limit for D1 (empirically lower than SQLite's 999)

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

interface ItemLabelRow {
  item_key: string;
  item_type: string;
  props: string | null;
  rkey: string | null;
  updated_at: number;
  deleted_at: number | null;
}

export type ReadItemType = 'article' | 'document';

// Backstop on a single delta response. The delta is bounded by read churn since
// the client's cursor, so this is only a runaway guard.
const READ_POSITIONS_MAX_ROWS = 100000;

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
    const sinceParam = url.searchParams.get('since');
    const parsed = sinceParam !== null ? parseInt(sinceParam, 10) : NaN;
    // A missing/invalid cursor falls back to "everything" (since 0). In practice
    // the client always sends a cursor (seeded from the batch fetch), so this is
    // only a safety net, never the steady-state path.
    const since = Number.isFinite(parsed) ? parsed : 0;

    const result = await env.DB.prepare(
      `
      SELECT item_key, item_type, props, rkey, updated_at, deleted_at FROM item_labels_cache
      WHERE user_did = ? AND label = 'read' AND item_type IN ('article', 'document') AND updated_at > ?
      ORDER BY updated_at DESC
      LIMIT ?
    `
    )
      .bind(session.did, since, READ_POSITIONS_MAX_ROWS)
      .all<ItemLabelRow>();

    let cursor = since;
    const positions = result.results.map((row) => {
      if (row.updated_at > cursor) cursor = row.updated_at;

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
      };
    });

    return new Response(JSON.stringify({ positions, cursor }), {
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
  const readAt = Date.now();
  const now = Math.floor(Date.now() / 1000);

  try {
    // Check if already read (and live — a tombstoned row must resurrect, not skip).
    const existing = await env.DB.prepare(
      "SELECT id FROM item_labels_cache WHERE user_did = ? AND item_key = ? AND label = 'read' AND deleted_at IS NULL"
    )
      .bind(session.did, itemGuid)
      .first();

    if (existing) {
      return new Response(JSON.stringify({ success: true, alreadyRead: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const props = buildReadProps({ readAt, itemUrl, itemTitle, authorDid });

    // Resurrecting upsert: a re-read of a tombstoned (un-read) row clears
    // deleted_at and bumps updated_at so the change carries on the forward delta.
    await env.DB.prepare(
      `
      INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
      VALUES (?, ?, ?, 'read', ?, ?, ?, ?)
      ON CONFLICT(user_did, item_key, label) DO UPDATE SET
        props = excluded.props,
        rkey = excluded.rkey,
        item_type = excluded.item_type,
        deleted_at = NULL,
        updated_at = excluded.updated_at
    `
    )
      .bind(session.did, itemGuid, itemType, props, rkey, now, now)
      .run();

    return new Response(JSON.stringify({ success: true, rkey }), {
      headers: { 'Content-Type': 'application/json' },
    });
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
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE item_labels_cache SET deleted_at = ?, updated_at = ? WHERE user_did = ? AND item_key = ? AND label = 'read'"
    )
      .bind(now, now, session.did, itemGuid)
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
  }>;
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

  const readAt = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const results: Array<{ itemGuid: string; rkey: string }> = [];

  try {
    // Get already-read (live) labels for these items so we skip them. Tombstoned
    // rows are intentionally NOT skipped — they must resurrect (chunked to avoid
    // SQL variable limit).
    const existingGuids = new Set<string>();
    const guidChunks = chunkArray(
      items.map((i) => i.itemGuid),
      MAX_SQL_PARAMS - 1
    ); // -1 for user_did param

    for (const chunk of guidChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const existingResult = await env.DB.prepare(
        `SELECT item_key FROM item_labels_cache WHERE user_did = ? AND label = 'read' AND deleted_at IS NULL AND item_key IN (${placeholders})`
      )
        .bind(session.did, ...chunk)
        .all<{ item_key: string }>();

      for (const row of existingResult.results) {
        existingGuids.add(row.item_key);
      }
    }

    // Filter out already-read items
    const newItems = items.filter((item) => !existingGuids.has(item.itemGuid));

    // Generate rkeys and prepare batch insert
    const itemsWithRkeys = newItems.map((item) => ({
      ...item,
      rkey: item.rkey || generateTid(),
    }));

    // Batch insert/resurrect read labels using D1 batch to avoid subrequest limit
    if (itemsWithRkeys.length > 0) {
      const insertStatements = itemsWithRkeys.map((item) => {
        const itemType: ReadItemType = item.itemType === 'document' ? 'document' : 'article';
        const props = buildReadProps({
          readAt,
          itemUrl: item.itemUrl,
          itemTitle: item.itemTitle,
          authorDid: item.authorDid,
        });

        return env.DB.prepare(
          `
          INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
          VALUES (?, ?, ?, 'read', ?, ?, ?, ?)
          ON CONFLICT(user_did, item_key, label) DO UPDATE SET
            props = excluded.props,
            rkey = excluded.rkey,
            item_type = excluded.item_type,
            deleted_at = NULL,
            updated_at = excluded.updated_at
        `
        ).bind(session.did, item.itemGuid, itemType, props, item.rkey, now, now);
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
