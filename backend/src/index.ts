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
} from './routes/linkblog';
import { handleAtmosphereSubscription } from './routes/atmosphere';
import {
  handleCreateSubscription,
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
import {
  handleCreateSaved,
  handleGetSaved,
  handleDeleteSaved,
  handleDeleteSavedByGuid,
} from './routes/saved';
import { handleExtract } from './routes/extract';
import { handleGetSettings, handleUpdateSettings } from './routes/settings';
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
import { resolveSessionFromRequest, updateUserActivity } from './services/oauth';
import { checkRateLimit, cleanupRateLimits, getRateLimitConfig } from './services/rate-limit';

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
    pathname === '/api/auth/logout'
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(origin, env);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // Track user activity for authenticated requests (non-blocking)
    const sessionResult = await resolveSessionFromRequest(request, env);
    const session = sessionResult.session;
    if (session) {
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

    try {
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
          } else {
            response = await handleUpdatePublication(request, env);
          }
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
          response = await handleCreateSubscription(request, env, ctx);
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
            response = await handleGetSaved(request, env);
          } else if (request.method === 'POST') {
            response = await handleCreateSaved(request, env, ctx);
          } else {
            response = new Response(JSON.stringify({ error: 'Method not allowed' }), {
              status: 405,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          break;
        case url.pathname.startsWith('/api/saved/by-guid/'):
          if (!session) return unauthorizedResponse(headers);
          response = await handleDeleteSavedByGuid(request, env, ctx);
          break;
        case url.pathname.startsWith('/api/saved/'):
          if (!session) return unauthorizedResponse(headers);
          response = await handleDeleteSaved(request, env, ctx);
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
    } catch (error) {
      console.error('Request error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronStart = Date.now();
    const minute = new Date().getMinutes();
    const isEveryMinuteCron = controller.cron === '* * * * *';

    console.log(`[Cron] Started: ${controller.cron}, minute=${minute}`);

    // Every minute: Cleanup tasks and ensure JetstreamPoller is running
    if (isEveryMinuteCron) {
      // Phase 1: Ensure JetstreamPoller DO is running
      try {
        const pollerId = env.JETSTREAM_POLLER.idFromName('main-v2');
        const poller = env.JETSTREAM_POLLER.get(pollerId);
        const response = await poller.fetch('http://internal/start');
        const result = (await response.json()) as { status: string };
        console.log(`[Cron] JetstreamPoller: ${result.status}`);
      } catch (error) {
        console.error('[Cron] Failed to start JetstreamPoller:', error);
      }

      // Phase 2: Clean up rate limit records
      let rateLimitDuration = 0;
      let rateLimitDeleted = 0;
      try {
        const result = await cleanupRateLimits(env);
        rateLimitDeleted = result.deleted;
        rateLimitDuration = result.duration;
        if (rateLimitDeleted > 0) {
          console.log(
            `[Cron] Rate limit cleanup: deleted ${rateLimitDeleted} records, ${rateLimitDuration}ms`
          );
        }
      } catch (error) {
        console.error('[Cron] Rate limit cleanup error:', error);
      }

      // Phase 3: Clean up expired D1 data (once per hour)
      let d1CleanupDuration = 0;
      if (minute === 0) {
        console.log('[Cron] Starting D1 cleanup');
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
          console.error('[Cron] D1 WRITE ERROR deleting expired oauth_state:', error);
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
          console.error('[Cron] D1 WRITE ERROR deleting expired sessions:', error);
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
          console.error('[Cron] D1 WRITE ERROR purging label tombstones:', error);
        }

        d1CleanupDuration = Date.now() - cleanupStart;
        console.log(
          `[Cron] D1 cleanup: deleted ${oauthDeleted} OAuth states, ${sessionsDeleted} sessions, ${labelTombstonesDeleted} label tombstones, ${d1CleanupDuration}ms`
        );
      }

      const totalDuration = Date.now() - cronStart;
      console.log(`[Cron] Every-minute complete: total=${totalDuration}ms`);
    }
  },
};
