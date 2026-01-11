import type { Env } from './types';
import { handleAuthLogin, handleAuthCallback, handleAuthLogout, handleAuthMe, handleClientMetadata } from './routes/auth';
import { handleFeedFetch, handleFeedDiscover, handleArticleFetch } from './routes/feeds';
import { handleSocialFeed, handleSyncFollows, handleFollowedUsers, handlePopularShares } from './routes/social';
import { handleRecordSync, handleRecordsList } from './routes/records';
import { getSessionFromRequest, updateUserActivity } from './services/oauth';
import { refreshActiveFeeds } from './services/scheduled-feeds';

export { JetstreamConsumer } from './durable-objects/jetstream-consumer';
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

        // Jetstream debug routes
        case url.pathname === '/api/jetstream/status': {
          const jetstreamId = env.JETSTREAM_CONSUMER.idFromName('main-v2');
          const jetstream = env.JETSTREAM_CONSUMER.get(jetstreamId);
          response = await jetstream.fetch('http://internal/status');
          break;
        }
        case url.pathname === '/api/jetstream/reconnect': {
          const jetstreamId = env.JETSTREAM_CONSUMER.idFromName('main-v2');
          const jetstream = env.JETSTREAM_CONSUMER.get(jetstreamId);
          response = await jetstream.fetch('http://internal/reconnect');
          break;
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

    try {
      const result = await refreshActiveFeeds(env);
      console.log(
        `Scheduled feed refresh complete: ${result.fetched} fetched, ` +
        `${result.skipped} skipped (not modified), ${result.errors} errors`
      );
    } catch (error) {
      console.error('Scheduled feed refresh failed:', error);
    }

    // Ensure JetstreamConsumer stays alive (wakes it up if hibernated)
    try {
      const jetstreamId = env.JETSTREAM_CONSUMER.idFromName('main-v2');
      const jetstream = env.JETSTREAM_CONSUMER.get(jetstreamId);
      await jetstream.fetch('http://internal/status');
    } catch (error) {
      console.error('Failed to ping JetstreamConsumer:', error);
    }
  },
};
