import type { Env } from './types';
import { handleAuthLogin, handleAuthCallback, handleAuthLogout, handleClientMetadata } from './routes/auth';
import { handleFeedFetch, handleFeedDiscover } from './routes/feeds';
import { handleSocialFeed, handleSyncFollows, handlePopularShares } from './routes/social';
import { handleRecordSync } from './routes/records';

export { JetstreamConsumer } from './durable-objects/jetstream-consumer';

function corsHeaders(origin: string | null, allowedOrigin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin && (origin === allowedOrigin || allowedOrigin === '*') ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(origin, env.FRONTEND_URL);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
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
          response = await handleAuthCallback(request, env);
          break;
        case url.pathname === '/api/auth/logout':
          response = await handleAuthLogout(request, env);
          break;

        // Feed routes
        case url.pathname === '/api/feeds/fetch':
          response = await handleFeedFetch(request, env);
          break;
        case url.pathname === '/api/feeds/discover':
          response = await handleFeedDiscover(request, env);
          break;

        // Social routes
        case url.pathname === '/api/social/feed':
          response = await handleSocialFeed(request, env);
          break;
        case url.pathname === '/api/social/sync-follows':
          response = await handleSyncFollows(request, env);
          break;
        case url.pathname === '/api/social/popular':
          response = await handlePopularShares(request, env);
          break;

        // Record sync routes
        case url.pathname === '/api/records/sync':
          response = await handleRecordSync(request, env);
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
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: { ...headers, 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
