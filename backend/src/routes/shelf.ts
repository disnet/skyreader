import type { Env, Session } from '../types';
import { isValidRkey } from '../utils/validation';
import { parseAtUri } from '../utils/canonical-url';
import { createPDSClient } from '../services/pds-client';
import {
  createCollection as createForeignCollection,
  listCollectionNames,
} from '../services/backing/write';
import { backfillUrlNormalized, uniqueCollectionName } from '../services/backing/enable';
import { extractMissingBackedContent } from '../services/backing/sync';
import {
  collectionNsidFor,
  markShelfLinkDirty,
  reconcileShelfLink,
  unlinkShelfCollection,
  type ReconcileResult,
} from '../services/shelf-link';
import { checkIntegrationScopes } from './integrations';
import { getUserSettings } from './settings';

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
  link_provider: string | null;
  link_uri: string | null;
  link_synced_at: number | null;
  pinned: number;
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
// A linked collection's other side comes in through POST …/sync, which the
// client calls on opening it: reconciling here too would race that call.
async function listCollections(env: Env, did: string): Promise<Response> {
  const [collections, items] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, name, description, position, created_at, updated_at,
              link_provider, link_uri, link_synced_at, pinned
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

  const rows = (collections.results ?? []) as unknown as CollectionRow[];

  return json({
    collections: rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      position: c.position,
      pinned: c.pinned === 1,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      link: linkView(c),
      items: byCollection.get(c.id) ?? [],
    })),
  });
}

function linkView(
  c: Pick<CollectionRow, 'link_provider' | 'link_uri' | 'link_synced_at'>
): { provider: string; uri: string; syncedAt: number | null } | null {
  if (!c.link_uri || !c.link_provider) return null;
  return { provider: c.link_provider, uri: c.link_uri, syncedAt: c.link_synced_at };
}

/**
 * Reconcile these collections behind the response, one after another and at
 * most two, since they share this request's subrequest cap. The rest are marked
 * dirty already, so their next sync runs past the gate.
 */
function scheduleReconcile(env: Env, session: Session, ctx: ExecutionContext, ids: string[]): void {
  if (ids.length === 0) return;
  ctx.waitUntil(
    (async () => {
      for (const id of ids.slice(0, 2)) {
        await reconcileShelfLink(env, session, id).catch((err) => {
          console.error('[shelf-link] background reconcile failed:', err);
        });
      }
    })()
  );
}

/** A local change to these collections: owe their links a reconcile, and start it. */
export async function linkedChanged(
  env: Env,
  session: Session,
  ctx: ExecutionContext,
  ids: string[]
): Promise<void> {
  const linked = await markShelfLinkDirty(env, session.did, ids);
  scheduleReconcile(env, session, ctx, linked);
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

// PATCH /api/shelf/collections/:id — rename, describe, move, or pin.
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
  if ('pinned' in body) {
    if (typeof body.pinned !== 'boolean') return badRequest('pinned must be a boolean');
    sets.push('pinned = ?');
    params.push(body.pinned ? 1 : 0);
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
// saves themselves are untouched, and so is a linked Semble/Margin collection:
// it's the reader's own. Idempotent: deleting a missing one succeeds.
async function deleteCollection(env: Env, did: string, id: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shelf_link_members WHERE user_did = ? AND collection_id = ?').bind(
      did,
      id
    ),
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
async function addItem(
  request: Request,
  env: Env,
  session: Session,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const did = session.did;
  const body = await readJson(request);
  if (!body) return badRequest('Invalid JSON body');
  const rkeys = parseRkeys(body);
  if (!rkeys) {
    return badRequest('rkey must be a valid rkey, or rkeys an array of up to 2000 of them');
  }

  if (!(await collectionExists(env, did, id))) return json({ error: 'Not found' }, 404);

  const current = await env.DB.prepare(
    `SELECT saved_rkey FROM shelf_collection_items WHERE user_did = ? AND collection_id = ?`
  )
    .bind(did, id)
    .all<{ saved_rkey: string }>();
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

  const now = Math.floor(Date.now() / 1000);
  // One INSERT for the lot: D1 caps bound parameters at 100 per statement and
  // statements at 1,000 per invocation, so the rkeys ride as one JSON array and
  // json_each's index gives each its position. The cap and the next position
  // are read inside the statement too, so two bulk adds racing can't both pass
  // the check above and overfill the collection or share positions; the loser
  // inserts nothing. (`WHERE` also keeps SQLite from reading ON CONFLICT as part
  // of the SELECT's join.)
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
       SELECT ?1, ?2, j.value,
              (SELECT COALESCE(MAX(position), -1) + 1 FROM shelf_collection_items
                WHERE user_did = ?1 AND collection_id = ?2) + j.key,
              ?3
         FROM json_each(?4) AS j
        WHERE (SELECT COUNT(*) FROM shelf_collection_items
                WHERE user_did = ?1 AND collection_id = ?2)
            + (SELECT COUNT(*) FROM json_each(?4) WHERE value NOT IN (
                 SELECT saved_rkey FROM shelf_collection_items
                  WHERE user_did = ?1 AND collection_id = ?2)) <= ?5
       ON CONFLICT(user_did, collection_id, saved_rkey) DO NOTHING`
    ).bind(did, id, now, JSON.stringify(fresh), MAX_ITEMS_PER_COLLECTION),
    env.DB.prepare(
      'UPDATE shelf_collections SET updated_at = ? WHERE user_did = ? AND id = ?'
    ).bind(now, did, id),
  ]);
  if ((inserted.meta.changes ?? 0) === 0) {
    // Nothing went in: either a concurrent add got there first with the same
    // saves (fine), or it filled the room these needed.
    const after = await env.DB.prepare(
      `SELECT saved_rkey FROM shelf_collection_items WHERE user_did = ? AND collection_id = ?`
    )
      .bind(did, id)
      .all<{ saved_rkey: string }>();
    const present = new Set((after.results ?? []).map((r) => r.saved_rkey));
    const room = Math.max(0, MAX_ITEMS_PER_COLLECTION - present.size);
    if (fresh.filter((r) => !present.has(r)).length > room) {
      return json(
        { error: `A collection can hold at most ${MAX_ITEMS_PER_COLLECTION} items`, room },
        409
      );
    }
  }
  if (inserted.meta.changes) await linkedChanged(env, session, ctx, [id]);
  return json({ success: true, added: inserted.meta.changes ?? 0 });
}

// DELETE /api/shelf/collections/:id/items {rkeys} — take several saves out at
// once. Idempotent; names that aren't members are ignored.
async function removeItems(
  request: Request,
  env: Env,
  session: Session,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const did = session.did;
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
  await linkedChanged(env, session, ctx, [id]);
  return json({ success: true });
}

// DELETE /api/shelf/collections/:id/items/:rkey — idempotent.
async function removeItem(
  env: Env,
  session: Session,
  ctx: ExecutionContext,
  id: string,
  rkey: string
): Promise<Response> {
  const did = session.did;
  const removed = await env.DB.prepare(
    'DELETE FROM shelf_collection_items WHERE user_did = ? AND collection_id = ? AND saved_rkey = ?'
  )
    .bind(did, id, rkey)
    .run();
  await touchCollection(env, did, id, Math.floor(Date.now() / 1000));
  if (removed.meta.changes) await linkedChanged(env, session, ctx, [id]);
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
 * a collection never carries a member nothing can open. With `link`, a linked
 * collection that held it is reconciled, which takes it out over there too.
 */
export async function removeSavedFromCollections(
  env: Env,
  did: string,
  rkeys: string[],
  link?: { session: Session; ctx: ExecutionContext }
): Promise<void> {
  if (rkeys.length === 0) return;
  // As one JSON list, not a bound parameter each (a statement takes at most 100).
  const list = JSON.stringify(rkeys);
  const held = link
    ? await env.DB.prepare(
        `SELECT DISTINCT i.collection_id FROM shelf_collection_items i
           JOIN shelf_collections c ON c.user_did = i.user_did AND c.id = i.collection_id
          WHERE i.user_did = ? AND c.link_uri IS NOT NULL
            AND i.saved_rkey IN (SELECT value FROM json_each(?))`
      )
        .bind(did, list)
        .all<{ collection_id: string }>()
    : null;
  await env.DB.prepare(
    `DELETE FROM shelf_collection_items
      WHERE user_did = ? AND saved_rkey IN (SELECT value FROM json_each(?))`
  )
    .bind(did, list)
    .run();
  if (link && held && held.results.length > 0) {
    await linkedChanged(
      env,
      link.session,
      link.ctx,
      held.results.map((r) => r.collection_id)
    );
  }
}

function syncView(result: ReconcileResult) {
  if (!result.synced) return { synced: false, reason: result.reason };
  return {
    synced: true,
    imported: result.imported.length,
    removed: result.removed,
    pushed: result.pushed,
    deleted: result.deleted,
    pending: result.pending,
    complete: result.complete,
    resolved: result.resolved,
  };
}

/** Fill in the bodies of saves a reconcile brought in, behind the response. */
function extractImported(env: Env, did: string, ctx: ExecutionContext, result: ReconcileResult) {
  if (!result.synced || result.imported.length === 0) return;
  ctx.waitUntil(
    extractMissingBackedContent(env, did, { limit: 20 }).catch((err) => {
      console.error('[shelf-link] extracting imported saves failed:', err);
    })
  );
}

// PUT /api/shelf/collections/:id/link {provider, collectionUri?} — keep this
// collection in step with one of the reader's own Semble or Margin collections,
// or with a new one named after it when `collectionUri` is left out. Linking
// brings the foreign members in and starts writing this collection's linkable
// members over there. The first reconcile runs before the response, unless
// `deferSync`: then the link is only saved (and owed a sync), and the client runs
// that sync itself, so a large collection doesn't hold the dialog open.
async function linkCollection(
  request: Request,
  env: Env,
  session: Session,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const did = session.did;
  const body = await readJson(request);
  if (!body) return badRequest('Invalid JSON body');
  const provider = body.provider;
  if (provider !== 'semble' && provider !== 'margin') {
    return badRequest("provider must be 'semble' or 'margin'");
  }
  const denied = checkIntegrationScopes(session, provider);
  if (denied) return denied;
  const collection = await env.DB.prepare(
    'SELECT name, description, link_provider, link_uri FROM shelf_collections WHERE user_did = ? AND id = ?'
  )
    .bind(did, id)
    .first<{
      name: string;
      description: string | null;
      link_provider: string | null;
      link_uri: string | null;
    }>();
  if (!collection) return json({ error: 'Not found' }, 404);

  let uri: string;
  if (
    body.collectionUri === undefined &&
    collection.link_uri &&
    collection.link_provider === provider
  ) {
    // Already linked: a retried request keeps that collection rather than
    // making (and switching to) another.
    uri = collection.link_uri;
  } else if (body.collectionUri !== undefined) {
    if (typeof body.collectionUri !== 'string') return badRequest('collectionUri must be a string');
    const ref = parseAtUri(body.collectionUri);
    // Only the reader's own: the other side's additions become their saves.
    if (!ref || ref.did !== did || ref.collection !== collectionNsidFor(provider) || !ref.rkey) {
      return badRequest(`collectionUri must be one of your own ${provider} collections`);
    }
    uri = `at://${ref.did}/${ref.collection}/${ref.rkey}`;
  } else {
    const pds = createPDSClient(session);
    const existing = await listCollectionNames(pds, provider);
    const created = await createForeignCollection(
      pds,
      provider,
      uniqueCollectionName(collection.name, existing),
      { description: collection.description ?? undefined }
    );
    uri = created.uri;
  }

  if (collection.link_uri !== uri) {
    const settings = await getUserSettings(env, did);
    if (settings.backing.provider !== 'skyreader' && settings.backing.collectionUri === uri) {
      return json({ error: 'That collection already backs your whole Library' }, 409);
    }
    const taken = await env.DB.prepare(
      'SELECT id FROM shelf_collections WHERE user_did = ? AND link_uri = ? AND id != ?'
    )
      .bind(did, uri, id)
      .first();
    if (taken) return json({ error: 'Another Shelf collection is linked to that one' }, 409);

    // Key legacy saves first, so one already here isn't brought in a second time.
    await backfillUrlNormalized(env, did);
    await env.DB.batch([
      env.DB.prepare(
        'DELETE FROM shelf_link_members WHERE user_did = ? AND collection_id = ?'
      ).bind(did, id),
      env.DB.prepare(
        `UPDATE shelf_collections
            SET link_provider = ?, link_uri = ?, link_synced_at = NULL, link_dirty = 1,
                link_lock_until = NULL
          WHERE user_did = ? AND id = ?`
      ).bind(provider, uri, did, id),
    ]);
  }

  if (body.deferSync === true) {
    // A retried link keeps its link_synced_at (so say so); make sure the sync
    // it's owed still runs past the gate.
    const row = await env.DB.prepare(
      `UPDATE shelf_collections SET link_dirty = 1 WHERE user_did = ? AND id = ? AND link_uri = ?
        RETURNING link_synced_at`
    )
      .bind(did, id, uri)
      .first<{ link_synced_at: number | null }>();
    return json({
      success: true,
      link: { provider, uri, syncedAt: row?.link_synced_at ?? null },
      sync: null,
    });
  }

  const result = await reconcileShelfLink(env, session, id, { force: true });
  extractImported(env, did, ctx, result);
  return json({
    success: true,
    link: { provider, uri, syncedAt: result.synced ? Date.now() : null },
    sync: syncView(result),
  });
}

// DELETE /api/shelf/collections/:id/link — stop keeping it in step. Both sides
// keep what they hold; nothing in the reader's repo is touched.
async function unlinkCollection(env: Env, did: string, id: string): Promise<Response> {
  await unlinkShelfCollection(env, did, id);
  return json({ success: true });
}

// POST /api/shelf/collections/:id/sync {force?} — reconcile now (inside the gate
// only with `force`). The client calls it on opening a linked collection, and
// again while `pending` says members are still waiting to be written.
async function syncCollection(
  request: Request,
  env: Env,
  session: Session,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const body = (await readJson(request)) ?? {};
  if (!(await collectionExists(env, session.did, id))) return json({ error: 'Not found' }, 404);
  const result = await reconcileShelfLink(env, session, id, { force: body.force === true });
  if (!result.synced && result.reason === 'not-linked') {
    return json({ error: 'This collection isn’t linked' }, 409);
  }
  extractImported(env, session.did, ctx, result);
  return json(syncView(result));
}

/** Router for everything under /api/shelf/collections. */
export async function handleShelfCollections(
  request: Request,
  env: Env,
  session: Session,
  ctx: ExecutionContext
): Promise<Response> {
  const did = session.did;
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

    if (parts.length === 2 && parts[1] === 'link') {
      if (method === 'PUT') return await linkCollection(request, env, session, ctx, id);
      if (method === 'DELETE') return await unlinkCollection(env, did, id);
      return json({ error: 'Method not allowed' }, 405);
    }
    if (parts.length === 2 && parts[1] === 'sync') {
      if (method === 'POST') return await syncCollection(request, env, session, ctx, id);
      return json({ error: 'Method not allowed' }, 405);
    }

    if (parts[1] !== 'items' || parts.length > 3) return json({ error: 'Not found' }, 404);

    if (parts.length === 2) {
      if (method === 'POST') return await addItem(request, env, session, ctx, id);
      if (method === 'PUT') return await reorderItems(request, env, did, id);
      if (method === 'DELETE') return await removeItems(request, env, session, ctx, id);
      return json({ error: 'Method not allowed' }, 405);
    }

    const rkey = parts[2];
    if (!isValidRkey(rkey)) return badRequest('Invalid rkey');
    if (method === 'DELETE') return await removeItem(env, session, ctx, id, rkey);
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('Shelf collections request failed:', error);
    return json({ error: 'Shelf collections request failed' }, 500);
  }
}
