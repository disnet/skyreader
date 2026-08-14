import type { Env } from './types';
import {
  handleAuthLogin,
  handleAuthCallback,
  handleAuthLogout,
  handleAuthMe,
  handleClientMetadata,
} from './routes/auth';
import {
  handleV2FeedFetch,
  handleV2BatchFeedFetch,
  handleV2FeedDiscover,
  handleV2BatchDocumentFetch,
  handleV2GetDocument,
  handleV2SocialContext,
  handleV2Mentions,
  handleV2MentionLane,
} from './routes/feeds-v2';
import { handleDetectContent } from './routes/social';
import {
  handleCreateLinkblogShare,
  handleDeleteLinkblogShare,
  handleUpdateLinkblogShare,
  handleGetPublication,
  handleUpdatePublication,
  handleDiscover,
  handleDiscoverFriends,
  handleListPublications,
  handleConnectPublication,
  handleResolvePublication,
  handleSetPageVisibility,
  handleDeletePublication,
  handleRestorePublication,
} from './routes/linkblog';
import { handleAtmosphereSubscription } from './routes/atmosphere';
import {
  handleCreateSubscription,
  handleListSubscriptions,
  handleDeleteSubscription,
  handleUpdateSubscription,
  handleBulkCreateSubscriptions,
  handleBulkDeleteSubscriptions,
  handleBulkUpdateSubscriptions,
  handleListParkedSubscriptions,
  handleSetSubscriptionActive,
} from './routes/subscriptions';
import { handleRecordsList } from './routes/records';
import {
  handleGetReadPositions,
  handleMarkAsRead,
  handleMarkAsUnread,
  handleBulkMarkAsRead,
} from './routes/reading';
import { handleLexicon, handleLexiconIndex } from './routes/lexicons';
import {
  handleGetLabels,
  handleAddLabel,
  handleDeleteLabel,
  handleBulkAddLabels,
} from './routes/labels';
import { handleXrpcSave, handleXrpcSubscribe, handleXrpcLinkblogShare } from './routes/xrpc';
import {
  handleCreateSaved,
  handleGetSaved,
  handleSavedStatus,
  handleGetSavedBodies,
  handleUpdateSaved,
  handleDeleteSaved,
  handleDeleteSavedByGuid,
  handleSetBacking,
} from './routes/saved';
import { handleExtract } from './routes/extract';
import { handleGetSettings, handleUpdateSettings } from './routes/settings';
import {
  handleGetMagazines,
  handleUpsertMagazine,
  handleUpdateMagazinePosition,
  handleDeleteMagazine,
} from './routes/magazines';
import {
  handleIntegrationStatus,
  handleCreateSembleCard,
  handleListSembleCollections,
  handleCreateMarginBookmark,
  handleListMarginCollections,
  handleCreateMarginNote,
  handleUpdateMarginNote,
  handleDeleteMarginNote,
} from './routes/integrations';
import { handleFullSync, handleSyncSubscriptions, handleSyncStatus } from './routes/sync';
import {
  handleGetChannels,
  handleSyncChannels,
  handleUpsertChannel,
  handleDeleteChannel,
} from './routes/channels';
import { handleTestExec } from './routes/test-utils';
import { handleHealth, handleDeepHealth } from './routes/health';
import { handleTelemetryError } from './routes/telemetry';
import { resolveSessionFromRequest, updateUserActivity } from './services/oauth';
import { checkRateLimit, cleanupRateLimits, getRateLimitConfig } from './services/rate-limit';
import * as Sentry from '@sentry/cloudflare';
import { sentryOptions, reportError, tagRequestId } from './observability/sentry';
import { pingHeartbeat } from './observability/heartbeat';
import {
  recordPollerStatus,
  recordProxyStats,
  recordCronRun,
  writeMetricsSnapshot,
  runRecordingStep,
} from './observability/ops-metrics';
import { log, serializeError } from './utils/logger';
import { classifyRoute, runWithRequestContext, setContextDid } from './utils/request-context';

export { JetstreamPoller } from './durable-objects/jetstream-poller';

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [env.FRONTEND_URL];

  const isAllowed =
    origin && allowedOrigins.some((allowed) => allowed === origin || allowed === '*');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    // So a browser client can read the correlation id off a failed response and
    // quote it in a bug report.
    'Access-Control-Expose-Headers': 'X-Request-Id',
  };
}

function unauthorizedResponse(headers: HeadersInit): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// A live session whose token couldn't be refreshed right this instant (in backoff,
// raced by a concurrent refresh, or the refresh poll timed out). This is NOT a logout:
// the client should back off and retry. Returned as 503 so it can never be confused
// with the 401 that means "you are genuinely logged out".
function sessionRetryResponse(headers: HeadersInit): Response {
  return new Response(JSON.stringify({ error: 'session_refresh_pending', retryable: true }), {
    status: 503,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Retry-After': '2',
    },
  });
}

// Routes that are reachable WITHOUT a session. A transient refresh hiccup must not
// block these (especially logout, which has to clear a half-dead session's cookie).
function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith('/.well-known/') ||
    pathname === '/api/auth/login' ||
    pathname === '/api/auth/callback' ||
    pathname === '/api/auth/logout' ||
    pathname === '/api/telemetry/error'
  );
}

// The other set of session-free routes. Health endpoints are answered *before*
// session resolution rather than via isPublicPath: an uptime poller has no
// session, and the shallow check must stay free of D1 work (see routes/health.ts).
function isHealthPath(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/health/deep';
}

// The routed request. Wrapped by `fetch` below, which owns the request context,
// the summary log line, and the X-Request-Id echo.
async function serveRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const headers = corsHeaders(origin, env);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  // The try opens here rather than after session resolution: a D1 blip inside
  // `resolveSessionFromRequest` or the rate-limit check used to escape the whole
  // handler, which meant no summary line, no `request_error`, no CORS headers and
  // no X-Request-Id on the runtime's bare 500 — the one class of failure you most
  // want correlated.
  try {
    return await route(request, env, ctx, url, headers);
  } catch (error) {
    // Workers Logs stays the quick-look tool; Sentry is what groups, dedupes,
    // and notifies. Both, deliberately — and both carry the request id, which
    // is what lets a Sentry event find its log line.
    log.error('request_error', { method: request.method, ...serializeError(error) });
    reportError(error, {
      tags: { source: 'fetch', route: classifyRoute(url.pathname) },
      extra: { method: request.method, path: url.pathname },
    });
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  headers: HeadersInit
): Promise<Response> {
  if (isHealthPath(url.pathname)) {
    const health =
      url.pathname === '/api/health' ? handleHealth(env) : await handleDeepHealth(request, env);
    const healthHeaders = new Headers(health.headers);
    Object.entries(headers).forEach(([key, value]) => healthHeaders.set(key, value as string));
    return new Response(health.body, { status: health.status, headers: healthHeaders });
  }

  // Track user activity for authenticated requests (non-blocking)
  const sessionResult = await resolveSessionFromRequest(request, env);
  const session = sessionResult.session;
  if (session) {
    // Correlation key for every subsequent log line and Sentry event on this
    // request. A DID is a public identifier — see observability/scrub.ts.
    setContextDid(session.did);
    ctx.waitUntil(updateUserActivity(env, session.did));

    // Check rate limit for authenticated requests
    const rateLimit = await checkRateLimit(env, session.did, url.pathname);
    if (!rateLimit.allowed) {
      const config = getRateLimitConfig(url.pathname);
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Retry-After': String(rateLimit.retryAfter || 60),
          'X-RateLimit-Limit': String(config.limit),
          'X-RateLimit-Remaining': '0',
        },
      });
    }
  } else if (sessionResult.reason === 'transient' && !isPublicPath(url.pathname)) {
    // The user still has a valid session, we just couldn't refresh its token in
    // time (e.g. concurrent request burst right after a deploy). Tell the client to
    // retry instead of returning the 401 that would tear down its auth.
    return sessionRetryResponse(headers);
  }

  let response: Response;

  // Route matching
  switch (true) {
    // Test-only D1 exec endpoint (e2e seed/cleanup). Mounted only when
    // E2E_TEST_MODE is set, so it's unreachable in production.
    case url.pathname === '/api/test/exec' && env.E2E_TEST_MODE === 'true':
      response = await handleTestExec(request, env);
      break;

    // OAuth client metadata
    case url.pathname === '/.well-known/client-metadata':
      response = await handleClientMetadata(request, env);
      break;

    // Lexicon schemas
    case url.pathname === '/.well-known/lexicons':
      response = handleLexiconIndex();
      break;
    case url.pathname.startsWith('/.well-known/lexicons/'):
      response = handleLexicon(request);
      break;

    // Auth routes
    case url.pathname === '/api/auth/login':
      response = await handleAuthLogin(request, env);
      break;
    case url.pathname === '/api/auth/callback':
      response = await handleAuthCallback(request, env, ctx);
      break;
    case url.pathname === '/api/auth/logout':
      response = await handleAuthLogout(request, env);
      break;
    case url.pathname === '/api/auth/me':
      response = await handleAuthMe(request, env);
      break;

    // Client error reports. Deliberately session-free: an error on the login
    // screen, or one thrown before auth resolves, is exactly the kind worth
    // having. The handler rate-limits by DID when there is one, by IP when
    // there isn't.
    case url.pathname === '/api/telemetry/error':
      response = await handleTelemetryError(request, env, session?.did);
      break;

    // Feed routes (v2 via Fly.io proxy)
    case url.pathname === '/api/v2/feeds/fetch':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2FeedFetch(request, env);
      break;
    case url.pathname === '/api/v2/feeds/batch':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2BatchFeedFetch(request, env, session);
      break;
    case url.pathname === '/api/v2/feeds/discover':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2FeedDiscover(request, env);
      break;
    case url.pathname === '/api/v2/documents/batch':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2BatchDocumentFetch(request, env, session);
      break;
    case url.pathname === '/api/v2/documents/get':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2GetDocument(request, env, session);
      break;
    case url.pathname === '/api/v2/social-context':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2SocialContext(request, env);
      break;
    case url.pathname === '/api/v2/mentions':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2Mentions(request, env);
      break;
    case url.pathname === '/api/v2/mention-lane':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2MentionLane(request, env);
      break;

    // Social routes
    case url.pathname === '/api/social/detect-content':
      if (!session) return unauthorizedResponse(headers);
      response = await handleDetectContent(request, env);
      break;
    // Linkblog discovery — find friends with linkblogs / browse all (Phase 6)
    case url.pathname === '/api/linkblog/discover/friends':
      if (!session) return unauthorizedResponse(headers);
      response = await handleDiscoverFriends(request, env);
      break;
    case url.pathname === '/api/linkblog/discover':
      if (!session) return unauthorizedResponse(headers);
      response = await handleDiscover(request, env);
      break;

    // Linkblog endpoints — sharing as portable site.standard.document records
    case url.pathname === '/api/linkblog/share':
      if (!session) return unauthorizedResponse(headers);
      response = await handleCreateLinkblogShare(request, env);
      break;
    case url.pathname.startsWith('/api/linkblog/share/'):
      if (!session) return unauthorizedResponse(headers);
      response =
        request.method === 'PATCH'
          ? await handleUpdateLinkblogShare(request, env)
          : await handleDeleteLinkblogShare(request, env);
      break;
    case url.pathname === '/api/linkblog/publication':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'GET') {
        response = await handleGetPublication(request, env);
      } else if (request.method === 'DELETE') {
        response = await handleDeletePublication(request, env);
      } else if (request.method === 'POST') {
        response = await handleRestorePublication(request, env);
      } else {
        response = await handleUpdatePublication(request, env);
      }
      break;
    case url.pathname === '/api/linkblog/publications':
      if (!session) return unauthorizedResponse(headers);
      response = await handleListPublications(request, env);
      break;
    case url.pathname === '/api/linkblog/publication/connect':
      if (!session) return unauthorizedResponse(headers);
      response = await handleConnectPublication(request, env);
      break;
    case url.pathname === '/api/linkblog/publication/visibility':
      if (!session) return unauthorizedResponse(headers);
      response = await handleSetPageVisibility(request, env);
      break;
    case url.pathname.startsWith('/api/linkblog/resolve/'):
      response = await handleResolvePublication(request, env);
      break;

    // Subscribe via the Atmosphere — writes the portable
    // site.standard.graph.subscription record, and (for a signed-in user)
    // also creates the matching local reader subscription.
    case url.pathname === '/api/atmosphere/subscription':
      if (!session) return unauthorizedResponse(headers);
      response = await handleAtmosphereSubscription(request, env, ctx);
      break;

    // Subscriptions endpoints (new)
    case url.pathname === '/api/subscriptions':
      if (!session) return unauthorizedResponse(headers);
      response =
        request.method === 'GET'
          ? await handleListSubscriptions(request, env)
          : await handleCreateSubscription(request, env, ctx);
      break;
    case url.pathname === '/api/subscriptions/bulk':
      if (!session) return unauthorizedResponse(headers);
      response = await handleBulkCreateSubscriptions(request, env, ctx);
      break;
    case url.pathname === '/api/subscriptions/bulk-update':
      if (!session) return unauthorizedResponse(headers);
      response = await handleBulkUpdateSubscriptions(request, env, ctx);
      break;
    case url.pathname === '/api/subscriptions/bulk-delete':
      if (!session) return unauthorizedResponse(headers);
      response = await handleBulkDeleteSubscriptions(request, env, ctx);
      break;
    case url.pathname === '/api/subscriptions/parked':
      if (!session) return unauthorizedResponse(headers);
      response = await handleListParkedSubscriptions(request, env);
      break;
    case url.pathname.endsWith('/activate') && url.pathname.startsWith('/api/subscriptions/'):
      if (!session) return unauthorizedResponse(headers);
      response = await handleSetSubscriptionActive(request, env, true);
      break;
    case url.pathname.endsWith('/park') && url.pathname.startsWith('/api/subscriptions/'):
      if (!session) return unauthorizedResponse(headers);
      response = await handleSetSubscriptionActive(request, env, false);
      break;
    case url.pathname.startsWith('/api/subscriptions/'):
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'DELETE') {
        response = await handleDeleteSubscription(request, env, ctx);
      } else if (request.method === 'PATCH') {
        response = await handleUpdateSubscription(request, env, ctx);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;

    // Record list route (sync routes removed - use dedicated endpoints)
    case url.pathname === '/api/records/list':
      response = await handleRecordsList(request, env);
      break;

    // Reading routes (read positions)
    case url.pathname === '/api/reading/positions':
      response = await handleGetReadPositions(request, env);
      break;
    case url.pathname === '/api/reading/mark-read':
      response = await handleMarkAsRead(request, env);
      break;
    case url.pathname === '/api/reading/mark-unread':
      response = await handleMarkAsUnread(request, env);
      break;
    case url.pathname === '/api/reading/mark-read-bulk':
      response = await handleBulkMarkAsRead(request, env);
      break;

    // Labels routes (unified item labels)
    case url.pathname === '/api/labels':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'GET') {
        response = await handleGetLabels(request, env);
      } else if (request.method === 'POST') {
        response = await handleAddLabel(request, env);
      } else if (request.method === 'DELETE') {
        response = await handleDeleteLabel(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;
    case url.pathname === '/api/labels/bulk':
      if (!session) return unauthorizedResponse(headers);
      response = await handleBulkAddLabels(request, env);
      break;

    // Article extraction route (fetch + Defuddle via the feed proxy)
    case url.pathname === '/api/extract':
      if (!session) return unauthorizedResponse(headers);
      response = await handleExtract(request, env);
      break;

    // Saved routes
    case url.pathname === '/api/saved':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'GET') {
        response = await handleGetSaved(request, env, ctx);
      } else if (request.method === 'POST') {
        response = await handleCreateSaved(request, env, ctx);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;
    case url.pathname === '/api/saved/status':
      if (!session) return unauthorizedResponse(headers);
      response = await handleSavedStatus(request, env);
      break;
    case url.pathname.startsWith('/api/saved/by-guid/'):
      if (!session) return unauthorizedResponse(headers);
      response = await handleDeleteSavedByGuid(request, env, ctx);
      break;
    case url.pathname === '/api/saved/backing':
      if (!session) return unauthorizedResponse(headers);
      response = await handleSetBacking(request, env);
      break;
    case url.pathname === '/api/saved/bodies':
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetSavedBodies(request, env);
      break;
    case url.pathname.startsWith('/api/saved/'):
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'PATCH') {
        response = await handleUpdateSaved(request, env);
      } else {
        response = await handleDeleteSaved(request, env, ctx);
      }
      break;

    // Settings routes
    case url.pathname === '/api/settings':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'PUT') {
        response = await handleUpdateSettings(request, env);
      } else {
        response = await handleGetSettings(request, env);
      }
      break;

    // Magazine routes (durable, cross-device reading issues)
    case url.pathname === '/api/magazines':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'GET') {
        response = await handleGetMagazines(request, env);
      } else if (request.method === 'POST') {
        response = await handleUpsertMagazine(request, env);
      } else if (request.method === 'DELETE') {
        response = await handleDeleteMagazine(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;
    case url.pathname === '/api/magazines/position':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'PATCH') {
        response = await handleUpdateMagazinePosition(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;

    // Integration routes
    case url.pathname === '/api/integrations/status':
      if (!session) return unauthorizedResponse(headers);
      response = await handleIntegrationStatus(request, env);
      break;
    case url.pathname === '/api/integrations/semble/cards':
      if (!session) return unauthorizedResponse(headers);
      if (request.method !== 'POST') {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        response = await handleCreateSembleCard(request, env);
      }
      break;
    case url.pathname === '/api/integrations/semble/collections':
      if (!session) return unauthorizedResponse(headers);
      response = await handleListSembleCollections(request, env);
      break;
    case url.pathname === '/api/integrations/margin/bookmarks':
      if (!session) return unauthorizedResponse(headers);
      if (request.method !== 'POST') {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        response = await handleCreateMarginBookmark(request, env);
      }
      break;
    case url.pathname === '/api/integrations/margin/collections':
      if (!session) return unauthorizedResponse(headers);
      response = await handleListMarginCollections(request, env);
      break;
    case url.pathname === '/api/integrations/margin/notes':
      if (!session) return unauthorizedResponse(headers);
      if (request.method !== 'POST') {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        response = await handleCreateMarginNote(request, env);
      }
      break;
    case url.pathname.startsWith('/api/integrations/margin/notes/'):
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'DELETE') {
        response = await handleDeleteMarginNote(request, env);
      } else if (request.method === 'PUT') {
        response = await handleUpdateMarginNote(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;

    // Channels routes
    case url.pathname === '/api/channels':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'GET') {
        response = await handleGetChannels(request, env);
      } else if (request.method === 'PUT') {
        response = await handleSyncChannels(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;
    case url.pathname.startsWith('/api/channels/'): {
      if (!session) return unauthorizedResponse(headers);
      const channelUuid = url.pathname.split('/').pop()!;
      if (request.method === 'PUT') {
        response = await handleUpsertChannel(request, env, channelUuid);
      } else if (request.method === 'DELETE') {
        response = await handleDeleteChannel(request, env, channelUuid);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;
    }

    // Sync routes
    case url.pathname === '/api/sync/full':
      if (!session) return unauthorizedResponse(headers);
      response = await handleFullSync(request, env, ctx);
      break;
    case url.pathname === '/api/sync/subscriptions':
      if (!session) return unauthorizedResponse(headers);
      response = await handleSyncSubscriptions(request, env);
      break;
    case url.pathname === '/api/sync/status':
      if (!session) return unauthorizedResponse(headers);
      response = await handleSyncStatus(request, env);
      break;

    // AT Intents service endpoints (XRPC procedures). No top-level session guard:
    // the handlers return XRPC-shaped `{ error, message }` auth errors themselves.
    case url.pathname === '/xrpc/app.skyreader.feed.save':
      response = await handleXrpcSave(request, env, ctx);
      break;
    case url.pathname === '/xrpc/app.skyreader.feed.subscribe':
      response = await handleXrpcSubscribe(request, env, ctx);
      break;
    case url.pathname === '/xrpc/app.skyreader.linkblog.share':
      response = await handleXrpcLinkblogShare(request, env);
      break;

    default:
      response = new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  // Add CORS headers to response
  const newHeaders = new Headers(response.headers);
  Object.entries(headers).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const started = Date.now();

    // Minted here, never accepted from the client: a caller that sent a constant
    // id would silently merge unrelated requests in the logs. The response header
    // is how a client (or a bug report) learns the id it should quote.
    return runWithRequestContext(
      { requestId, route: classifyRoute(url.pathname), method: request.method },
      async () => {
        tagRequestId(requestId);

        // One summary line per request — route class, status, duration. This is
        // the raw material for "what's slow" and "what's erroring" until metrics
        // land, and it's why the log is worth querying at all.
        //
        // In a `finally` so that "every request produces a line" survives a throw
        // that somehow gets past serveRequest's catch: the line then reports the
        // 500 the runtime is about to serve.
        //
        // The shallow health check is exempt: an uptime poller hits it every 30s
        // forever and the line carries no information the check's own history
        // doesn't already have.
        let status = 500;
        try {
          const response = await serveRequest(request, env, ctx);
          status = response.status;

          const headers = new Headers(response.headers);
          headers.set('X-Request-Id', requestId);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } finally {
          if (url.pathname !== '/api/health') {
            log.info('request', {
              method: request.method,
              status,
              durationMs: Date.now() - started,
            });
          }
        }
      }
    );
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // A cron run gets a correlation id too: every line it emits — and every
    // Sentry event from a failing phase — carries the same `requestId`, so one
    // filter shows the whole run.
    return runWithRequestContext(
      { requestId: crypto.randomUUID(), route: `cron ${controller.cron}` },
      () => runScheduled(controller, env, ctx)
    );
  },
} satisfies ExportedHandler<Env>;

async function runScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const cronStart = Date.now();
  const minute = new Date().getMinutes();
  const isEveryMinuteCron = controller.cron === '* * * * *';

  log.info('cron_start', { cron: controller.cron, minute });

  // Tracks whether this run did its job. The heartbeat at the end only fires on
  // a clean run, so "cron throwing every minute" looks the same to the monitor
  // as "cron never fired" — both are outages.
  let cronHealthy = true;

  // Every minute: Cleanup tasks and ensure JetstreamPoller is running
  if (isEveryMinuteCron) {
    // Phase 1: Ensure JetstreamPoller DO is running
    try {
      const pollerId = env.JETSTREAM_POLLER.idFromName('main-v2');
      const poller = env.JETSTREAM_POLLER.get(pollerId);
      const response = await poller.fetch('http://internal/start');
      const result = (await response.json()) as { status: string };
      log.info('cron_poller_ping', { pollerStatus: result.status });
    } catch (error) {
      log.error('cron_phase_failed', { phase: 'poller-start', ...serializeError(error) });
      reportError(error, { tags: { source: 'cron', phase: 'poller-start' } });
      cronHealthy = false;
    }

    // Phase 1b: Record what the poller knows. The /start ping above only asks
    // "are you alive"; /status carries the firehose lag, the last cycle's error
    // counts and the alarm state — all of which were being discarded. Storing it
    // is what lets the admin show poller health, and what makes the lag threshold
    // alert possible at all.
    await runRecordingStep('poller-status', () => recordPollerStatus(env));

    // Every 5th minute: the proxy's cache stats. Its own cadence because it's a
    // cross-cloud fetch and the cron has a 60s ceiling to respect.
    if (minute % 5 === 0) {
      await runRecordingStep('proxy-stats', () => recordProxyStats(env));
    }

    // Phase 2: Clean up rate limit records
    let rateLimitDuration = 0;
    let rateLimitDeleted = 0;
    try {
      const result = await cleanupRateLimits(env);
      rateLimitDeleted = result.deleted;
      rateLimitDuration = result.duration;
      if (rateLimitDeleted > 0) {
        log.info('cron_rate_limit_cleanup', {
          deleted: rateLimitDeleted,
          durationMs: rateLimitDuration,
        });
      }
    } catch (error) {
      log.error('cron_phase_failed', { phase: 'rate-limit-cleanup', ...serializeError(error) });
      reportError(error, { tags: { source: 'cron', phase: 'rate-limit-cleanup' } });
      cronHealthy = false;
    }

    // Phase 3: Clean up expired D1 data (once per hour)
    let d1CleanupDuration = 0;
    if (minute === 0) {
      log.info('cron_d1_cleanup_start');
      const cleanupStart = Date.now();
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

      let oauthDeleted = 0;
      let sessionsDeleted = 0;
      let labelTombstonesDeleted = 0;

      // Clean up expired OAuth states
      try {
        const oauthResult = await env.DB.prepare('DELETE FROM oauth_state WHERE expires_at < ?')
          .bind(now)
          .run();
        oauthDeleted = oauthResult.meta?.changes || 0;
      } catch (error) {
        log.error('cron_phase_failed', { phase: 'oauth-state-cleanup', ...serializeError(error) });
        reportError(error, { tags: { source: 'cron', phase: 'oauth-state-cleanup' } });
      }

      // Clean up failed/expired sessions
      try {
        const sessionsResult = await env.DB.prepare(
          `
              DELETE FROM sessions
              WHERE (
                refresh_failures >= 5
                AND (refresh_locked_until IS NULL OR refresh_locked_until < ?)
              )
              OR expires_at < ?
            `
        )
          .bind(now, thirtyDaysAgo)
          .run();
        sessionsDeleted = sessionsResult.meta?.changes || 0;
      } catch (error) {
        log.error('cron_phase_failed', { phase: 'session-cleanup', ...serializeError(error) });
        reportError(error, { tags: { source: 'cron', phase: 'session-cleanup' } });
      }

      // Purge old label tombstones (soft-deleted archived/tagged AND read
      // rows — un-read is now a soft-delete that rides the forward read delta).
      // The retention must outlast any realistic delta-cursor staleness so a
      // client offline for a while still replays the deletion; 90 days. The
      // sweep is label- and type-agnostic, so read tombstones are covered with
      // no change. deleted_at is unix seconds.
      try {
        const tombstoneCutoff = Math.floor(now / 1000) - 90 * 24 * 60 * 60;
        const tombstoneResult = await env.DB.prepare(
          'DELETE FROM item_labels_cache WHERE deleted_at IS NOT NULL AND deleted_at < ?'
        )
          .bind(tombstoneCutoff)
          .run();
        labelTombstonesDeleted = tombstoneResult.meta?.changes || 0;
      } catch (error) {
        log.error('cron_phase_failed', {
          phase: 'label-tombstone-purge',
          ...serializeError(error),
        });
        reportError(error, { tags: { source: 'cron', phase: 'label-tombstone-purge' } });
      }

      // Purge old magazine tombstones (same 90-day retention as labels so a
      // long-offline client still replays the deletion via its `?since=` delta).
      try {
        const magazineCutoff = Math.floor(now / 1000) - 90 * 24 * 60 * 60;
        await env.DB.prepare(
          'DELETE FROM magazines WHERE deleted_at IS NOT NULL AND deleted_at < ?'
        )
          .bind(magazineCutoff)
          .run();
      } catch (error) {
        log.error('cron_phase_failed', {
          phase: 'magazine-tombstone-purge',
          ...serializeError(error),
        });
        reportError(error, { tags: { source: 'cron', phase: 'magazine-tombstone-purge' } });
      }

      d1CleanupDuration = Date.now() - cleanupStart;
      log.info('cron_d1_cleanup', {
        oauthStatesDeleted: oauthDeleted,
        sessionsDeleted,
        labelTombstonesDeleted,
        durationMs: d1CleanupDuration,
      });

      // Hourly trend point. Runs after the proxy-stats refresh above (minute 0 is
      // a multiple of 5), so the snapshot reads fresh values rather than
      // five-minute-old ones. Prunes its own tail at 90 days.
      await runRecordingStep('metrics-snapshot', () => writeMetricsSnapshot(env));
    }

    // The run summary. `durationMs` is the number to watch as the cron takes on
    // more work (see the cron-budget risk in the observability plan): it has a
    // hard 60s ceiling before runs start overlapping.
    const cronDuration = Date.now() - cronStart;
    log.info('cron_run', {
      cron: controller.cron,
      healthy: cronHealthy,
      durationMs: cronDuration,
      d1CleanupDurationMs: d1CleanupDuration,
      rateLimitDeleted,
    });

    // The same fact the heartbeat pushes to the monitor, kept locally: the admin
    // shows "last run 40s ago" from this row, which works in staging and local dev
    // where no monitor is configured at all.
    await runRecordingStep('cron-last-run', () =>
      recordCronRun(env, {
        cron: controller.cron,
        healthy: cronHealthy,
        durationMs: cronDuration,
      })
    );

    // Dead-man's switch. Fire-and-forget so a slow monitor can never extend or
    // fail the cron. Skipped on a failed run so the monitor's grace period
    // expires and pages — that's the whole point of the switch.
    if (cronHealthy) {
      ctx.waitUntil(pingHeartbeat(env.HEARTBEAT_URL, 'cron'));
    } else {
      log.warn('cron_heartbeat_skipped', { reason: 'run had failures' });
    }
  }
}

// Wrapping the exported handler instruments both `fetch` and `scheduled`; the
// JetstreamPoller DO is instrumented separately at its own export.
export default Sentry.withSentry(sentryOptions, handler);
