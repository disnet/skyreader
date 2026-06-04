// "Subscribe via the Atmosphere" — the public linkblog subscribe button. It
// always writes the portable site.standard.graph.subscription record to the
// user's PDS (this is NOT gated behind Atmospheric sync). For a signed-in
// Skyreader user it ALSO creates the matching local reader subscription so the
// linkblog lands in their reader — see ensureLocalDocumentSubscription. The
// portable record is the source of truth; the local mirror is best-effort.
//
// One path, method-dispatched:
//   GET    /api/atmosphere/subscription?publication=<at-uri>  → { subscribed }
//   POST   /api/atmosphere/subscription { publication }       → { subscribed: true, uri }
//   DELETE /api/atmosphere/subscription { publication }       → { subscribed: false }

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { ATMOSPHERE_SCOPES } from '../config/scopes';
import {
  isPublicationUri,
  getAtmosphereSubscription,
  writeAtmosphereSubscription,
  deleteAtmosphereSubscription,
} from '../services/atmosphere-subscription';
import { ensureLocalDocumentSubscription, removeLocalDocumentSubscription } from './subscriptions';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// The PDS may reject the write if the session's granted scopes are stale; treat
// that as the authoritative signal to re-auth (mirrors the linkblog routes).
function isScopeError(error: string): boolean {
  return /scope/i.test(error);
}

export async function handleAtmosphereSubscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  let publication = url.searchParams.get('publication') || undefined;
  if (request.method === 'POST' || request.method === 'DELETE') {
    try {
      const body = (await request.json()) as { publication?: string };
      if (body && typeof body.publication === 'string') publication = body.publication;
    } catch {
      // No/invalid body — fall back to the query param above.
    }
  }

  if (!isPublicationUri(publication)) {
    return json({ error: 'publication must be an at:// site.standard.publication URI' }, 400);
  }

  if (request.method === 'GET') {
    const subscribed = await getAtmosphereSubscription(session, publication);
    return json({ subscribed });
  }

  if (request.method === 'POST') {
    if (!hasRequiredScopes(session.grantedScopes, ATMOSPHERE_SCOPES)) {
      return insufficientScopesResponse();
    }
    const result = await writeAtmosphereSubscription(session, publication);
    if (!result.success) {
      if (isScopeError(result.error)) return insufficientScopesResponse();
      return json({ error: result.error }, result.retryable ? 503 : 502);
    }
    // Also land the linkblog in the subscriber's reader (and let the
    // "Open in Skyreader" deep link resolve). Best-effort — the portable
    // subscribe above is the source of truth and has already succeeded.
    try {
      await ensureLocalDocumentSubscription(env, session, ctx, publication);
    } catch (err) {
      console.error('[Atmosphere] Failed to create local reader subscription:', err);
    }
    return json({ subscribed: true, uri: result.data.uri });
  }

  if (request.method === 'DELETE') {
    if (!hasRequiredScopes(session.grantedScopes, ATMOSPHERE_SCOPES)) {
      return insufficientScopesResponse();
    }
    const result = await deleteAtmosphereSubscription(session, publication);
    if (!result.success) {
      if (isScopeError(result.error)) return insufficientScopesResponse();
      return json({ error: result.error }, result.retryable ? 503 : 502);
    }
    // Keep subscribe/unsubscribe symmetric: drop the mirrored reader subscription.
    try {
      await removeLocalDocumentSubscription(env, session, publication);
    } catch (err) {
      console.error('[Atmosphere] Failed to remove local reader subscription:', err);
    }
    return json({ subscribed: false });
  }

  return json({ error: 'Method not allowed' }, 405);
}
