import type { Env } from '../types';
import { isValidRkey } from '../utils/validation';
import {
  backfillSavedUrlKeys,
  listSavedConnectionActivity,
  markSavedConnectionsSeen,
} from '../services/semble-connections';

/**
 * Semble connections other people drew off the reader's saves
 * (services/semble-connections.ts, docs/plans/SEMBLE_CONNECTIONS.md).
 *
 *   GET  /api/saved/connections       — per-save activity: { items: [{ rkey, unseen, latestAt, seenAt }] }
 *   POST /api/saved/connections/seen  — { rkey }: the reader looked at that save's connections
 *
 * Small and whole: only saves with a connection appear, so the client fetches
 * the list rather than paging a delta.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function handleSavedConnections(
  request: Request,
  env: Env,
  userDid: string
): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === '/api/saved/connections') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    // Older saves get their url_key here, a batch per call, the first times the
    // reader opens their Library; until then no connection can match them.
    await backfillSavedUrlKeys(env, userDid);
    const items = await listSavedConnectionActivity(env, userDid);
    return json({ items });
  }

  if (path === '/api/saved/connections/seen') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body: { rkey?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const rkey = typeof body?.rkey === 'string' ? body.rkey : '';
    if (!isValidRkey(rkey)) return json({ error: 'Invalid rkey' }, 400);
    const marked = await markSavedConnectionsSeen(env, userDid, rkey);
    return json({ success: marked });
  }

  return json({ error: 'Not found' }, 404);
}
