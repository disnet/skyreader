import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

// Durable, cross-device magazines. A magazine's membership + order are frozen at
// generate time and stored as opaque JSON blobs (params/items/position); the
// backend never interprets them. Sync is delta-based like item_labels_cache:
// `?since=` returns rows changed since the client's cursor, tombstones included.

interface MagazineRow {
  id: number;
  rkey: string;
  params: string;
  items: string;
  position: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function encodeCursor(updatedAt: number, id: number): string {
  return btoa(`${updatedAt}:${id}`);
}

function decodeCursor(cursor: string): { updatedAt: number; id: number } | null {
  try {
    const [updatedAtStr, idStr] = atob(cursor).split(':');
    const updatedAt = Number(updatedAtStr);
    const id = Number(idStr);
    if (isNaN(updatedAt) || isNaN(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rowToMagazine(row: MagazineRow) {
  return {
    rkey: row.rkey,
    params: JSON.parse(row.params),
    items: JSON.parse(row.items),
    position: row.position ? JSON.parse(row.position) : null,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

// GET /api/magazines - list magazines (full snapshot, or `?since=` delta)
export async function handleGetMagazines(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return unauthorized();

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(1, Number(limitParam) || DEFAULT_LIMIT), MAX_LIMIT);
  // Delta sync: `?since=<unix_seconds>` returns rows changed since the client's
  // cursor (updated_at strictly greater), tombstones included so deletions made
  // on other devices replay. Omit it for a full live-rows-only snapshot.
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam !== null ? parseInt(sinceParam, 10) : NaN;

  try {
    let query = `SELECT id, rkey, params, items, position, title, created_at, updated_at, deleted_at
      FROM magazines
      WHERE user_did = ?`;
    const params: (string | number)[] = [session.did];

    if (Number.isFinite(since)) {
      query += ' AND updated_at > ?';
      params.push(since);
    } else {
      query += ' AND deleted_at IS NULL';
    }

    if (cursor) {
      const parsed = decodeCursor(cursor);
      if (!parsed) return json({ error: 'Invalid cursor' }, 400);
      query += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
      params.push(parsed.updatedAt, parsed.updatedAt, parsed.id);
    }

    query += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
    params.push(limit + 1);

    const result = await env.DB.prepare(query)
      .bind(...params)
      .all<MagazineRow>();

    const hasMore = result.results.length > limit;
    const rows = hasMore ? result.results.slice(0, limit) : result.results;
    const magazines = rows.map(rowToMagazine);
    const nextCursor = hasMore
      ? encodeCursor(rows[rows.length - 1].updated_at, rows[rows.length - 1].id)
      : undefined;

    return json({ magazines, cursor: nextCursor });
  } catch (error) {
    console.error('Failed to get magazines:', error);
    return json({ error: 'Failed to get magazines' }, 500);
  }
}

interface UpsertMagazineRequest {
  rkey: string;
  params: unknown;
  items: unknown;
  position?: unknown;
  title?: string | null;
}

// POST /api/magazines - create or replace a magazine (generate / reroll)
export async function handleUpsertMagazine(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return unauthorized();

  let body: UpsertMagazineRequest;
  try {
    body = (await request.json()) as UpsertMagazineRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { rkey, params, items } = body;
  if (!rkey || typeof rkey !== 'string' || params === undefined || !Array.isArray(items)) {
    return json({ error: 'rkey, params, and items[] are required' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const positionValue =
    body.position === undefined || body.position === null ? null : JSON.stringify(body.position);

  try {
    await env.DB.prepare(
      `INSERT INTO magazines (user_did, rkey, params, items, position, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_did, rkey) DO UPDATE SET
         params = excluded.params,
         items = excluded.items,
         position = excluded.position,
         title = excluded.title,
         updated_at = excluded.updated_at,
         deleted_at = NULL`
    )
      .bind(
        session.did,
        rkey,
        JSON.stringify(params),
        JSON.stringify(items),
        positionValue,
        body.title ?? null,
        now,
        now
      )
      .run();

    return json({ success: true, rkey });
  } catch (error) {
    console.error('Failed to upsert magazine:', error);
    return json({ error: 'Failed to upsert magazine' }, 500);
  }
}

interface UpdatePositionRequest {
  rkey: string;
  position: unknown;
}

// PATCH /api/magazines/position - update just the reading position (cheap write)
export async function handleUpdateMagazinePosition(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return unauthorized();

  let body: UpdatePositionRequest;
  try {
    body = (await request.json()) as UpdatePositionRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.rkey || typeof body.rkey !== 'string') {
    return json({ error: 'rkey is required' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const positionValue =
    body.position === undefined || body.position === null ? null : JSON.stringify(body.position);

  try {
    const result = await env.DB.prepare(
      `UPDATE magazines SET position = ?, updated_at = ?
       WHERE user_did = ? AND rkey = ? AND deleted_at IS NULL`
    )
      .bind(positionValue, now, session.did, body.rkey)
      .run();

    // A position write can race ahead of the create still sitting in the offline
    // queue; report not-found so the client keeps the queued create authoritative.
    const changed = result.meta?.changes ?? 0;
    if (changed === 0) return json({ success: false, error: 'Magazine not found' }, 404);
    return json({ success: true });
  } catch (error) {
    console.error('Failed to update magazine position:', error);
    return json({ error: 'Failed to update magazine position' }, 500);
  }
}

interface DeleteMagazineRequest {
  rkey: string;
}

// DELETE /api/magazines - soft-delete (tombstone) a magazine
export async function handleDeleteMagazine(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return unauthorized();

  let body: DeleteMagazineRequest;
  try {
    body = (await request.json()) as DeleteMagazineRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.rkey || typeof body.rkey !== 'string') {
    return json({ error: 'rkey is required' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      'UPDATE magazines SET deleted_at = ?, updated_at = ? WHERE user_did = ? AND rkey = ?'
    )
      .bind(now, now, session.did, body.rkey)
      .run();
    return json({ success: true });
  } catch (error) {
    console.error('Failed to delete magazine:', error);
    return json({ error: 'Failed to delete magazine' }, 500);
  }
}
