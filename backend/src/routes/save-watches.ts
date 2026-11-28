import type { Env } from '../types';
import { isValidRkey } from '../utils/validation';
import { getUserTierLimits } from '../services/user-tier';
import {
  listSaveWatches,
  markWatchesSeen,
  unwatchSaves,
  watchSaves,
} from '../services/save-watches';

/**
 * Watch for updates on saves (services/save-watches.ts, docs/plans/SAVE_WATCHES.md).
 *
 *   GET  /api/saved/watches       → { items: SaveWatch[], limit }
 *   POST /api/saved/watches       { rkeys, watch: boolean }
 *                                 → { watched: string[], refused: [{ rkey, reason }], limit }
 *   POST /api/saved/watches/seen  { rkeys } | { all: true } → { success: true }
 *
 * `reason` is `not_found`, `no_url` (an upload has no page to watch) or
 * `limit` (the plan's maxWatchedSaves).
 */

const MAX_RKEYS = 200;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readRkeys(
  request: Request
): Promise<{ rkeys: string[] | null; body: Record<string, unknown> } | null> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  if (body.rkeys === undefined) return { rkeys: null, body };
  if (
    !Array.isArray(body.rkeys) ||
    body.rkeys.length > MAX_RKEYS ||
    !body.rkeys.every((r) => typeof r === 'string' && isValidRkey(r))
  ) {
    return null;
  }
  return { rkeys: body.rkeys as string[], body };
}

export async function handleSaveWatches(
  request: Request,
  env: Env,
  userDid: string
): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === '/api/saved/watches') {
    if (request.method === 'GET') {
      const [items, limits] = await Promise.all([
        listSaveWatches(env, userDid),
        getUserTierLimits(env, userDid),
      ]);
      return json({ items, limit: limits.maxWatchedSaves });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const parsed = await readRkeys(request);
    if (!parsed || !parsed.rkeys || typeof parsed.body.watch !== 'boolean') {
      return json({ error: 'Expected { rkeys, watch }' }, 400);
    }
    const limits = await getUserTierLimits(env, userDid);
    if (!parsed.body.watch) {
      await unwatchSaves(env, userDid, parsed.rkeys);
      return json({ watched: [], refused: [], limit: limits.maxWatchedSaves });
    }
    const result = await watchSaves(env, userDid, parsed.rkeys, limits);
    return json({ ...result, limit: limits.maxWatchedSaves });
  }

  if (path === '/api/saved/watches/seen') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const parsed = await readRkeys(request);
    if (!parsed) return json({ error: 'Invalid JSON body' }, 400);
    if (parsed.rkeys === null && parsed.body.all !== true) {
      return json({ error: 'Expected { rkeys } or { all: true }' }, 400);
    }
    await markWatchesSeen(env, userDid, parsed.rkeys);
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}
