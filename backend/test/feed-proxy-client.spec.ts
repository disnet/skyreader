import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeedProxyClient, FeedProxyError } from '../src/services/feed-proxy-client';
import type { Env } from '../src/types';

function createClient(): FeedProxyClient {
  return new FeedProxyClient({
    FEED_PROXY_URL: 'https://proxy.example',
    FEED_PROXY_SECRET: 'test-secret',
  } as Env);
}

describe('FeedProxyClient', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('non-JSON proxy responses', () => {
    // Regression: a plain-text infra error like "error code: 502" used to leak a
    // confusing "Unexpected token 'e'... is not valid JSON" SyntaxError to the user.
    it('surfaces a clean error for a plain-text 502 body', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('error code: 502', { status: 502 }));

      const client = createClient();
      await expect(client.discoverFeeds('https://www.cbc.ca')).rejects.toMatchObject({
        name: 'FeedProxyError',
        message: 'Feed service is temporarily unavailable (HTTP 502). Please try again.',
      });
    });

    it('does not throw a JSON SyntaxError', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('error code: 502', { status: 502 }));

      const client = createClient();
      const err = await client.discoverFeeds('https://www.cbc.ca').catch((e) => e);
      expect(err).toBeInstanceOf(FeedProxyError);
      expect(err.message).not.toContain('Unexpected token');
      expect(err.message).not.toContain('JSON');
    });
  });

  describe('JSON proxy responses', () => {
    it('returns discovered feeds on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ feeds: ['https://www.cbc.ca/webfeed/rss/rss-topstories'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = createClient();
      await expect(client.discoverFeeds('https://www.cbc.ca')).resolves.toEqual([
        'https://www.cbc.ca/webfeed/rss/rss-topstories',
      ]);
    });

    // The proxy's own application-level errors are valid JSON and must still
    // propagate their original message.
    it('propagates a JSON error body from the proxy', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'No feeds found' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = createClient();
      await expect(client.discoverFeeds('https://example.com')).rejects.toMatchObject({
        name: 'FeedProxyError',
        message: 'No feeds found',
      });
    });
  });
});
