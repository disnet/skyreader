import type { Env } from './types';
import { handleAuthLogin, handleAuthCallback, handleAuthLogout, handleAuthMe, handleClientMetadata } from './routes/auth';
import { handleFeedFetch, handleCachedFeedFetch, handleFeedDiscover, handleArticleFetch, handleFeedStatusBatch, handleBatchFeedFetch } from './routes/feeds';
import { handleItemsList, handleItemsRecent, handleItemGet, handleItemsByFeed } from './routes/items';
import { handleSocialFeed, handleSyncFollows, handleFollowedUsers, handlePopularShares } from './routes/social';
import { handleGetMyShares } from './routes/shares';
import { handleDiscover } from './routes/discover';
import { handleRecordSync, handleBulkRecordSync, handleRecordsList } from './routes/records';
import { handleGetReadPositions, handleMarkAsRead, handleMarkAsUnread, handleToggleStar, handleBulkMarkAsRead } from './routes/reading';
import { getSessionFromRequest, updateUserActivity } from './services/oauth';
import { checkRateLimit, cleanupRateLimits, getRateLimitConfig } from './services/rate-limit';

export { RealtimeHub } from './durable-objects/realtime-hub';
export { JetstreamPoller } from './durable-objects/jetstream-poller';
export { FeedRefresher } from './durable-objects/feed-refresher';

function corsHeaders(origin: string | null, allowedOrigin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin && (origin === allowedOrigin || allowedOrigin === '*') ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(origin, env.FRONTEND_URL);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // Track user activity for authenticated requests (non-blocking)
    const session = await getSessionFromRequest(request, env);
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
    }

    try {
      let response: Response;

      // Route matching
      switch (true) {
        // OAuth client metadata
        case url.pathname === '/.well-known/client-metadata':
          response = handleClientMetadata(request, env);
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

        // Feed routes
        case url.pathname === '/api/feeds/fetch':
          response = await handleFeedFetch(request, env);
          break;
        case url.pathname === '/api/feeds/cached':
          response = await handleCachedFeedFetch(request, env);
          break;
        case url.pathname === '/api/feeds/discover':
          response = await handleFeedDiscover(request, env);
          break;
        case url.pathname === '/api/feeds/article':
          response = await handleArticleFetch(request, env);
          break;
        case url.pathname === '/api/feeds/status':
          response = await handleFeedStatusBatch(request, env);
          break;
        case url.pathname === '/api/feeds/batch':
          response = await handleBatchFeedFetch(request, env);
          break;

        // Item routes (individual feed items)
        case url.pathname === '/api/items':
          response = await handleItemsList(request, env);
          break;
        case url.pathname === '/api/items/recent':
          response = await handleItemsRecent(request, env);
          break;
        case url.pathname === '/api/items/get':
          response = await handleItemGet(request, env);
          break;
        case url.pathname === '/api/items/by-feed':
          response = await handleItemsByFeed(request, env);
          break;

        // Social routes
        case url.pathname === '/api/social/feed':
          response = await handleSocialFeed(request, env);
          break;
        case url.pathname === '/api/social/sync-follows':
          response = await handleSyncFollows(request, env);
          break;
        case url.pathname === '/api/social/following':
          response = await handleFollowedUsers(request, env);
          break;
        case url.pathname === '/api/social/popular':
          response = await handlePopularShares(request, env);
          break;

        // User's own shares route
        case url.pathname === '/api/shares/my':
          response = await handleGetMyShares(request, env);
          break;

        // Discover route
        case url.pathname === '/api/discover':
          response = await handleDiscover(request, env);
          break;

        // Record sync routes
        case url.pathname === '/api/records/sync':
          response = await handleRecordSync(request, env);
          break;
        case url.pathname === '/api/records/bulk-sync':
          response = await handleBulkRecordSync(request, env);
          break;
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
        case url.pathname === '/api/reading/toggle-star':
          response = await handleToggleStar(request, env);
          break;
        case url.pathname === '/api/reading/mark-read-bulk':
          response = await handleBulkMarkAsRead(request, env);
          break;

        // Realtime WebSocket route
        case url.pathname === '/api/realtime': {
          if (!env.REALTIME_HUB) {
            return new Response(JSON.stringify({ error: 'Realtime not configured' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const hubId = env.REALTIME_HUB.idFromName('main');
          const hub = env.REALTIME_HUB.get(hubId);
          // WebSocket upgrades bypass CORS handling
          return hub.fetch(request);
        }

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
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: { ...headers, 'Content-Type': 'application/json' },
        }
      );
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const cronStart = Date.now();
    const minute = new Date().getMinutes();
    const isEveryMinuteCron = controller.cron === '* * * * *';
    const is15MinuteCron = controller.cron.includes('*/15') || controller.cron.includes('*/30');

    console.log(`[Cron] Started: ${controller.cron}, minute=${minute}`);

    // Every minute: Cleanup tasks and ensure JetstreamPoller is running
    if (isEveryMinuteCron) {
      // Phase 1: Ensure JetstreamPoller DO is running
      try {
        const pollerId = env.JETSTREAM_POLLER.idFromName('main-v2');
        const poller = env.JETSTREAM_POLLER.get(pollerId);
        const response = await poller.fetch('http://internal/start');
        const result = await response.json() as { status: string };
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
          console.log(`[Cron] Rate limit cleanup: deleted ${rateLimitDeleted} records, ${rateLimitDuration}ms`);
        }
      } catch (error) {
        console.error('[Cron] Rate limit cleanup error:', error);
      }

      // Phase 3: Clean up expired D1 data (once per hour)
      let d1CleanupDuration = 0;
      if (minute === 0) {
        console.log('[Cron] Starting D1 cleanup');
        try {
          const cleanupStart = Date.now();
          const now = Date.now();
          const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

          const [oauthResult, sessionsResult] = await Promise.all([
            env.DB.prepare('DELETE FROM oauth_state WHERE expires_at < ?').bind(now).run(),
            env.DB.prepare(`
              DELETE FROM sessions
              WHERE (
                refresh_failures >= 5
                AND (refresh_locked_until IS NULL OR refresh_locked_until < ?)
              )
              OR expires_at < ?
            `).bind(now, thirtyDaysAgo).run(),
          ]);
          d1CleanupDuration = Date.now() - cleanupStart;
          const oauthDeleted = oauthResult.meta?.changes || 0;
          const sessionsDeleted = sessionsResult.meta?.changes || 0;
          console.log(`[Cron] D1 cleanup: deleted ${oauthDeleted} OAuth states, ${sessionsDeleted} sessions, ${d1CleanupDuration}ms`);
        } catch (error) {
          console.error('[Cron] D1 cleanup error:', error);
        }
      }

      const totalDuration = Date.now() - cronStart;
      console.log(`[Cron] Every-minute complete: total=${totalDuration}ms`);
    }

    // Every 15 minutes (or 30 in staging): Trigger FeedRefresher cycle
    if (is15MinuteCron) {
      try {
        const refresherId = env.FEED_REFRESHER.idFromName('main');
        const refresher = env.FEED_REFRESHER.get(refresherId);
        const response = await refresher.fetch('http://internal/trigger');
        const result = await response.json() as { status: string; feedCount?: number };
        console.log(`[Cron] FeedRefresher: ${result.status}${result.feedCount ? `, ${result.feedCount} feeds` : ''}`);
      } catch (error) {
        console.error('[Cron] Failed to trigger FeedRefresher:', error);
      }

      const totalDuration = Date.now() - cronStart;
      console.log(`[Cron] Feed refresh trigger complete: total=${totalDuration}ms`);
    }
  },
};
