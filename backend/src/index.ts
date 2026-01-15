import type { Env } from './types';
import { handleAuthLogin, handleAuthCallback, handleAuthLogout, handleAuthMe, handleClientMetadata } from './routes/auth';
import { handleFeedFetch, handleCachedFeedFetch, handleFeedDiscover, handleArticleFetch, handleFeedStatusBatch } from './routes/feeds';
import { handleItemsList, handleItemsRecent, handleItemGet, handleItemsByFeed } from './routes/items';
import { handleSocialFeed, handleSyncFollows, handleFollowedUsers, handlePopularShares } from './routes/social';
import { handleGetMyShares } from './routes/shares';
import { handleDiscover } from './routes/discover';
import { handleRecordSync, handleBulkRecordSync, handleRecordsList } from './routes/records';
import { handleGetReadPositions, handleMarkAsRead, handleMarkAsUnread, handleToggleStar, handleBulkMarkAsRead } from './routes/reading';
import { getSessionFromRequest, updateUserActivity } from './services/oauth';
import { refreshActiveFeeds } from './services/scheduled-feeds';
import { pollJetstream } from './services/jetstream-poller';
import { pollJetstreamFollows } from './services/jetstream-follows-poller';
import { pollJetstreamInappFollows } from './services/jetstream-inapp-follows-poller';
import { syncReadPositionsToPds } from './services/read-positions-pds-sync';
import { checkRateLimit, cleanupRateLimits, getRateLimitConfig } from './services/rate-limit';

export { RealtimeHub } from './durable-objects/realtime-hub';

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
    console.log(`[Cron] Started: ${controller.cron}`);

    // Run all three Jetstream pollers in parallel for better performance
    const pollerStartTime = Date.now();
    const [jetstreamResult, followsResult, inappFollowsResult] = await Promise.allSettled([
      pollJetstream(env),
      pollJetstreamFollows(env),
      pollJetstreamInappFollows(env),
    ]);
    const pollersDuration = Date.now() - pollerStartTime;

    // Log results
    if (jetstreamResult.status === 'fulfilled') {
      console.log(
        `[Cron] Jetstream shares: ${jetstreamResult.value.processed} processed, ` +
        `${jetstreamResult.value.errors} errors`
      );
    } else {
      console.error('[Cron] Jetstream poll failed:', jetstreamResult.reason);
    }

    if (followsResult.status === 'fulfilled') {
      console.log(
        `[Cron] Jetstream follows: ${followsResult.value.processed} processed, ` +
        `${followsResult.value.errors} errors`
      );
    } else {
      console.error('[Cron] Jetstream follows poll failed:', followsResult.reason);
    }

    if (inappFollowsResult.status === 'fulfilled') {
      console.log(
        `[Cron] Jetstream in-app follows: ${inappFollowsResult.value.processed} processed, ` +
        `${inappFollowsResult.value.errors} errors`
      );
    } else {
      console.error('[Cron] Jetstream in-app follows poll failed:', inappFollowsResult.reason);
    }

    // Refresh active feeds (every 15 minutes to reduce CPU usage)
    const minute = new Date().getMinutes();
    let feedRefreshDuration = 0;
    if (minute % 15 === 0) {
      try {
        const startTime = Date.now();
        const result = await refreshActiveFeeds(env);
        feedRefreshDuration = Date.now() - startTime;
        console.log(
          `[Cron] Feed refresh: ${result.fetched} fetched, ` +
          `${result.skipped} skipped, ${result.errors} errors, ${feedRefreshDuration}ms`
        );
      } catch (error) {
        console.error('[Cron] Feed refresh failed:', error);
      }
    }

    // Sync read positions to PDS (every 5 minutes for data portability)
    let pdsSyncDuration = 0;
    if (minute % 5 === 0) {
      try {
        const startTime = Date.now();
        const result = await syncReadPositionsToPds(env);
        pdsSyncDuration = Date.now() - startTime;
        if (result.synced > 0 || result.errors > 0) {
          console.log(
            `[Cron] PDS sync: ${result.synced} synced, ` +
            `${result.errors} errors, ${result.users} users, ${pdsSyncDuration}ms`
          );
        }
      } catch (error) {
        console.error('[Cron] PDS sync failed:', error);
      }
    }

    // Clean up rate limit records (every minute)
    try {
      const rateLimitDeleted = await cleanupRateLimits(env);
      if (rateLimitDeleted > 0) {
        console.log(`[Cron] Rate limit cleanup: deleted ${rateLimitDeleted} records`);
      }
    } catch (error) {
      console.error('[Cron] Rate limit cleanup failed:', error);
    }

    // Clean up expired D1 data (once per hour)
    if (minute === 0) {
      try {
        const now = Date.now();
        // 30-day grace period for refresh tokens (even if access token expired long ago)
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

        const [oauthResult, sessionsResult] = await Promise.all([
          // Delete OAuth states older than 10 minutes
          env.DB.prepare('DELETE FROM oauth_state WHERE expires_at < ?').bind(now).run(),
          // Delete sessions that are either:
          // 1. Have exceeded max refresh failures (5) AND their backoff period has passed, OR
          // 2. Access token expired more than 30 days ago (refresh token grace period)
          env.DB.prepare(`
            DELETE FROM sessions
            WHERE (
              refresh_failures >= 5
              AND (refresh_locked_until IS NULL OR refresh_locked_until < ?)
            )
            OR expires_at < ?
          `).bind(now, thirtyDaysAgo).run(),
        ]);
        const oauthDeleted = oauthResult.meta?.changes || 0;
        const sessionsDeleted = sessionsResult.meta?.changes || 0;
        if (oauthDeleted > 0 || sessionsDeleted > 0) {
          console.log(`[Cron] Cleanup: deleted ${oauthDeleted} OAuth states, ${sessionsDeleted} sessions`);
        }
      } catch (error) {
        console.error('[Cron] Cleanup failed:', error);
      }
    }

    const totalDuration = Date.now() - cronStart;
    console.log(
      `[Cron] Complete: total=${totalDuration}ms, ` +
      `pollers=${pollersDuration}ms (parallel), feeds=${feedRefreshDuration}ms, pds=${pdsSyncDuration}ms`
    );
  },
};
