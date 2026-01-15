import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

// Generate a TID (Timestamp Identifier) for AT Protocol records
function generateTid(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${now.toString(36)}${random}`;
}

interface ReadPositionRow {
  item_guid: string;
  item_url: string | null;
  item_title: string | null;
  starred: number;
  read_at: number;
  rkey: string;
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
    const result = await env.DB.prepare(`
      SELECT item_guid, item_url, item_title, starred, read_at, rkey
      FROM read_positions_cache
      WHERE user_did = ?
      ORDER BY read_at DESC
    `).bind(session.did).all<ReadPositionRow>();

    return new Response(JSON.stringify({ positions: result.results }), {
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
  starred?: boolean;
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
    body = await request.json() as MarkAsReadRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { itemGuid, itemUrl, itemTitle, starred } = body;

  if (!itemGuid) {
    return new Response(JSON.stringify({ error: 'itemGuid is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rkey = generateTid();
  const readAt = Date.now();

  try {
    // Check if already read (by item_guid for this user)
    const existing = await env.DB.prepare(
      'SELECT id FROM read_positions_cache WHERE user_did = ? AND item_guid = ?'
    ).bind(session.did, itemGuid).first();

    if (existing) {
      // Already marked as read, return success
      return new Response(JSON.stringify({ success: true, alreadyRead: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Write to D1 (source of truth)
    await env.DB.prepare(`
      INSERT INTO read_positions_cache
      (user_did, rkey, item_guid, item_url, item_title, starred, read_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).bind(
      session.did,
      rkey,
      itemGuid,
      itemUrl || null,
      itemTitle || null,
      starred ? 1 : 0,
      readAt
    ).run();

    // 2. Broadcast to other devices via realtime
    try {
      const hubId = env.REALTIME_HUB.idFromName('main');
      const hub = env.REALTIME_HUB.get(hubId);
      await hub.fetch('http://internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'read_position_sync',
          payload: {
            userDid: session.did,
            itemGuid,
            itemUrl: itemUrl || null,
            itemTitle: itemTitle || null,
            starred: starred || false,
            readAt,
            rkey,
          },
        }),
      });
    } catch (realtimeError) {
      console.error('Failed to broadcast read position:', realtimeError);
      // Don't fail the request if broadcast fails
    }

    // 3. Queue PDS sync in background (non-blocking)
    // The existing sync queue mechanism will handle this, or we can add a cron job later

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

// POST /api/reading/mark-unread - Mark an item as unread (delete read position)
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
    body = await request.json() as MarkAsUnreadRequest;
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
    // Delete from D1
    await env.DB.prepare(
      'DELETE FROM read_positions_cache WHERE user_did = ? AND item_guid = ?'
    ).bind(session.did, itemGuid).run();

    // Broadcast unread event to other devices
    try {
      const hubId = env.REALTIME_HUB.idFromName('main');
      const hub = env.REALTIME_HUB.get(hubId);
      await hub.fetch('http://internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'read_position_delete',
          payload: {
            userDid: session.did,
            itemGuid,
          },
        }),
      });
    } catch (realtimeError) {
      console.error('Failed to broadcast unread:', realtimeError);
    }

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

interface ToggleStarRequest {
  itemGuid: string;
  starred: boolean;
}

// POST /api/reading/toggle-star - Toggle starred status
export async function handleToggleStar(request: Request, env: Env): Promise<Response> {
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

  let body: ToggleStarRequest;
  try {
    body = await request.json() as ToggleStarRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { itemGuid, starred } = body;

  if (!itemGuid) {
    return new Response(JSON.stringify({ error: 'itemGuid is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Update starred status in D1
    const result = await env.DB.prepare(
      'UPDATE read_positions_cache SET starred = ? WHERE user_did = ? AND item_guid = ?'
    ).bind(starred ? 1 : 0, session.did, itemGuid).run();

    if (result.meta?.changes === 0) {
      return new Response(JSON.stringify({ error: 'Read position not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Broadcast star update to other devices
    try {
      const hubId = env.REALTIME_HUB.idFromName('main');
      const hub = env.REALTIME_HUB.get(hubId);
      await hub.fetch('http://internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'read_position_star',
          payload: {
            userDid: session.did,
            itemGuid,
            starred,
          },
        }),
      });
    } catch (realtimeError) {
      console.error('Failed to broadcast star update:', realtimeError);
    }

    return new Response(JSON.stringify({ success: true, starred }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to toggle star:', error);
    return new Response(JSON.stringify({ error: 'Failed to toggle star' }), {
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
    body = await request.json() as BulkMarkAsReadRequest;
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

  const readAt = Date.now();
  const results: Array<{ itemGuid: string; rkey: string }> = [];

  try {
    // Get existing read positions for these items
    const placeholders = items.map(() => '?').join(',');
    const existingResult = await env.DB.prepare(
      `SELECT item_guid FROM read_positions_cache WHERE user_did = ? AND item_guid IN (${placeholders})`
    ).bind(session.did, ...items.map(i => i.itemGuid)).all<{ item_guid: string }>();

    const existingGuids = new Set(existingResult.results.map(r => r.item_guid));

    // Filter out already-read items
    const newItems = items.filter(item => !existingGuids.has(item.itemGuid));

    // Insert new read positions
    for (const item of newItems) {
      const rkey = generateTid();
      await env.DB.prepare(`
        INSERT INTO read_positions_cache
        (user_did, rkey, item_guid, item_url, item_title, starred, read_at, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, unixepoch())
      `).bind(
        session.did,
        rkey,
        item.itemGuid,
        item.itemUrl || null,
        item.itemTitle || null,
        readAt
      ).run();
      results.push({ itemGuid: item.itemGuid, rkey });
    }

    // Broadcast bulk update to other devices
    if (results.length > 0) {
      try {
        const hubId = env.REALTIME_HUB.idFromName('main');
        const hub = env.REALTIME_HUB.get(hubId);
        await hub.fetch('http://internal/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'read_position_bulk_sync',
            payload: {
              userDid: session.did,
              items: results.map(r => ({
                itemGuid: r.itemGuid,
                rkey: r.rkey,
                readAt,
                starred: false,
              })),
            },
          }),
        });
      } catch (realtimeError) {
        console.error('Failed to broadcast bulk read:', realtimeError);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      marked: results.length,
      skipped: items.length - results.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to bulk mark as read:', error);
    return new Response(JSON.stringify({ error: 'Failed to bulk mark as read' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
