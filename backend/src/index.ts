import type { Env } from './types';
import {
  handleAuthLogin,
  handleAuthCallback,
  handleAuthLogout,
  handleAuthMe,
  handleAuthUpgrade,
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
  handleV2MarginHighlights,
} from './routes/feeds-v2';
import { handleDiscoverSites } from './routes/site-feeds';
import { handleIngest, handleCrawlSet, handleFeedHealth } from './routes/ingest';
import { handleSignatureDirectory } from './routes/web-bot-auth';
import { handleDocumentBackfill, handleDocumentShadowCompare } from './routes/documents';
import {
  createDocumentApplyContext,
  createQueryLedger,
  reconcileStaleAuthors,
  CRON_DOCUMENT_QUERY_BUDGET,
  CRON_HOURLY_RECONCILE_AUTHORS,
  CRON_MINUTE_RECONCILE_AUTHORS,
} from './services/document-store';
import { readDocumentFlags } from './services/document-flags';
import { handleTimeline } from './routes/timeline';
import { handleItemBody } from './routes/item-bodies';
import {
  handleGuestItemBody,
  handleGuestMarginHighlights,
  handleGuestMentionLane,
  handleGuestMentions,
  handleGuestStarterFeeds,
  handleGuestTimeline,
} from './routes/guest';
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
  handleSetLinkblogFormatting,
  handleDeletePublication,
  handleRestorePublication,
  handleLinkblogDocuments,
} from './routes/linkblog';
import {
  handleGetShareDrafts,
  handleUpsertShareDraft,
  handleDeleteShareDraft,
} from './routes/share-drafts';
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
  handleMarkFeedRead,
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
  handleGetSavedUpdates,
  handleUpdateSaved,
  handleDeleteSaved,
  handleDeleteSavedByGuid,
  handleDeleteSavedMany,
  handleSetBacking,
  handleGetSavedSnapshots,
  handleGetSnapshotImage,
} from './routes/saved';
import { handleShelfCollections } from './routes/shelf';
import { handleSavedConnections } from './routes/saved-connections';
import { handleNotificationSeen } from './routes/notifications';
import { handleAppPasswords } from './routes/app-passwords';
import { greaderSubpath, handleGReader } from './routes/greader';
import { handleUpdates } from './routes/updates';
import { handleExport } from './routes/export';
import {
  handleGetSavedAsset,
  handleGetSavedFile,
  handleUploadEpub,
  handleUploadPdf,
} from './routes/saved-pdf';
import { handleImportSaved } from './routes/saved-import';
import { handleExtract } from './routes/extract';
import {
  handleCreateRoom,
  handleGetRoom,
  handleRoomAddItem,
  handleRoomJoin,
  handleRoomRead,
} from './routes/rooms';
import { handleRecommends } from './routes/recommends';
import {
  handleFollowLinkSharers,
  handleGetAllFollowLinks,
  handleFollowLinksSettings,
  handleFollowLinksProbe,
  handleGetFollowLinks,
} from './routes/follow-links';
import { handleBskySources } from './routes/bsky-sources';
import { refreshBskySourcesIfDue } from './services/bsky-sources';
import { purgeFollowLinks } from './services/follow-links-store';
import { handleGetSettings, handleUpdateSettings } from './routes/settings';
import {
  handleGetNewsletters,
  handleIssueNewsletterAddress,
  handleUnblockNewsletterSender,
} from './routes/newsletters';
import { handleSearch } from './routes/search';
import { handleChannelItems, handleChannelPreview } from './routes/channel-items';
import { nudgePercolator } from './services/saved-search';
import { dispatchBackgroundFollowLinks } from './services/follow-links-background';
import { nudgeSearchIndex, searchNudgeFor } from './services/search-index';
import { handleInboundEmail } from './services/newsletters';
import {
  handleCreateBillingPortal,
  handleCreateCheckout,
  handleGetBillingSubscription,
  handleListBillingProducts,
  handlePolarWebhook,
} from './routes/billing';
import {
  handleCreateFeedback,
  handleGetFeedback,
  handleGetFeedbackThread,
  handleGetMyFeedback,
  handleUploadFeedbackImage,
} from './routes/feedback';
import { handleCreateBlueskyPost, handleUploadBlueskyImage } from './routes/bluesky';
import {
  handleGetMagazines,
  handleUpsertMagazine,
  handleUpdateMagazinePosition,
  handleDeleteMagazine,
} from './routes/magazines';
import {
  handleIntegrationStatus,
  handleCreateSembleCard,
  handleListSembleCards,
  handleCreateSembleConnection,
  handleListSembleCollections,
  handleCreateMarginBookmark,
  handleListMarginCollections,
  handleListMarginHighlights,
  handleCreateMarginNote,
  handleUpdateMarginNote,
  handleDeleteMarginNote,
  handleGetIntegrationMemberships,
  handleEditIntegrationMemberships,
} from './routes/integrations';
import { handleFullSync, handleSyncSubscriptions, handleSyncStatus } from './routes/sync';
import {
  handleGetChannels,
  handleSyncChannels,
  handleUpsertChannel,
  handleReorderChannels,
  handleDeleteChannel,
} from './routes/channels';
import { handleTestExec } from './routes/test-utils';
import { handleHealth, handleDeepHealth } from './routes/health';
import { handleTelemetryError, TELEMETRY_PATH } from './routes/telemetry';
import { handleVitals, pruneVitals, VITALS_PATH } from './routes/vitals';
import { resolveSessionFromRequest, updateUserActivity } from './services/oauth';
import {
  checkRateLimit,
  cleanupRateLimits,
  getRateLimitConfig,
  passesRequestGate,
  REQUEST_GATE_PERIOD_SECONDS,
} from './services/rate-limit';
import { sweepStagedOriginals } from './services/linked-originals';
import * as Sentry from '@sentry/cloudflare';
import { sentryOptions, reportError, tagRequestId } from './observability/sentry';
import { pingHeartbeat } from './observability/heartbeat';
import {
  recordPollerStatus,
  recordProxyStats,
  recordCronRun,
  writeMetricsSnapshot,
  runRecordingStep,
  POLLER_PING_TIMEOUT_MS,
} from './observability/ops-metrics';
import { log, serializeError } from './utils/logger';
import { runJobs, type Job } from './services/jobs';
import { withTimeout } from './utils/with-timeout';
import { d1Summary } from './utils/d1-timing';
import { isCrossSiteWrite } from './utils/cross-site';
import { cleanupFrameSignIns, handleFrameSignInClaim } from './routes/frame-sign-in';
import { classifyRoute, runWithRequestContext, setContextDid } from './utils/request-context';

export { JetstreamPoller } from './durable-objects/jetstream-poller';
export { SearchIndex } from './durable-objects/search-index';
export { Percolator } from './durable-objects/percolator';
export { FollowLinksPoller } from './durable-objects/follow-links-poller';

function allowedOriginsFor(env: Env): string[] {
  return env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [env.FRONTEND_URL];
}

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowedOrigins = allowedOriginsFor(env);

  const isAllowed =
    origin && allowedOrigins.some((allowed) => allowed === origin || allowed === '*');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    // Let browsers cache preflights instead of paying one per API call.
    // (Chrome caps this at 2h, Firefox at 24h.)
    'Access-Control-Max-Age': '86400',
    // So a browser client can read the correlation id off a failed response and
    // quote it in a bug report, and wait out a 429 for as long as it says.
    'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After',
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
    pathname === '/api/auth/frame-claim' ||
    pathname.startsWith('/api/guest/')
  );
}

// The other set of session-free routes. Health endpoints are answered *before*
// session resolution rather than via isPublicPath: an uptime poller has no
// session, and the shallow check must stay free of D1 work (see routes/health.ts).
function isHealthPath(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/health/deep';
}

// Every response leaving route() carries the CORS headers computed for the
// request's Origin, including the ones answered before the switch.
function withCors(response: Response, headers: HeadersInit): Response {
  const merged = new Headers(response.headers);
  Object.entries(headers).forEach(([key, value]) => merged.set(key, value as string));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
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

  // Writes riding a session cookie from another site are forgeries (utils/cross-site.ts).
  if (isCrossSiteWrite(request, allowedOriginsFor(env))) {
    return new Response(JSON.stringify({ error: 'Cross-site request refused' }), {
      status: 403,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
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

  // Client error reports, answered before session resolution — deliberately, and
  // for a stronger reason than "no session required": the reports worth having
  // most are the ones sent while auth is broken. Behind `resolveSessionFromRequest`
  // a D1 read failure would become the 500 from serveRequest's catch, and a session
  // mid-refresh would wait out the concurrent-refresh poll, before the report was
  // ever parsed — and the reporter never retries (frontend/src/lib/services/telemetry.ts).
  // The cost is that an authenticated report is rate-limited by IP rather than by
  // DID; the handler owns that limit, so this also stops paying for two.
  if (url.pathname === TELEMETRY_PATH) {
    return withCors(await handleTelemetryError(request, env), headers);
  }
  // Field vitals: same reasoning — sessionless by design, and nothing about the
  // reader is wanted (see routes/vitals.ts).
  if (url.pathname === VITALS_PATH) {
    return withCors(await handleVitals(request, env), headers);
  }

  // Polar billing webhooks: server-to-server, gated by a standard-webhooks HMAC
  // signature rather than a session. Answered before session resolution for the
  // same reason as telemetry — no cookie is ever present, and a D1 blip in the
  // session path must not turn a signed delivery into a 500 Polar will retry.
  // Skipping per-DID rate limiting is correct here: the signature is the gate.
  if (url.pathname === '/api/webhook/polar') {
    return withCors(await handlePolarWebhook(request, env), headers);
  }

  // The Google Reader API for other RSS apps (routes/greader.ts). Those apps sign
  // in with an app password, never a session, so they're answered before session
  // resolution; the handler authenticates and rate-limits them itself.
  const greaderPath = greaderSubpath(url.pathname);
  if (greaderPath !== null) {
    return withCors(await handleGReader(request, env, ctx, greaderPath), headers);
  }

  // Before the session lookup: a client in a loop is refused without a D1 call.
  if (!(await passesRequestGate(env, request))) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Retry-After': String(REQUEST_GATE_PERIOD_SECONDS),
      },
    });
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
    case url.pathname === '/api/guest/starter-feeds':
      response = handleGuestStarterFeeds(request);
      break;
    case url.pathname === '/api/guest/timeline':
      response = await handleGuestTimeline(request, env);
      break;
    case url.pathname === '/api/guest/items/body':
      response = await handleGuestItemBody(request, env);
      break;
    // The discussion's read path, session-free (routes/guest.ts). Same handlers
    // as the /api/v2 twins below, answering from public Atmosphere data.
    case url.pathname === '/api/guest/mentions':
      response = await handleGuestMentions(request, env);
      break;
    case url.pathname === '/api/guest/mention-lane':
      response = await handleGuestMentionLane(request, env);
      break;
    case url.pathname === '/api/guest/margin-highlights':
      response = await handleGuestMarginHighlights(request, env);
      break;
    // Test-only D1 exec endpoint (e2e seed/cleanup). Mounted only when
    // E2E_TEST_MODE is set, so it's unreachable in production.
    case url.pathname === '/api/test/exec' && env.E2E_TEST_MODE === 'true':
      response = await handleTestExec(request, env);
      break;

    // OAuth client metadata
    case url.pathname === '/.well-known/client-metadata':
      response = await handleClientMetadata(request, env);
      break;

    // The feed crawler's Web Bot Auth public key (relayed from the proxy)
    case url.pathname === '/.well-known/http-message-signatures-directory':
      response = await handleSignatureDirectory(request, env);
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
    case url.pathname === '/api/auth/frame-claim':
      response = await handleFrameSignInClaim(request, env);
      break;
    case url.pathname === '/api/auth/upgrade':
      response = await handleAuthUpgrade(request, env);
      break;

    // Internal crawler endpoints authenticate with FEED_PROXY_SECRET in their
    // handlers; they intentionally do not require a user session.
    case url.pathname === '/api/internal/ingest':
      response = await handleIngest(request, env);
      break;
    case url.pathname === '/api/internal/crawl-set':
      response = await handleCrawlSet(request, env);
      break;
    case url.pathname === '/api/internal/feed-health':
      response = await handleFeedHealth(request, env);
      break;
    // Document store operator endpoints: the one-time (and ongoing) backfill, and
    // the proxy-vs-D1 shadow compare that gates the read cutover.
    case url.pathname === '/api/internal/documents/backfill':
      response = await handleDocumentBackfill(request, env);
      break;
    case url.pathname === '/api/internal/documents/shadow-compare':
      response = await handleDocumentShadowCompare(request, env);
      break;

    // The reader's whole refresh, served from the D1 archive in one query.
    case url.pathname === '/api/v2/timeline':
      if (!session) return unauthorizedResponse(headers);
      response = await handleTimeline(request, env, session);
      // Pull new link posts from the reader's Bluesky likes/bookmarks, if they
      // follow either; they land on a later read (services/bsky-sources.ts).
      ctx.waitUntil(
        refreshBskySourcesIfDue(env, session).catch((error) => {
          log.error('bsky_sources_refresh_threw', { did: session.did, ...serializeError(error) });
        })
      );
      break;

    // A long item's body, stored out-of-row in R2 at ingest.
    case url.pathname === '/api/v2/items/body':
      if (!session) return unauthorizedResponse(headers);
      response = await handleItemBody(request, env, session.did);
      break;

    // Feed routes (v2 via Fly.io proxy)
    case url.pathname === '/api/v2/feeds/fetch':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2FeedFetch(request, env, session);
      break;
    case url.pathname === '/api/v2/feeds/batch':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2BatchFeedFetch(request, env, session);
      break;
    case url.pathname === '/api/v2/feeds/discover':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2FeedDiscover(request, env);
      break;
    // Feeds at the sites of the people you follow (Discover's publications tab).
    case url.pathname === '/api/v2/feeds/discover-sites' && request.method === 'POST':
      if (!session) return unauthorizedResponse(headers);
      response = await handleDiscoverSites(request, env);
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
    // From your follows — see docs/plans/FOLLOWS_LINKS_PLAN.md.
    case url.pathname === '/api/v2/following-links':
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetFollowLinks(request, env, ctx, session);
      break;
    // Bluesky likes / bookmarks as sources — see services/bsky-sources.ts.
    case url.pathname === '/api/v2/bluesky-sources':
      if (!session) return unauthorizedResponse(headers);
      response = await handleBskySources(request, env, session);
      break;
    case url.pathname === '/api/v2/following-links/all':
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetAllFollowLinks(request, env, session);
      break;
    case url.pathname === '/api/v2/following-links/for':
      if (!session) return unauthorizedResponse(headers);
      response = await handleFollowLinkSharers(request, env, session);
      break;
    case url.pathname === '/api/v2/following-links/settings':
      if (!session) return unauthorizedResponse(headers);
      response = await handleFollowLinksSettings(request, env, session);
      break;
    // Phase 0 probe: local dev only, 404s when deployed.
    case url.pathname === '/api/v2/following-links/probe':
      if (!session) return unauthorizedResponse(headers);
      response = await handleFollowLinksProbe(request, env);
      break;
    case url.pathname === '/api/v2/margin-highlights':
      if (!session) return unauthorizedResponse(headers);
      response = await handleV2MarginHighlights(request, env);
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

    // Unposted share drafts — private to the account, D1 only, delta-synced so
    // a draft started on one device can be finished on another.
    case url.pathname === '/api/linkblog/drafts':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'GET') {
        response = await handleGetShareDrafts(request, env);
      } else if (request.method === 'PUT') {
        response = await handleUpsertShareDraft(request, env);
      } else if (request.method === 'DELETE') {
        response = await handleDeleteShareDraft(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
    case url.pathname === '/api/linkblog/formatting':
      if (!session) return unauthorizedResponse(headers);
      response = await handleSetLinkblogFormatting(request, env);
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
    // Public linkblog posts, for linkblogs.skyreader.app. Unauthenticated like
    // the resolve above it — same content, same readers.
    case url.pathname.startsWith('/api/linkblog/documents/'):
      response = await handleLinkblogDocuments(request, env);
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
    // Mark the canonical per-feed window read server-side, so every device
    // converges — including on items the acting device never held locally.
    case url.pathname === '/api/reading/mark-feed-read':
      if (!session) return unauthorizedResponse(headers);
      response = await handleMarkFeedRead(request, env, session);
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

    // Reading Rooms (spike) — see docs/plans/READING_ROOMS_SPIKE.md
    // The whole surface needs a session, the read included. The GET was briefly
    // session-free so a shared room link could open for a signed-out visitor,
    // but that put an unmetered read in front of anonymous callers (rate
    // limiting keys on the session DID, so none applied) and every open of an
    // unseen room resolves a foreign collection and writes a room row. Rooms is
    // an account surface; the frontend sends a signed-out visitor through
    // sign-in and back to the room instead.
    case url.pathname === '/api/rooms':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'POST') {
        response = await handleCreateRoom(request, env);
      } else {
        response = await handleGetRoom(request, env, ctx);
      }
      break;
    case url.pathname === '/api/rooms/join':
      if (!session) return unauthorizedResponse(headers);
      response = await handleRoomJoin(request, env);
      break;
    case url.pathname === '/api/rooms/read':
      if (!session) return unauthorizedResponse(headers);
      response = await handleRoomRead(request, env);
      break;
    case url.pathname === '/api/rooms/items':
      if (!session) return unauthorizedResponse(headers);
      response = await handleRoomAddItem(request, env);
      break;

    // Recommends — one-tap public recommendations (routes/recommends.ts)
    case url.pathname === '/api/recommends':
      if (!session) return unauthorizedResponse(headers);
      response = await handleRecommends(request, env);
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
    case url.pathname === '/api/saved/delete':
      if (!session) return unauthorizedResponse(headers);
      response = await handleDeleteSavedMany(request, env, ctx);
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
    // A library from another read-later app (routes/saved-import.ts)
    case url.pathname === '/api/saved/import':
      if (!session) return unauthorizedResponse(headers);
      response = await handleImportSaved(request, env, ctx);
      break;
    case url.pathname === '/api/saved/updates':
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetSavedUpdates(request, env);
      break;
    // The notification bell: synced read-state (routes/notifications.ts) and the
    // Dev Log's "New in Skyreader" posts (routes/updates.ts)
    case url.pathname === '/api/notifications/seen':
      if (!session) return unauthorizedResponse(headers);
      response = await handleNotificationSeen(request, env, session.did);
      break;
    // App passwords for other RSS apps (routes/app-passwords.ts)
    case url.pathname === '/api/app-passwords' || url.pathname.startsWith('/api/app-passwords/'):
      if (!session) return unauthorizedResponse(headers);
      response = await handleAppPasswords(request, env, session);
      break;
    case url.pathname === '/api/updates':
      if (!session) return unauthorizedResponse(headers);
      response = await handleUpdates(request, env);
      break;
    // Semble connections drawn off the reader's saves (routes/saved-connections.ts)
    case url.pathname === '/api/saved/connections' ||
      url.pathname === '/api/saved/connections/seen':
      if (!session) return unauthorizedResponse(headers);
      response = await handleSavedConnections(request, env, session.did);
      break;
    // Uploaded PDFs and EPUBs (Supporter) — routes/saved-pdf.ts
    case url.pathname === '/api/saved/pdf':
      if (!session) return unauthorizedResponse(headers);
      response = await handleUploadPdf(request, env, session);
      break;
    case url.pathname === '/api/saved/epub':
      if (!session) return unauthorizedResponse(headers);
      response = await handleUploadEpub(request, env, session);
      break;
    case /^\/api\/saved\/[^/]+\/file$/.test(url.pathname):
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetSavedFile(request, env, session);
      break;
    case /^\/api\/saved\/[^/]+\/snapshots$/.test(url.pathname):
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetSavedSnapshots(request, env, session);
      break;
    case /^\/api\/saved\/[^/]+\/snapshot-image$/.test(url.pathname):
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetSnapshotImage(request, env, session);
      break;
    case /^\/api\/saved\/[^/]+\/asset$/.test(url.pathname):
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetSavedAsset(request, env, session);
      break;
    case url.pathname.startsWith('/api/saved/'):
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'PATCH') {
        response = await handleUpdateSaved(request, env);
      } else {
        response = await handleDeleteSaved(request, env, ctx);
      }
      break;

    // Saves, highlights and notes as Markdown or BibTeX (routes/export.ts)
    case url.pathname === '/api/export':
      if (!session) return unauthorizedResponse(headers);
      response = await handleExport(request, env, session.did);
      break;

    // Shelf collections — ordered, private groups of saves (routes/shelf.ts)
    case url.pathname === '/api/shelf/collections' ||
      url.pathname.startsWith('/api/shelf/collections/'):
      if (!session) return unauthorizedResponse(headers);
      response = await handleShelfCollections(request, env, session, ctx);
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

    // Full-text search (Supporter) — durable-objects/search-index.ts
    case url.pathname === '/api/search':
      if (!session) return unauthorizedResponse(headers);
      response = await handleSearch(request, env, session);
      break;

    // Email newsletters (Supporter). Inbound mail arrives through the email()
    // handler below, not over HTTP.
    case url.pathname === '/api/newsletters':
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetNewsletters(env, session);
      break;
    case url.pathname === '/api/newsletters/address':
      if (!session) return unauthorizedResponse(headers);
      response = await handleIssueNewsletterAddress(request, env, session);
      break;
    case url.pathname === '/api/newsletters/blocked':
      if (!session) return unauthorizedResponse(headers);
      response = await handleUnblockNewsletterSender(request, env, session);
      break;

    // Billing (Polar checkout; the webhook is mounted pre-session above)
    case url.pathname === '/api/billing/products':
      response = await handleListBillingProducts(request, env, session);
      break;
    case url.pathname === '/api/billing/checkout':
      response = await handleCreateCheckout(request, env, session);
      break;
    case url.pathname === '/api/billing/portal':
      response = await handleCreateBillingPortal(request, env, session);
      break;
    case url.pathname === '/api/billing/subscription':
      response = await handleGetBillingSubscription(request, env, session);
      break;

    // Public feedback board; edge-cached before it reaches userinput.app.
    // Posting is not public: it writes a discussion record to the reader's own
    // repo, so it needs their session (and the userinput scope).
    case url.pathname === '/api/v2/feedback':
      if (request.method === 'POST') {
        if (!session) return unauthorizedResponse(headers);
        response = await handleCreateFeedback(request, env, session);
      } else {
        response = await handleGetFeedback(request, env, session);
      }
      break;

    // The replies on one post, fetched when a reader expands it. Public for the
    // same reason the board is: a reply is a public record in its own repo.
    case url.pathname === '/api/v2/feedback/thread':
      response = await handleGetFeedbackThread(request, env, session);
      break;

    // What the caller filed, reduced to the fields a change shows up in. Polled
    // by the notification inbox, so it is session-only and never edge-cached.
    case url.pathname === '/api/v2/feedback/mine':
      if (!session) return unauthorizedResponse(headers);
      response = await handleGetMyFeedback(request, env, session);
      break;

    // One attachment's bytes, uploaded to the reader's own blob store before the
    // post that references them is written. Session-only, like the POST above.
    case url.pathname === '/api/v2/feedback/image':
      if (!session) return unauthorizedResponse(headers);
      response = await handleUploadFeedbackImage(request, env, session);
      break;

    // Also posting a linkblog share to Bluesky: a text shot's bytes first, then
    // the app.bsky.feed.post that embeds them (or the article's link card).
    case url.pathname === '/api/v2/bluesky/image':
      if (!session) return unauthorizedResponse(headers);
      response = await handleUploadBlueskyImage(request, env, session);
      break;
    case url.pathname === '/api/v2/bluesky/post':
      if (!session) return unauthorizedResponse(headers);
      response = await handleCreateBlueskyPost(request, env, session);
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
      if (request.method === 'GET') {
        response = await handleListSembleCards(request, env);
      } else if (request.method === 'POST') {
        response = await handleCreateSembleCard(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;
    case url.pathname === '/api/integrations/semble/connections':
      if (!session) return unauthorizedResponse(headers);
      if (request.method !== 'POST') {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        response = await handleCreateSembleConnection(request, env);
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
    case url.pathname === '/api/integrations/margin/highlights':
      if (!session) return unauthorizedResponse(headers);
      if (request.method !== 'GET') {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        response = await handleListMarginHighlights(request, env);
      }
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
    case url.pathname === '/api/integrations/semble/memberships':
    case url.pathname === '/api/integrations/margin/memberships':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'GET') {
        response = await handleGetIntegrationMemberships(request, env);
      } else if (request.method === 'POST') {
        response = await handleEditIntegrationMemberships(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
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
    case url.pathname === '/api/channels/order':
      if (!session) return unauthorizedResponse(headers);
      if (request.method === 'PUT') {
        response = await handleReorderChannels(request, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;
    case url.pathname === '/api/channels/preview':
      if (!session) return unauthorizedResponse(headers);
      response = await handleChannelPreview(request, env, session);
      break;
    case /^\/api\/channels\/[^/]+\/items$/.test(url.pathname):
      if (!session) return unauthorizedResponse(headers);
      response = await handleChannelItems(request, env, session, url.pathname.split('/')[3]);
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
      response = await handleSyncSubscriptions(request, env, ctx);
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

  // A successful write that can change what the reader has read, saved or
  // highlighted nudges their search index. After the response, and harmless if
  // it's lost: the index pulls by cursor, so the next sync sees the change anyway.
  if (session && response.ok) {
    const nudge = searchNudgeFor(request.method, url.pathname);
    if (nudge) ctx.waitUntil(nudgeSearchIndex(env, session.did, nudge));
  }

  return withCors(response, headers);
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
              // D1 round trips and their execution time, for routes that go
              // through `utils/d1-timing`. Absent on a route that made none —
              // spreading undefined adds no fields. `durationMs - d1WallMs` is
              // Worker-side work; `d1WallMs - d1Ms` is Worker↔D1 network.
              ...d1Summary(),
            });
          }
        }
      }
    );
  },

  // Cloudflare Email Routing delivers newsletter mail here (services/newsletters.ts).
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    return runWithRequestContext({ requestId: crypto.randomUUID(), route: 'email' }, async () => {
      try {
        const outcome = await handleInboundEmail(message, env);
        log.info('newsletter_email', { outcome, bytes: message.rawSize });
      } catch (error) {
        // Rethrown so the sending server gets a temporary failure and retries.
        log.error('newsletter_email_error', serializeError(error));
        reportError(error, { tags: { source: 'email' } });
        throw error;
      }
    });
  },

  // Background jobs (services/jobs.ts).
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    return runWithRequestContext({ requestId: crypto.randomUUID(), route: 'queue' }, () =>
      runJobs(batch as MessageBatch<Job>, env)
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
      const response = await withTimeout<Response>(
        poller.fetch('http://internal/start'),
        POLLER_PING_TIMEOUT_MS,
        'JetstreamPoller /start'
      );
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

    // Phase 1c: one document author per minute, which is what makes "the rest is
    // the reconcile's job" an honest thing for the bounded sync paths to say. The
    // queue takes never-listed authors first, so a restore that brought back more
    // linkblogs than one request may warm is served in minutes rather than across
    // the hourly tick's afternoon. This writes documents, so the ingest kill switch
    // stops it like every other background write.
    const documentFlags = await readDocumentFlags(env);
    // One ledger for both reconcile passes: on the hour they run in the same
    // invocation, so a budget held per pass would let the pair add up past D1's
    // per-invocation ceiling and fail the later walks mid-write.
    const documentCtx = createDocumentApplyContext(createQueryLedger(CRON_DOCUMENT_QUERY_BUDGET));
    try {
      const reconciled = documentFlags.ingestEnabled
        ? await reconcileStaleAuthors(env, CRON_MINUTE_RECONCILE_AUTHORS, documentCtx)
        : [];
      if (reconciled.length > 0) {
        log.info('cron_documents_cold_start', {
          authors: reconciled.length,
          failed: reconciled.filter((r) => !r.ok).length,
        });
      }
    } catch (error) {
      log.error('cron_phase_failed', { phase: 'documents-cold-start', ...serializeError(error) });
      reportError(error, { tags: { source: 'cron', phase: 'documents-cold-start' } });
    }

    // Phase 1d: wake the saved-search matcher. It pulls new items itself and
    // reschedules while it has a backlog; this only guarantees a pass a minute.
    try {
      await nudgePercolator(env);
    } catch (error) {
      log.error('cron_phase_failed', { phase: 'percolator-nudge', ...serializeError(error) });
      reportError(error, { tags: { source: 'cron', phase: 'percolator-nudge' } });
    }

    // Phase 1e: refresh follows links for readers who use them, while they're
    // away. Each refresh runs in its reader's own poller; this only picks who's
    // due, so it's left running past the rest of the cron.
    ctx.waitUntil(
      dispatchBackgroundFollowLinks(env).catch((error) => {
        log.error('cron_phase_failed', {
          phase: 'follow-links-background',
          ...serializeError(error),
        });
        reportError(error, { tags: { source: 'cron', phase: 'follow-links-background' } });
      })
    );

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
        await cleanupFrameSignIns(env, now);
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

      // Expired site feed discoveries (routes/site-feeds.ts): a later scan
      // rediscovers any site still followed, so expired rows are only weight.
      try {
        await env.DB.prepare('DELETE FROM site_feed_discovery WHERE expires_at < ?')
          .bind(now)
          .run();
      } catch (error) {
        log.error('cron_phase_failed', { phase: 'site-feed-cleanup', ...serializeError(error) });
        reportError(error, { tags: { source: 'cron', phase: 'site-feed-cleanup' } });
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

      // Purge old share-draft tombstones (same 90-day retention, same reason:
      // a client that was offline across the deletion still has to replay it).
      try {
        const shareDraftCutoff = Math.floor(now / 1000) - 90 * 24 * 60 * 60;
        await env.DB.prepare(
          'DELETE FROM share_drafts WHERE deleted_at IS NOT NULL AND deleted_at < ?'
        )
          .bind(shareDraftCutoff)
          .run();
      } catch (error) {
        log.error('cron_phase_failed', {
          phase: 'share-draft-tombstone-purge',
          ...serializeError(error),
        });
        reportError(error, { tags: { source: 'cron', phase: 'share-draft-tombstone-purge' } });
      }

      // Linked EPUBs read by /api/extract that no save adopted.
      try {
        const staged = await sweepStagedOriginals(env, now);
        if (staged) log.info('cron_staged_originals_swept', { deleted: staged });
      } catch (error) {
        log.error('cron_phase_failed', {
          phase: 'staged-originals-sweep',
          ...serializeError(error),
        });
        reportError(error, { tags: { source: 'cron', phase: 'staged-originals-sweep' } });
      }

      // From your follows: shares past the 7-day window.
      try {
        await purgeFollowLinks(env, now);
      } catch (error) {
        log.error('cron_phase_failed', { phase: 'follow-links-purge', ...serializeError(error) });
        reportError(error, { tags: { source: 'cron', phase: 'follow-links-purge' } });
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
      // Field vitals' daily histograms, kept 90 days like the snapshots.
      await runRecordingStep('vitals-prune', () => pruneVitals(env));

      // Document self-heal. The firehose only carries writes made while we were
      // watching, so a gap (reconnect, cursor reset, a paused ingest) leaves a hole
      // nothing else fills — the proxy closed those by full-replacing its blob on
      // every refresh. A few of the stalest authors per hour re-lists everyone
      // inside the reconcile interval without ever making the cron the bottleneck.
      // Paused with ingest, like every other background write of documents: the
      // kill switch is a flood response, and this writes up to a hundred rows an
      // author. The operator backfill endpoint stays available regardless — that
      // one is a deliberate repair, not a background loop.
      try {
        const reconciled = documentFlags.ingestEnabled
          ? await reconcileStaleAuthors(env, CRON_HOURLY_RECONCILE_AUTHORS, documentCtx)
          : [];
        if (reconciled.length > 0) {
          log.info('cron_documents_reconcile', {
            authors: reconciled.length,
            failed: reconciled.filter((r) => !r.ok).length,
          });
        }
      } catch (error) {
        log.error('cron_phase_failed', { phase: 'documents-reconcile', ...serializeError(error) });
        reportError(error, { tags: { source: 'cron', phase: 'documents-reconcile' } });
      }
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
