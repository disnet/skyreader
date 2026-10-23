import type { Env } from '../types';
import { isValidRkey } from '../utils/validation';

/**
 * Shelf collections — user-made, ordered groups of saves.
 *
 * The Shelf is the reference half of Saved: what a reader keeps and returns to,
 * as opposed to the to-read queue. Whether a save is on the Shelf at all is a
 * `kept` item label (routes/labels.ts, no schema of its own); the collections
 * here are the one part that needs real tables, because they are ordered,
 * described and — later — exportable as a Semble/Margin collection or a room.
 *
 * Private and D1-only. The set is small (a reader's collections and their
 * members), so the client fetches it whole rather than through a delta.
 * See docs/plans/SHELF_PLAN.md.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const MAX_COLLECTIONS = 200;
export const MAX_ITEMS_PER_COLLECTION = 2000;
export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  collection_id: string;
  saved_rkey: string;
  position: number;
  added_at: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function badRequest(error: string): Response {
  return json({ error }, 400);
}

/** A trimmed, length-checked collection name, or an error message. */
function parseName(value: unknown): { name: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'name is required' };
  const name = value.trim();
  if (!name) return { error: 'name is required' };
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `name must be at most ${MAX_NAME_LENGTH} characters` };
  }
  return { name };
}

/** null clears the description; a string is trimmed (empty clears too). */
function parseDescription(value: unknown): { description: string | null } | { error: string } {
  if (value === null) return { description: null };
  if (typeof value !== 'string') return { error: 'description must be a string or null' };
  const description = value.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` };
  }
  return { description: description || null };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function collectionExists(env: Env, did: string, id: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM shelf_collections WHERE user_did = ? AND id = ?')
    .bind(did, id)
    .first();
  return row !== null;
}

async function touchCollection(env: Env, did: string, id: string, now: number): Promise<void> {
  await env.DB.prepare('UPDATE shelf_collections SET updated_at = ? WHERE user_did = ? AND id = ?')
    .bind(now, did, id)
    .run();
}

// GET /api/shelf/collections — every collection with its members, in order.
async function listCollections(env: Env, did: string): Promise<Response> {
  const [collections, items] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, name, description, position, created_at, updated_at
         FROM shelf_collections WHERE user_did = ?
        ORDER BY position ASC, created_at ASC`
    ).bind(did),
    env.DB.prepare(
      `SELECT collection_id, saved_rkey, position, added_at
         FROM shelf_collection_items WHERE user_did = ?
        ORDER BY position ASC, added_at ASC`
    ).bind(did),
  ]);

  const byCollection = new Map<string, Array<{ rkey: string; addedAt: number }>>();
  for (const item of (items.results ?? []) as unknown as ItemRow[]) {
    let list = byCollection.get(item.collection_id);
    if (!list) {
      list = [];
      byCollection.set(item.collection_id, list);
    }
    list.push({ rkey: item.saved_rkey, addedAt: item.added_at });
  }

  return json({
    collections: ((collections.results ?? []) as unknown as CollectionRow[]).map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      position: c.position,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      items: byCollection.get(c.id) ?? [],
    })),
  });
}

// POST /api/shelf/collections — create. Idempotent on the client-minted id, so
// a retried create (lost response, sync-queue replay) doesn't fail or duplicate.
async function createCollection(request: Request, env: Env, did: string): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest('Invalid JSON body');

  const id = body.id;
  if (typeof id !== 'string' || !isValidRkey(id)) return badRequest('Invalid collection id');
  const name = parseName(body.name);
  if ('error' in name) return badRequest(name.error);
  const description = parseDescription(body.description ?? null);
  if ('error' in description) return badRequest(description.error);

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n, MAX(position) AS maxPos FROM shelf_collections WHERE user_did = ?'
  )
    .bind(did)
    .first<{ n: number; maxPos: number | null }>();
  if (await collectionExists(env, did, id)) {
    return json({ success: true, id });
  }
  if ((count?.n ?? 0) >= MAX_COLLECTIONS) {
    return json({ error: `You can have at most ${MAX_COLLECTIONS} collections` }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const position =
    typeof body.position === 'number' && Number.isFinite(body.position)
      ? body.position
      : (count?.maxPos ?? -1) + 1;
  await env.DB.prepare(
    `INSERT INTO shelf_collections (user_did, id, name, description, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_did, id) DO NOTHING`
  )
    .bind(did, id, name.name, description.description, position, now, now)
    .run();

  return json({ success: true, id });
}

// PATCH /api/shelf/collections/:id — rename, describe, or move.
async function updateCollection(
  request: Request,
  env: Env,
  did: string,
  id: string
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest('Invalid JSON body');

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if ('name' in body) {
    const name = parseName(body.name);
    if ('error' in name) return badRequest(name.error);
    sets.push('name = ?');
    params.push(name.name);
  }
  if ('description' in body) {
    const description = parseDescription(body.description);
    if ('error' in description) return badRequest(description.error);
    sets.push('description = ?');
    params.push(description.description);
  }
  if ('position' in body) {
    if (typeof body.position !== 'number' || !Number.isFinite(body.position)) {
      return badRequest('position must be a number');
    }
    sets.push('position = ?');
    params.push(body.position);
  }
  if (sets.length === 0) return badRequest('Nothing to update');

  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE shelf_collections SET ${sets.join(', ')}, updated_at = ? WHERE user_did = ? AND id = ?`
  )
    .bind(...params, now, did, id)
    .run();
  if (!result.meta.changes) return json({ error: 'Not found' }, 404);
  return json({ success: true });
}

// DELETE /api/shelf/collections/:id — the collection and its memberships. The
// saves themselves are untouched. Idempotent: deleting a missing one succeeds.
async function deleteCollection(env: Env, did: string, id: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM shelf_collection_items WHERE user_did = ? AND collection_id = ?'
    ).bind(did, id),
    env.DB.prepare('DELETE FROM shelf_collections WHERE user_did = ? AND id = ?').bind(did, id),
  ]);
  return json({ success: true });
}

/**
 * The rkeys a write names: `{rkey}` for one, `{rkeys}` for a bulk edit from the
 * Library's selection. Deduped, in the order given; null when malformed.
 */
function parseRkeys(body: Record<string, unknown>): string[] | null {
  const raw = 'rkeys' in body ? body.rkeys : [body.rkey];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_ITEMS_PER_COLLECTION ||
    raw.some((r) => typeof r !== 'string' || !isValidRkey(r))
  ) {
    return null;
  }
  return [...new Set(raw as string[])];
}

// POST /api/shelf/collections/:id/items {rkey} | {rkeys} — add saves to the end,
// in the order given. Idempotent: a member that's already there keeps its place.
// All or nothing at the cap: a bulk add that wouldn't fit adds none, so the
// reader isn't left guessing which half of a selection landed.
async function addItem(request: Request, env: Env, did: string, id: string): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest('Invalid JSON body');
  const rkeys = parseRkeys(body);
  if (!rkeys) {
    return badRequest('rkey must be a valid rkey, or rkeys an array of up to 2000 of them');
  }

  if (!(await collectionExists(env, did, id))) return json({ error: 'Not found' }, 404);

  const current = await env.DB.prepare(
    `SELECT saved_rkey, position FROM shelf_collection_items
      WHERE user_did = ? AND collection_id = ?`
  )
    .bind(did, id)
    .all<{ saved_rkey: string; position: number }>();
  const members = current.results ?? [];
  const memberSet = new Set(members.map((m) => m.saved_rkey));
  const fresh = rkeys.filter((r) => !memberSet.has(r));
  if (fresh.length === 0) return json({ success: true, added: 0 });
  if (members.length + fresh.length > MAX_ITEMS_PER_COLLECTION) {
    const room = Math.max(0, MAX_ITEMS_PER_COLLECTION - members.length);
    return json(
      {
        error:
          room === 0
            ? `A collection can hold at most ${MAX_ITEMS_PER_COLLECTION} items`
            : `A collection can hold at most ${MAX_ITEMS_PER_COLLECTION} items; this one has room for ${room} more`,
        room,
      },
      409
    );
  }

  const maxPos = members.reduce((max, m) => Math.max(max, m.position), -1);
  const now = Math.floor(Date.now() / 1000);
  // One INSERT for the lot: D1 caps bound parameters at 100 per statement and
  // statements at 1,000 per invocation, so the rkeys ride as one JSON array and
  // json_each's index gives each its position. (`WHERE true` keeps SQLite from
  // reading ON CONFLICT as part of the SELECT's join.)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
       SELECT ?1, ?2, value, ?3 + key, ?4 FROM json_each(?5) WHERE true
       ON CONFLICT(user_did, collection_id, saved_rkey) DO NOTHING`
    ).bind(did, id, maxPos + 1, now, JSON.stringify(fresh)),
    env.DB.prepare(
      'UPDATE shelf_collections SET updated_at = ? WHERE user_did = ? AND id = ?'
    ).bind(now, did, id),
  ]);
  return json({ success: true, added: fresh.length });
}

// DELETE /api/shelf/collections/:id/items {rkeys} — take several saves out at
// once. Idempotent; names that aren't members are ignored.
async function removeItems(request: Request, env: Env, did: string, id: string): Promise<Response> {
  const body = await readJson(request);
  if (!body || !('rkeys' in body)) return badRequest('rkeys is required');
  const rkeys = parseRkeys(body);
  if (!rkeys) return badRequest('rkeys must be an array of up to 2000 valid rkeys');
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM shelf_collection_items
        WHERE user_did = ?1 AND collection_id = ?2
          AND saved_rkey IN (SELECT value FROM json_each(?3))`
    ).bind(did, id, JSON.stringify(rkeys)),
    env.DB.prepare(
      'UPDATE shelf_collections SET updated_at = ? WHERE user_did = ? AND id = ?'
    ).bind(now, did, id),
  ]);
  return json({ success: true });
}

// DELETE /api/shelf/collections/:id/items/:rkey — idempotent.
async function removeItem(env: Env, did: string, id: string, rkey: string): Promise<Response> {
  await env.DB.prepare(
    'DELETE FROM shelf_collection_items WHERE user_did = ? AND collection_id = ? AND saved_rkey = ?'
  )
    .bind(did, id, rkey)
    .run();
  await touchCollection(env, did, id, Math.floor(Date.now() / 1000));
  return json({ success: true });
}

// PUT /api/shelf/collections {ids} — set the collections' order. As with a
// collection's members: positions are 0..n-1 in the order given, collections
// not named keep their order after the named ones, and unknown ids are ignored.
async function reorderCollections(request: Request, env: Env, did: string): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest('Invalid JSON body');
  const ids = body.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_COLLECTIONS ||
    ids.some((id) => typeof id !== 'string' || !isValidRkey(id))
  ) {
    return badRequest('ids must be an array of valid collection ids');
  }
  const current = await env.DB.prepare(
    `SELECT id FROM shelf_collections WHERE user_did = ? ORDER BY position ASC, created_at ASC`
  )
    .bind(did)
    .all<{ id: string }>();
  const existing = (current.results ?? []).map((r) => r.id);
  const existingSet = new Set(existing);
  const named = [...new Set(ids as string[])].filter((id) => existingSet.has(id));
  const namedSet = new Set(named);
  const finalOrder = [...named, ...existing.filter((id) => !namedSet.has(id))];
  // One UPDATE, positions looked up by path, as in reorderItems.
  const positions = JSON.stringify(Object.fromEntries(finalOrder.map((id, i) => [id, i])));
  await env.DB.prepare(
    `UPDATE shelf_collections
        SET position = json_extract(?2, '$."' || id || '"')
      WHERE user_did = ?1 AND json_extract(?2, '$."' || id || '"') IS NOT NULL`
  )
    .bind(did, positions)
    .run();
  return json({ success: true });
}

// PUT /api/shelf/collections/:id/items {rkeys} — set the order. Positions are
// rewritten 0..n-1 in the order given; members not named keep theirs (after the
// named ones), and names that aren't members are ignored, so a reorder racing
// an add or remove on another device can't resurrect or drop anything.
async function reorderItems(
  request: Request,
  env: Env,
  did: string,
  id: string
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest('Invalid JSON body');
  const rkeys = body.rkeys;
  if (
    !Array.isArray(rkeys) ||
    rkeys.length > MAX_ITEMS_PER_COLLECTION ||
    rkeys.some((r) => typeof r !== 'string' || !isValidRkey(r))
  ) {
    return badRequest('rkeys must be an array of valid rkeys');
  }
  if (!(await collectionExists(env, did, id))) return json({ error: 'Not found' }, 404);

  const unique = [...new Set(rkeys as string[])];
  const now = Math.floor(Date.now() / 1000);
  // Compute the final order in JS (named members first, the rest after, in their
  // current order): D1 caps bound parameters at 100 per statement, so a
  // NOT IN (...) over up to 2000 names would fail.
  const current = await env.DB.prepare(
    `SELECT saved_rkey FROM shelf_collection_items
      WHERE user_did = ? AND collection_id = ? ORDER BY position ASC, added_at ASC`
  )
    .bind(did, id)
    .all<{ saved_rkey: string }>();
  const members = (current.results ?? []).map((r) => r.saved_rkey);
  const memberSet = new Set(members);
  const named = unique.filter((r) => memberSet.has(r));
  const namedSet = new Set(named);
  const finalOrder = [...named, ...members.filter((r) => !namedSet.has(r))];
  // One UPDATE for the whole order: D1 counts every statement in a batch against
  // its 1,000 queries per invocation, so a statement per member failed past ~999.
  // Positions ride as a {rkey: index} object looked up by path (rkeys are TIDs,
  // safe in a quoted path), which reads each row once; a json_each join would
  // scan the whole array per row. A member added since the SELECT isn't in the
  // object and keeps its position.
  const positions = JSON.stringify(Object.fromEntries(finalOrder.map((r, i) => [r, i])));
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE shelf_collection_items
          SET position = json_extract(?3, '$."' || saved_rkey || '"')
        WHERE user_did = ?1 AND collection_id = ?2
          AND json_extract(?3, '$."' || saved_rkey || '"') IS NOT NULL`
    ).bind(did, id, positions),
    env.DB.prepare(
      'UPDATE shelf_collections SET updated_at = ? WHERE user_did = ? AND id = ?'
    ).bind(now, did, id),
  ]);
  return json({ success: true });
}

/**
 * Drop a save from every collection. Called when the save itself is deleted, so
 * a collection never carries a member nothing can open.
 */
export async function removeSavedFromCollections(
  env: Env,
  did: string,
  rkeys: string[]
): Promise<void> {
  if (rkeys.length === 0) return;
  await env.DB.prepare(
    `DELETE FROM shelf_collection_items
      WHERE user_did = ? AND saved_rkey IN (${rkeys.map(() => '?').join(', ')})`
  )
    .bind(did, ...rkeys)
    .run();
}

/** Router for everything under /api/shelf/collections. */
export async function handleShelfCollections(
  request: Request,
  env: Env,
  did: string
): Promise<Response> {
  const url = new URL(request.url);
  let parts: string[];
  try {
    parts = url.pathname
      .replace(/^\/api\/shelf\/collections\/?/, '')
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p));
  } catch {
    return badRequest('Invalid path');
  }
  const method = request.method;

  try {
    if (parts.length === 0) {
      if (method === 'GET') return await listCollections(env, did);
      if (method === 'POST') return await createCollection(request, env, did);
      if (method === 'PUT') return await reorderCollections(request, env, did);
      return json({ error: 'Method not allowed' }, 405);
    }

    const id = parts[0];
    if (!isValidRkey(id)) return badRequest('Invalid collection id');

    if (parts.length === 1) {
      if (method === 'PATCH') return await updateCollection(request, env, did, id);
      if (method === 'DELETE') return await deleteCollection(env, did, id);
      return json({ error: 'Method not allowed' }, 405);
    }

    if (parts[1] !== 'items' || parts.length > 3) return json({ error: 'Not found' }, 404);

    if (parts.length === 2) {
      if (method === 'POST') return await addItem(request, env, did, id);
      if (method === 'PUT') return await reorderItems(request, env, did, id);
      if (method === 'DELETE') return await removeItems(request, env, did, id);
      return json({ error: 'Method not allowed' }, 405);
    }

    const rkey = parts[2];
    if (!isValidRkey(rkey)) return badRequest('Invalid rkey');
    if (method === 'DELETE') return await removeItem(env, did, id, rkey);
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('Shelf collections request failed:', error);
    return json({ error: 'Shelf collections request failed' }, 500);
  }
}
