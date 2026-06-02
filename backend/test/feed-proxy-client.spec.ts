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
    it('surfaces a clean, neutral error for a plain-text 502 body', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('error code: 502', { status: 502 }));

      const client = createClient();
      const err = await client.discoverFeeds('https://www.cbc.ca').catch((e) => e);
      expect(err).toBeInstanceOf(FeedProxyError);
      expect(err.message).toContain('HTTP 502');
      // Don't misattribute an ambiguous edge error to our own service being down,
      // and don't tell the user to "try again" (a bot block won't clear on retry).
      expect(err.message).not.toMatch(/feed service is/i);
      expect(err.message).not.toMatch(/try again/i);
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
        new Response(
          JSON.stringify({
            feeds: ['https://www.cbc.ca/webfeed/rss/rss-topstories'],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const client = createClient();
      await expect(client.discoverFeeds('https://www.cbc.ca')).resolves.toEqual({
        feeds: ['https://www.cbc.ca/webfeed/rss/rss-topstories'],
        standardSites: [],
      });
    });

    it('returns discovered standard.site URIs alongside feeds', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            feeds: ['https://underreacted.leaflet.pub/rss'],
            standardSites: ['at://did:plc:abc123/site.standard.document/3mjfjsk24qk2i'],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const client = createClient();
      await expect(client.discoverFeeds('https://underreacted.leaflet.pub')).resolves.toEqual({
        feeds: ['https://underreacted.leaflet.pub/rss'],
        standardSites: ['at://did:plc:abc123/site.standard.document/3mjfjsk24qk2i'],
      });
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

    // A site blocking our fetcher comes back as 200 + { blocked: true }; the flag
    // must ride along on the thrown error so callers can branch on it.
    it('propagates the blocked flag from a "blocking automated access" response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error:
              'www.cbc.ca is blocking automated access (HTTP 403). The site likely uses a bot filter or CDN.',
            blocked: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const client = createClient();
      const err = await client.discoverFeeds('https://www.cbc.ca').catch((e) => e);
      expect(err).toBeInstanceOf(FeedProxyError);
      expect(err.blocked).toBe(true);
      expect(err.message).toContain('blocking automated access');
    });
  });

  describe('fetchDocumentsBatch', () => {
    it('returns per-author document entries from the proxy', async () => {
      const entry = {
        did: 'did:plc:abc123',
        siteUri: 'at://did:plc:abc123/site.standard.publication/pub1',
        status: 'ready' as const,
        documents: [
          {
            authorDid: 'did:plc:abc123',
            recordUri: 'at://did:plc:abc123/site.standard.document/doc1',
            recordCid: 'cid1',
            siteUri: 'at://did:plc:abc123/site.standard.publication/pub1',
            title: 'Hello',
            publishedAt: '2024-01-02T00:00:00.000Z',
            createdAt: '2024-01-02T00:00:00.000Z',
            canonicalUrl: 'https://blog.example.com/hello',
          },
        ],
      };
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ authors: [entry] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.fetchDocumentsBatch([
        {
          did: 'did:plc:abc123',
          siteUri: 'at://did:plc:abc123/site.standard.publication/pub1',
        },
      ]);

      expect(result).toEqual([entry]);
      // Posts to the proxy's /documents endpoint with the secret header.
      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect(String(calledUrl)).toBe('https://proxy.example/documents');
      expect(init.method).toBe('POST');
    });

    it('throws when the proxy response lacks an authors array', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = createClient();
      await expect(client.fetchDocumentsBatch([{ did: 'did:plc:abc123' }])).rejects.toMatchObject({
        name: 'FeedProxyError',
        message: 'boom',
      });
    });
  });
});
