import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { generateTid } from '../utils/tid';

const MAX_SQL_PARAMS = 90; // Conservative limit for D1 (empirically lower than SQLite's 999)

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

interface ItemLabelRow {
  item_key: string;
  props: string | null;
  rkey: string | null;
  updated_at: number;
}

// Read positions grow unbounded over the lifetime of an account, so the GET is
// optimized in three ways (see handleGetReadPositions):
//   1. Slim payload  — only item_guid/read_at/rkey are returned (no url/title).
//   2. Delta sync     — `?since=<updated_at>` returns only rows changed since the
//                       client's cursor; the common refresh is then tiny.
//   3. Windowing      — a full sync (no `since`) is bounded to recent reads.
// The window must be wide enough to cover every article the feed can surface on
// a cold start (empty cache). The cold-start fetch pulls the most-recent N items
// PER FEED regardless of age (see COLD_START_LIMIT in feedFetcher.ts), so a
// low-frequency feed's backlog can be well over a year old. If a read falls
// outside this window, that already-read article reappears as unread on a fresh
// login — there's no local read state to fall back on after logout clears the
// cache. Hence a generous window; the delta sync keeps steady-state cheap anyway.
// NOTE: the window must stay in sync with READ_POSITIONS_WINDOW_MS in the
// frontend's itemLabels store, which scopes its reconcile deletions to the same
// window so it never drops older local read state.
const READ_POSITIONS_WINDOW_SECONDS = 2 * 365 * 24 * 60 * 60; // 2 years
// Backstop on a single response. Must stay above the number of reads a heavy
// user can accumulate within the window, or ORDER BY updated_at DESC would drop
// the OLDEST in-window reads first — exactly the old articles we need to suppress.
const READ_POSITIONS_MAX_ROWS = 100000;

// GET /api/reading/positions - List read positions for the current user.
// Pass `?since=<unix_seconds>` for an incremental (delta) fetch; omit it for a
// full (windowed) fetch. Returns { positions, cursor }, where cursor is the max
// updated_at in the batch — the client sends it back as `since` next time.
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
    const since = sinceParam !== null ? parseInt(sinceParam, 10) : NaN;
    const isDelta = Number.isFinite(since);

    // Delta: only rows changed since the cursor (naturally small, no window).
    // Full: the most recent rows within the retention window.
    const lowerBound = isDelta
      ? since
      : Math.floor(Date.now() / 1000) - READ_POSITIONS_WINDOW_SECONDS;
    const comparator = isDelta ? '>' : '>=';

    const result = await env.DB.prepare(
      `
      SELECT item_key, props, rkey, updated_at FROM item_labels_cache
      WHERE user_did = ? AND label = 'read' AND item_type = 'article' AND updated_at ${comparator} ?
      ORDER BY updated_at DESC
      LIMIT ?
    `
    )
      .bind(session.did, lowerBound, READ_POSITIONS_MAX_ROWS)
      .all<ItemLabelRow>();

    let cursor = isDelta ? since : 0;
    const positions = result.results.map((row) => {
      if (row.updated_at > cursor) cursor = row.updated_at;

      let readAt: number | null = null;
      if (row.props) {
        try {
          readAt = JSON.parse(row.props).readAt ?? null;
        } catch {
          // ignore parse errors
        }
      }

      return {
        item_guid: row.item_key,
        read_at: readAt,
        rkey: row.rkey,
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
  itemUrl?: string;
  itemTitle?: string;
}

// POST /api/reading/mark-read - Mark an item as read
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

  const { itemGuid, itemUrl, itemTitle } = body;

  if (!itemGuid) {
    return new Response(JSON.stringify({ error: 'itemGuid is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rkey = generateTid();
  const readAt = Date.now();
  const now = Math.floor(Date.now() / 1000);

  try {
    // Check if already read
    const existing = await env.DB.prepare(
      "SELECT id FROM item_labels_cache WHERE user_did = ? AND item_key = ? AND label = 'read'"
    )
      .bind(session.did, itemGuid)
      .first();

    if (existing) {
      return new Response(JSON.stringify({ success: true, alreadyRead: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const props = JSON.stringify({
      readAt,
      itemUrl: itemUrl || null,
      itemTitle: itemTitle || null,
    });

    await env.DB.prepare(
      `
      INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
      VALUES (?, ?, 'article', 'read', ?, ?, ?, ?)
      ON CONFLICT(user_did, item_key, label) DO NOTHING
    `
    )
      .bind(session.did, itemGuid, props, rkey, now, now)
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

// POST /api/reading/mark-unread - Mark an item as unread (delete read label)
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
    await env.DB.prepare(
      "DELETE FROM item_labels_cache WHERE user_did = ? AND item_key = ? AND label = 'read'"
    )
      .bind(session.did, itemGuid)
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
    itemUrl?: string;
    itemTitle?: string;
  }>;
}

// POST /api/reading/mark-read-bulk - Mark multiple items as read
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
    // Get existing read labels for these items (chunked to avoid SQL variable limit)
    const existingGuids = new Set<string>();
    const guidChunks = chunkArray(
      items.map((i) => i.itemGuid),
      MAX_SQL_PARAMS - 1
    ); // -1 for user_did param

    for (const chunk of guidChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const existingResult = await env.DB.prepare(
        `SELECT item_key FROM item_labels_cache WHERE user_did = ? AND label = 'read' AND item_key IN (${placeholders})`
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
      rkey: generateTid(),
    }));

    // Batch insert new read labels using D1 batch to avoid subrequest limit
    if (itemsWithRkeys.length > 0) {
      const insertStatements = itemsWithRkeys.map((item) => {
        const props = JSON.stringify({
          readAt,
          itemUrl: item.itemUrl || null,
          itemTitle: item.itemTitle || null,
        });

        return env.DB.prepare(
          `
          INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
          VALUES (?, ?, 'article', 'read', ?, ?, ?, ?)
          ON CONFLICT(user_did, item_key, label) DO NOTHING
        `
        ).bind(session.did, item.itemGuid, props, item.rkey, now, now);
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
