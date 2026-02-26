import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

// Generate a TID (Timestamp Identifier) for AT Protocol records
function generateTid(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${now.toString(36)}${random}`;
}

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
}

// GET /api/reading/positions - List all read positions for the current user
export async function handleGetReadPositions(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(
      `
      SELECT item_key, props, rkey FROM item_labels_cache
      WHERE user_did = ? AND label = 'read' AND item_type = 'article'
      ORDER BY updated_at DESC
    `
    )
      .bind(session.did)
      .all<ItemLabelRow>();

    const positions = result.results.map((row) => {
      let readAt: number | null = null;
      let itemUrl: string | null = null;
      let itemTitle: string | null = null;

      if (row.props) {
        try {
          const parsed = JSON.parse(row.props);
          readAt = parsed.readAt ?? null;
          itemUrl = parsed.itemUrl ?? null;
          itemTitle = parsed.itemTitle ?? null;
        } catch {
          // ignore parse errors
        }
      }

      return {
        item_guid: row.item_key,
        item_url: itemUrl,
        item_title: itemTitle,
        read_at: readAt,
        rkey: row.rkey,
      };
    });

    return new Response(JSON.stringify({ positions }), {
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
