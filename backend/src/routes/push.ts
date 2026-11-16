import type { Env } from '../types';
import { touchAppPassword, verifyAppPassword } from '../services/app-passwords';
import { checkRateLimit } from '../services/rate-limit';
import { getUserTier } from '../services/user-tier';
import { getLimitsForTier } from '../config/tier-limits';
import {
  MAX_PUSH_BODY_BYTES,
  PushInputError,
  parsePushPost,
  publishToPushFeed,
} from '../services/push-feeds';
import { setContextDid } from '../utils/request-context';
import { GREADER_LOGIN_RATE_LIMIT_KEY } from './greader';

/**
 * POST /api/push — post one item to one of the reader's push feeds
 * (services/push-feeds.ts), from a script or an agent that holds an app
 * password with the `push` scope (`Authorization: Bearer <password>`).
 * Answered before session resolution, like highlight sync.
 *
 *   { feed, title, markdown? | html?, url?, guid?, author?, publishedAt? }
 *   → 201 { status: 'created', feed: { name }, guid, parked }
 *   → 200 { status: 'duplicate', feed: { name }, guid, parked }
 *
 * `feed` names the feed; a new name makes a new one. `guid` makes a retry
 * safe: a guid already in the feed is ignored. `parked` says the reader has
 * the feed parked, so they won't see it until they turn it back on.
 */
export const PUSH_PATH = '/api/push';

// The body cap plus room for the other fields and JSON escaping.
const MAX_REQUEST_BYTES = MAX_PUSH_BODY_BYTES * 2 + 16 * 1024;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get('Authorization') ?? '').trim());
  return match ? match[1].trim() : null;
}

export async function handlePush(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
  }

  const token = bearer(request);
  const owner = token ? await verifyAppPassword(env, token, 'push') : null;
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

  if (!getLimitsForTier(await getUserTier(env, owner.did)).liveIntegrations) {
    return json({ error: 'Push feeds are a Supporter feature', code: 'upgrade_required' }, 403);
  }

  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_REQUEST_BYTES) return json({ error: 'Request too large' }, 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_REQUEST_BYTES) {
    return json({ error: 'Request too large' }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'The body must be JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'The body must be a JSON object' }, 400);
  }

  let outcome;
  try {
    outcome = await publishToPushFeed(
      env,
      owner.did,
      parsePushPost(body as Record<string, unknown>)
    );
  } catch (error) {
    if (error instanceof PushInputError) return json({ error: error.message }, 400);
    throw error;
  }
  if (!outcome.ok) {
    if (outcome.code === 'rate_limited') {
      return json({ error: outcome.message, code: outcome.code }, 429, {
        'Retry-After': String(outcome.retryAfter),
      });
    }
    return json({ error: outcome.message, code: outcome.code }, 409);
  }
  return json(
    {
      status: outcome.status,
      feed: { name: outcome.feed.name },
      guid: outcome.guid,
      parked: outcome.parked,
    },
    outcome.status === 'created' ? 201 : 200
  );
}
