import type { Env } from '../types';

/**
 * The notification bell's read-state, kept per account so every device agrees on
 * what has been seen (stores/notifications.svelte.ts on the client).
 *
 *   GET  /api/notifications/seen → { ids: string[], primed: boolean }
 *   POST /api/notifications/seen { ids: string[], primed?: true } → { success: true }
 *
 * `primed` records that the account's first sync ran (mentions older than a week
 * start read once per account, not once per browser). Ids are opaque to the
 * server; only their count and length are checked, and one too long is skipped.
 */

/** Seen ids kept per reader, newest first. The bell only ever shows a few dozen. */
export const MAX_SEEN_PER_USER = 500;
const MAX_IDS_PER_POST = 200;
const MAX_ID_LENGTH = 512;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function handleNotificationSeen(
  request: Request,
  env: Env,
  userDid: string
): Promise<Response> {
  if (request.method === 'GET') {
    const [rows, state] = await env.DB.batch([
      env.DB.prepare(
        'SELECT notification_id FROM notification_seen WHERE user_did = ? ORDER BY seen_at DESC LIMIT ?'
      ).bind(userDid, MAX_SEEN_PER_USER),
      env.DB.prepare('SELECT primed_at FROM notification_state WHERE user_did = ?').bind(userDid),
    ]);
    const ids = (rows.results as Array<{ notification_id: string }>).map((r) => r.notification_id);
    return json({ ids, primed: (state.results?.length ?? 0) > 0 });
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { ids?: unknown; primed?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null) return json({ error: 'Invalid JSON body' }, 400);
  const ids = body.ids ?? [];
  if (!Array.isArray(ids) || ids.length > MAX_IDS_PER_POST) {
    return json({ error: 'Invalid ids' }, 400);
  }
  // An id this won't store is skipped, not a reason to refuse the batch: a
  // mention's URI is someone else's record key, and one too long to keep must
  // not hold back the rest of the reader's read-state on every retry.
  const valid = ids.filter(
    (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH
  );

  const now = Date.now();
  // A re-mark refreshes seen_at, so an old notification that is still showing
  // isn't the first one the cap evicts.
  const statements = [...new Set(valid)].map((id) =>
    env.DB.prepare(
      `INSERT INTO notification_seen (user_did, notification_id, seen_at) VALUES (?, ?, ?)
       ON CONFLICT (user_did, notification_id) DO UPDATE SET seen_at = excluded.seen_at`
    ).bind(userDid, id, now)
  );
  if (body.primed === true) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO notification_state (user_did, primed_at) VALUES (?, ?)
         ON CONFLICT (user_did) DO NOTHING`
      ).bind(userDid, now)
    );
  }
  if (statements.length > 0) {
    // Keep the newest MAX_SEEN_PER_USER. An id evicted here was seen long enough
    // ago that its notification has left every source the bell reads.
    statements.push(
      env.DB.prepare(
        `DELETE FROM notification_seen WHERE user_did = ?1 AND notification_id NOT IN (
           SELECT notification_id FROM notification_seen WHERE user_did = ?1
            ORDER BY seen_at DESC LIMIT ?2)`
      ).bind(userDid, MAX_SEEN_PER_USER)
    );
    await env.DB.batch(statements);
  }
  return json({ success: true });
}
