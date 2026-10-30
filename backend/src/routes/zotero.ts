import type { Env, Session } from '../types';
import { getUserTier } from '../services/user-tier';
import { getLimitsForTier } from '../config/tier-limits';
import { sealSecret } from '../utils/secret-box';
import {
  leaseHeld,
  parseCollections,
  runZoteroSync,
  verifyZoteroKey,
  ZoteroError,
  type ZoteroConnection,
} from '../services/zotero';

/**
 * The reader's Zotero connection (services/zotero.ts), from Settings.
 *
 *   GET    /api/zotero       → { connected: false } | { connected: true, username, scope,
 *                               collections, lastSyncAt, lastError, syncing }
 *   POST   /api/zotero       { apiKey } → the connection; checks the key with Zotero, then syncs
 *   PATCH  /api/zotero       { scope, collections } → the connection; starts the sync over
 *   DELETE /api/zotero       → { success: true }; what's in Zotero stays there
 *   POST   /api/zotero/sync  → { started }; a sync now rather than at the next cron
 *
 * The key is never sent back. Connecting and syncing are Supporter features.
 */
export const ZOTERO_PATH = '/api/zotero';

// More than a reader has; keeps the sync's IN list bounded.
const MAX_COLLECTIONS = 100;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function view(conn: ZoteroConnection | null) {
  if (!conn) return { connected: false };
  return {
    connected: true,
    username: conn.zotero_username,
    scope: conn.scope,
    collections: parseCollections(conn.collections),
    lastSyncAt: conn.last_sync_at,
    lastError: conn.last_error,
    syncing: conn.sync_started_at !== null,
  };
}

async function load(env: Env, did: string) {
  return env.DB.prepare('SELECT * FROM zotero_connections WHERE user_did = ?')
    .bind(did)
    .first<ZoteroConnection>();
}

async function readBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export async function handleZotero(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  session: Session
): Promise<Response> {
  const did = session.did;
  const path = new URL(request.url).pathname;

  if (request.method === 'GET' && path === ZOTERO_PATH) return json(view(await load(env, did)));
  if (request.method === 'DELETE' && path === ZOTERO_PATH) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM zotero_items WHERE user_did = ?').bind(did),
      env.DB.prepare('DELETE FROM zotero_connections WHERE user_did = ?').bind(did),
    ]);
    return json({ success: true });
  }

  if (!getLimitsForTier(await getUserTier(env, did)).liveIntegrations) {
    return json({ error: 'Zotero sync is a Supporter feature', code: 'upgrade_required' }, 403);
  }

  if (path === `${ZOTERO_PATH}/sync`) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!(await load(env, did))) return json({ error: 'Connect Zotero first' }, 404);
    ctx.waitUntil(runZoteroSync(env, did));
    return json({ started: true }, 202);
  }
  if (path !== ZOTERO_PATH) return json({ error: 'Not found' }, 404);

  if (request.method === 'POST') {
    if (!env.ZOTERO_KEY_SECRET) {
      return json({ error: "Zotero sync isn't available right now." }, 503);
    }
    const body = await readBody<{ apiKey?: unknown }>(request);
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!/^[A-Za-z0-9]{10,64}$/.test(apiKey)) {
      return json({ error: 'Paste the API key from zotero.org/settings/keys' }, 400);
    }
    let owner;
    try {
      owner = await verifyZoteroKey(apiKey);
    } catch (err) {
      if (err instanceof ZoteroError) return json({ error: err.message }, err.status);
      return json({ error: "Couldn't reach Zotero. Try again in a moment." }, 502);
    }
    // A different library starts the mapping over; the same one keeps it, so
    // a reader who reconnects with a new key gets no duplicates.
    const previous = await load(env, did);
    const sameLibrary = previous?.zotero_user_id === owner.userId;
    // A sync running for the old library would record its items against the new one.
    if (previous && !sameLibrary && leaseHeld(previous)) {
      return json({ error: 'A sync is running. Try again in a minute.' }, 409);
    }
    const sealed = await sealSecret(env.ZOTERO_KEY_SECRET, did, apiKey);
    await env.DB.batch([
      ...(sameLibrary
        ? []
        : [env.DB.prepare('DELETE FROM zotero_items WHERE user_did = ?').bind(did)]),
      env.DB.prepare(
        `INSERT INTO zotero_connections (user_did, api_key_sealed, zotero_user_id, zotero_username)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_did) DO UPDATE SET
           api_key_sealed = excluded.api_key_sealed, zotero_username = excluded.zotero_username,
           zotero_user_id = excluded.zotero_user_id, last_error = NULL,
           generation = zotero_connections.generation + 1,
           zotero_collection_key = CASE WHEN zotero_connections.zotero_user_id = excluded.zotero_user_id
             THEN zotero_connections.zotero_collection_key END,
           cursor = CASE WHEN zotero_connections.zotero_user_id = excluded.zotero_user_id
             THEN zotero_connections.cursor ELSE 0 END`
      ).bind(did, sealed, owner.userId, owner.username),
    ]);
    ctx.waitUntil(runZoteroSync(env, did));
    return json(view(await load(env, did)), 201);
  }

  if (request.method === 'PATCH') {
    if (!(await load(env, did))) return json({ error: 'Connect Zotero first' }, 404);
    const body = await readBody<{ scope?: unknown; collections?: unknown }>(request);
    const scope = body?.scope;
    if (scope !== 'everything' && scope !== 'collections') {
      return json({ error: "scope must be 'everything' or 'collections'" }, 400);
    }
    const collections = Array.isArray(body?.collections)
      ? [...new Set(body.collections.filter((c): c is string => typeof c === 'string' && !!c))]
      : [];
    if (collections.length > MAX_COLLECTIONS) {
      return json({ error: `At most ${MAX_COLLECTIONS} collections` }, 400);
    }
    // A wider scope has pages the cursor already passed: start over. What's
    // already in Zotero is recorded, so nothing is made twice.
    await env.DB.prepare(
      `UPDATE zotero_connections SET scope = ?, collections = ?, cursor = 0,
         generation = generation + 1, last_sync_at = NULL WHERE user_did = ?`
    )
      .bind(scope, JSON.stringify(scope === 'collections' ? collections : []), did)
      .run();
    ctx.waitUntil(runZoteroSync(env, did));
    return json(view(await load(env, did)));
  }

  return json({ error: 'Method not allowed' }, 405);
}
