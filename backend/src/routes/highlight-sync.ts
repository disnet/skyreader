import type { Env } from '../types';
import { collectExport } from '../services/export/collect';
import { touchAppPassword, verifyAppPassword } from '../services/app-passwords';
import { checkRateLimit } from '../services/rate-limit';
import { getUserTier } from '../services/user-tier';
import { getLimitsForTier } from '../config/tier-limits';
import { setContextDid } from '../utils/request-context';
import { GREADER_LOGIN_RATE_LIMIT_KEY } from './greader';

/**
 * GET /api/highlights/sync?since=<cursor>[&collection=<id>…] — the pages whose
 * highlights or notes changed since the last sync, each with all of its
 * highlights, for a notes-app plugin (disnet/skyreader-obsidian) that keeps one note per
 * page up to date. With `collection`, only the saves in those Shelf
 * collections, every one of them, highlighted or not.
 *
 * GET /api/highlights/sync/collections — the reader's Shelf collections, for
 * the plugin's picker: → { collections: [{ id, name }] }
 *
 * The plugin signs in with an app password (`Authorization: Bearer <password>`),
 * the same credential RSS apps use, since it can't do atproto OAuth. Answered
 * before session resolution, like the Google Reader API.
 *
 *   → { cursor, sources: ExportSource[] }
 *
 * `since` is the `cursor` the previous sync returned (absent or 0: everything).
 * A page whose highlights were all deleted comes back with none, so the copy
 * can be emptied. Live sync is a Supporter feature; the one-time download
 * (routes/export.ts) is on every plan.
 */
export const HIGHLIGHT_SYNC_PATH = '/api/highlights/sync';
export const HIGHLIGHT_SYNC_COLLECTIONS_PATH = `${HIGHLIGHT_SYNC_PATH}/collections`;

// More than a reader has; keeps the query's IN list bounded.
const MAX_SYNC_COLLECTIONS = 100;

// The cursor trails the request by this much, so a write stamped just before
// the read but committed just after it comes back next time. The plugin
// rewrites a page only when it changed, so seeing a page twice costs nothing.
export const SYNC_OVERLAP_SECONDS = 60;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get('Authorization') ?? '').trim());
  return match ? match[1].trim() : null;
}

export async function handleHighlightSync(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const token = bearer(request);
  const owner = token ? await verifyAppPassword(env, token) : null;
  if (!owner) {
    // A wrong password spends the same per-IP allowance as a wrong RSS-app
    // sign-in, so this isn't an unthrottled way to guess one.
    if (token) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const limit = await checkRateLimit(env, `ip:${ip}`, GREADER_LOGIN_RATE_LIMIT_KEY);
      if (!limit.allowed) {
        return json({ error: 'Rate limit exceeded' }, 429, {
          'Retry-After': String(limit.retryAfter ?? 60),
        });
      }
    }
    return json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  setContextDid(owner.did);
  ctx.waitUntil(touchAppPassword(env, owner.id));

  const limit = await checkRateLimit(env, owner.did, HIGHLIGHT_SYNC_PATH);
  if (!limit.allowed) {
    return json({ error: 'Rate limit exceeded' }, 429, {
      'Retry-After': String(limit.retryAfter ?? 60),
    });
  }

  if (!getLimitsForTier(await getUserTier(env, owner.did)).liveIntegrations) {
    return json({ error: 'Highlight sync is a Supporter feature', code: 'upgrade_required' }, 403);
  }

  const params = new URL(request.url).searchParams;
  if (new URL(request.url).pathname === HIGHLIGHT_SYNC_COLLECTIONS_PATH) {
    const rows = await env.DB.prepare(
      'SELECT id, name FROM shelf_collections WHERE user_did = ? ORDER BY position ASC, created_at ASC'
    )
      .bind(owner.did)
      .all<{ id: string; name: string }>();
    return json({ collections: rows.results ?? [] });
  }

  const collections = [...new Set(params.getAll('collection').filter(Boolean))];
  if (collections.length > MAX_SYNC_COLLECTIONS) {
    return json({ error: `At most ${MAX_SYNC_COLLECTIONS} collections` }, 400);
  }
  const raw = params.get('since') ?? '0';
  const since = /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(since)) {
    return json({ error: 'since must be the cursor from the last sync' }, 400);
  }

  const cursor = Math.floor(Date.now() / 1000) - SYNC_OVERLAP_SECONDS;
  const doc = await collectExport(env, owner.did, {
    since,
    ...(collections.length > 0 ? { collections } : {}),
  });
  return json({ cursor: Math.max(cursor, 0), sources: doc.sources });
}
