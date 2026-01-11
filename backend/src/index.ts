import type { Env } from './types';
import { handleAuthLogin, handleAuthCallback, handleAuthLogout, handleAuthMe, handleClientMetadata } from './routes/auth';
import { handleFeedFetch, handleFeedDiscover, handleArticleFetch } from './routes/feeds';
import { handleSocialFeed, handleSyncFollows, handleFollowedUsers, handlePopularShares } from './routes/social';
import { handleRecordSync, handleRecordsList } from './routes/records';
import { getSessionFromRequest, updateUserActivity } from './services/oauth';
import { refreshActiveFeeds } from './services/scheduled-feeds';
import { pollJetstream } from './services/jetstream-poller';
import { pollJetstreamFollows } from './services/jetstream-follows-poller';

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
        case url.pathname === '/api/feeds/discover':
          response = await handleFeedDiscover(request, env);
          break;
        case url.pathname === '/api/feeds/article':
          response = await handleArticleFetch(request, env);
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

        // Record sync routes
        case url.pathname === '/api/records/sync':
          response = await handleRecordSync(request, env);
          break;
        case url.pathname === '/api/records/list':
          response = await handleRecordsList(request, env);
          break;

        // Realtime WebSocket route
        case url.pathname === '/api/realtime': {
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
    console.log(`Cron triggered: ${controller.cron}`);

    // Poll Jetstream for new shares
    try {
      const jetstreamResult = await pollJetstream(env);
      console.log(
        `Jetstream poll complete: ${jetstreamResult.processed} processed, ` +
        `${jetstreamResult.errors} errors`
      );
    } catch (error) {
      console.error('Jetstream poll failed:', error);
    }

    // Poll Jetstream for follow changes
    try {
      const followsResult = await pollJetstreamFollows(env);
      console.log(
        `Jetstream follows poll: ${followsResult.processed} processed, ` +
        `${followsResult.errors} errors`
      );
    } catch (error) {
      console.error('Jetstream follows poll failed:', error);
    }

    // Refresh active feeds (only every 15 minutes based on cron config)
    // Note: Now that cron runs every minute, we only refresh feeds periodically
    const minute = new Date().getMinutes();
    if (minute % 15 === 0) {
      try {
        const result = await refreshActiveFeeds(env);
        console.log(
          `Scheduled feed refresh complete: ${result.fetched} fetched, ` +
          `${result.skipped} skipped (not modified), ${result.errors} errors`
        );
      } catch (error) {
        console.error('Scheduled feed refresh failed:', error);
      }
    }

    // Clean up expired D1 data (once per hour)
    if (minute === 0) {
      try {
        const now = Date.now();
        const [oauthResult, sessionsResult] = await Promise.all([
          env.DB.prepare('DELETE FROM oauth_state WHERE expires_at < ?').bind(now).run(),
          env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run(),
        ]);
        const oauthDeleted = oauthResult.meta?.changes || 0;
        const sessionsDeleted = sessionsResult.meta?.changes || 0;
        if (oauthDeleted > 0 || sessionsDeleted > 0) {
          console.log(`Cleanup: deleted ${oauthDeleted} expired OAuth states, ${sessionsDeleted} expired sessions`);
        }
      } catch (error) {
        console.error('Cleanup of expired D1 data failed:', error);
      }
    }
  },
};
