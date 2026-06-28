import type { Env } from '../types';
import { handleCreateSaved } from './saved';
import { handleCreateSubscription } from './subscriptions';
import { handleCreateLinkblogShare } from './linkblog';
import { generateTid } from '../utils/tid';
import { verifyServiceAuth } from '../services/service-auth';
import { findSessionIdForDid, getSessionFromRequest } from '../services/oauth';
import { checkRateLimit } from '../services/rate-limit';
import { FeedProxyClient } from '../services/feed-proxy-client';
import { fillExtractedContent } from '../services/saved-content';

// Bucket key for the unauthenticated service-auth throttle (see rate-limit.ts).
const SERVICE_AUTH_RL_KEY = '/xrpc:service-auth';

// AT Intents service endpoints.
//
// These expose existing Skyreader actions as XRPC procedures (`/xrpc/<nsid>`) so AT
// Intents consumers can route to them per the service wire contract: the matched
// subject and inputs arrive as query-string params, and errors come back in the XRPC
// shape `{ error: <Name>, message: <text> }`. Both verbs here are procedures (POST);
// only `open` would be a GET query.
//
// Auth — two accepted credentials:
//   1. A Skyreader session (a `session_id` cookie or `Authorization: Bearer <session_id>`),
//      same as the rest of the API. For first-party callers that already have a session.
//   2. An atproto inter-service JWT (`Authorization: Bearer <jwt>`), the AT Intents path:
//      any consumer holding the user's session mints one via the user's PDS, scoped to
//      this XRPC method. We verify it (services/service-auth.ts) to get the user's DID,
//      then map that DID to a stored Skyreader session to act — because the actual work
//      (D1 writes, and especially the linkblog PDS write) needs Skyreader's own tokens,
//      which a bare identity proof doesn't provide. So service auth works only for users
//      who have signed in to Skyreader and granted the needed scopes.
//
// Implementation: rather than duplicate the validation/dedup/tier logic, each wrapper
// resolves the credential to a session, builds a synthetic JSON-body POST request bearing
// that session, delegates to the existing `/api/*` handler, then reshapes the result for
// XRPC.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function xrpcError(error: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error, message }), { status, headers: JSON_HEADERS });
}

// XRPC error names don't have a fixed registry; we derive a stable name from the HTTP
// status of the delegated handler's response.
function errorNameForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'InvalidRequest';
    case 401:
      return 'AuthenticationRequired';
    case 403:
      return 'Forbidden';
    case 405:
      return 'MethodNotImplemented';
    case 429:
      return 'RateLimitExceeded';
    default:
      return status >= 500 ? 'InternalServerError' : 'RequestFailed';
  }
}

// Pass successful responses through untouched; remap the internal `{ error, message? }`
// error shape onto the XRPC `{ error: <Name>, message }` shape keyed off the status.
async function toXrpcResponse(res: Response): Promise<Response> {
  if (res.ok) return res;

  let payload: { error?: string; message?: string } = {};
  try {
    payload = (await res.clone().json()) as { error?: string; message?: string };
  } catch {
    // Non-JSON body — fall back to the status-derived name as the message.
  }
  const name = errorNameForStatus(res.status);
  const message = payload.message || payload.error || name;
  return xrpcError(name, message, res.status);
}

// Resolve the request's credential into the session to act as.
//   - returns { sessionId: null } to pass the original auth headers through unchanged
//     (first-party cookie / Bearer session_id path),
//   - returns { sessionId } when an atproto service-auth JWT verified and mapped to a
//     stored Skyreader session (delegate as that session),
//   - returns { error } as a ready XRPC error response otherwise.
// Detection: a service-auth JWT is a Bearer token with three dot-separated segments; a
// Skyreader session_id has none, so it falls through to passthrough.
async function resolveDelegationAuth(
  request: Request,
  env: Env,
  lxm: string
): Promise<{ sessionId: string | null } | { error: Response }> {
  const authz = request.headers.get('Authorization') || '';
  const token = authz.startsWith('Bearer ') ? authz.slice('Bearer '.length) : '';
  if (token.split('.').length !== 3) {
    return { sessionId: null }; // not a JWT — first-party session passthrough
  }

  // Throttle the JWT path by client IP BEFORE verifying: verification triggers an
  // outbound DID-resolution fetch, and this path has no session to key the normal
  // per-user rate limiter on. Fails open on DB error (see checkRateLimit).
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = await checkRateLimit(env, `ip:${clientIp}`, SERVICE_AUTH_RL_KEY);
  if (!rl.allowed) {
    return {
      error: xrpcError(
        'RateLimitExceeded',
        'Too many service-auth requests. Slow down and retry shortly.',
        429
      ),
    };
  }

  const verified = await verifyServiceAuth(token, { lxm });
  if (!verified.ok) {
    return { error: xrpcError(verified.error, verified.message, 401) };
  }

  const sessionId = await findSessionIdForDid(env, verified.did);
  if (!sessionId) {
    return {
      error: xrpcError(
        'AuthenticationRequired',
        `No active Skyreader session for ${verified.did}. The user must sign in to Skyreader (granting the needed permissions) before this action can be performed on their behalf.`,
        401
      ),
    };
  }
  return { sessionId };
}

// Build a synthetic JSON-body POST request bearing the resolved session, or return a
// ready XRPC error if auth failed. For the service-auth path we swap in the resolved
// session id as a Bearer token (and drop any Cookie) so the delegated handler resolves
// exactly that session; for passthrough we keep the original auth headers as-is.
async function buildDelegatedRequest(
  request: Request,
  env: Env,
  lxm: string,
  body: unknown
): Promise<{ req: Request } | { error: Response }> {
  const auth = await resolveDelegationAuth(request, env, lxm);
  if ('error' in auth) return { error: auth.error };

  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  if (auth.sessionId) {
    headers.set('Authorization', `Bearer ${auth.sessionId}`);
    headers.delete('Cookie');
  }
  return {
    req: new Request(request.url, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

// POST /xrpc/app.skyreader.feed.save — save a web article to the reading list.
// subject = the article URL; optional input `title`.
export async function handleXrpcSave(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return xrpcError('MethodNotImplemented', 'Use POST for this procedure.', 405);
  }

  const params = new URL(request.url).searchParams;
  const subject = params.get('subject');
  if (!subject) {
    return xrpcError('InvalidRequest', 'Missing required param: subject (the article URL).', 400);
  }

  const rkey = generateTid();
  const body = {
    url: subject,
    rkey,
    source: 'url',
    title: params.get('title') ?? undefined,
  };

  const built = await buildDelegatedRequest(request, env, 'app.skyreader.feed.save', body);
  if ('error' in built) return built.error;

  const res = await handleCreateSaved(built.req, env, ctx);

  // The save itself stores only url + title; the first-party flow extracts the article
  // body (feed-proxy + Defuddle) before saving, but that fetch is slow, so for the
  // AT-intent path we save immediately and fill the body in the background rather than
  // blocking the caller. Keyed by (did, rkey): the rkey we generated, the did from the
  // acting session (the response uri can be a foreign collection item on the backed
  // path, so it isn't a reliable did source). Only on a successful save.
  if (res.ok) {
    const session = await getSessionFromRequest(built.req, env);
    if (session) {
      ctx.waitUntil(extractAndStoreSavedContent(env, session.did, rkey, subject));
    }
  }

  return toXrpcResponse(res);
}

// Background fill for an XRPC URL save (see handleXrpcSave): extract the article body and
// write it onto the saved row. Runs under ctx.waitUntil so the caller isn't blocked on
// the extraction. The UPDATE itself (content-IS-NULL guard, COALESCE metadata) lives in
// fillExtractedContent — here we leave content_type alone so a URL save stays 'webpage'.
// Best-effort — an un-extractable URL just keeps its title and an empty body.
async function extractAndStoreSavedContent(
  env: Env,
  userDid: string,
  rkey: string,
  url: string
): Promise<void> {
  try {
    const a = await new FeedProxyClient(env).extract(url);
    await fillExtractedContent(env, a, { userDid, rkey });
  } catch (err) {
    console.error('xrpc save: background extraction failed', err);
  }
}

// POST /xrpc/app.skyreader.feed.subscribe — subscribe to an RSS/Atom feed by URL.
// subject = the feed URL; optional input `category`.
export async function handleXrpcSubscribe(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return xrpcError('MethodNotImplemented', 'Use POST for this procedure.', 405);
  }

  const params = new URL(request.url).searchParams;
  const subject = params.get('subject');
  if (!subject) {
    return xrpcError('InvalidRequest', 'Missing required param: subject (the feed URL).', 400);
  }

  const body = {
    rkey: generateTid(),
    feedUrl: subject,
    category: params.get('category') ?? undefined,
  };

  const built = await buildDelegatedRequest(request, env, 'app.skyreader.feed.subscribe', body);
  if ('error' in built) return built.error;
  return toXrpcResponse(await handleCreateSubscription(built.req, env, ctx));
}

// POST /xrpc/app.skyreader.linkblog.share — share a link to the user's linkblog.
// subject = the article URL; optional inputs `title`, `note`, repeatable `tags`.
// Delivered as a service (not pds) because the underlying write is app logic: it lazily
// creates the user's site.standard.publication, builds the leaflet-block document body,
// and links the document to that publication — none of which a generic consumer could
// construct from a raw PDS write.
export async function handleXrpcLinkblogShare(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return xrpcError('MethodNotImplemented', 'Use POST for this procedure.', 405);
  }

  const params = new URL(request.url).searchParams;
  const subject = params.get('subject');
  if (!subject) {
    return xrpcError('InvalidRequest', 'Missing required param: subject (the article URL).', 400);
  }

  const tags = params.getAll('tags');
  const body = {
    rkey: generateTid(),
    articleUrl: subject,
    articleTitle: params.get('title') ?? undefined,
    note: params.get('note') ?? undefined,
    tags: tags.length ? tags : undefined,
  };

  const built = await buildDelegatedRequest(request, env, 'app.skyreader.linkblog.share', body);
  if ('error' in built) return built.error;
  return toXrpcResponse(await handleCreateLinkblogShare(built.req, env));
}
