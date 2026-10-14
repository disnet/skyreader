// Bluesky likes and bookmarks as sources (services/bsky-sources.ts).
//
//   GET  /api/v2/bluesky-sources          { likes, bookmarks }: enabled, scopeRequired, …
//   POST /api/v2/bluesky-sources          { kind: 'likes' | 'bookmarks', enabled: boolean }
//
// Turning one on creates the private subscription and runs its first walk
// before answering, so the client's next timeline read finds it populated.
// Turning bookmarks on without the permission answers the standard
// scope_upgrade_required for 'bskyBookmarks'; the client asks for it and the
// sign-in that grants it comes back to turn the source on.

import type { Env, Session } from '../types';
import {
  BSKY_SOURCE_KINDS,
  disableBskySource,
  enableBskySource,
  readBskySourceStatus,
  type BskySourceKind,
} from '../services/bsky-sources';
import { insufficientScopesResponse } from './auth';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleBskySources(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method === 'GET') {
    return json(await readBskySourceStatus(env, session));
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { kind?: unknown; enabled?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!BSKY_SOURCE_KINDS.includes(body.kind as BskySourceKind)) {
    return json({ error: 'kind must be likes or bookmarks' }, 400);
  }
  if (typeof body.enabled !== 'boolean') return json({ error: 'enabled must be a boolean' }, 400);
  const kind = body.kind as BskySourceKind;

  if (!body.enabled) {
    await disableBskySource(env, session, kind);
    return json(await readBskySourceStatus(env, session));
  }

  const result = await enableBskySource(env, session, kind);
  if (result === 'scope_required') return insufficientScopesResponse('bskyBookmarks');
  if (result === 'over_mirror_cap') {
    return json(
      { error: 'subscription_limit_reached', message: 'Your plan has no room for another source.' },
      403
    );
  }
  return json(await readBskySourceStatus(env, session));
}
