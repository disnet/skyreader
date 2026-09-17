import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeedProxyClient, FeedProxyError } from '../src/services/feed-proxy-client';
import type { Env } from '../src/types';
import { runWithRequestContext } from '../src/utils/request-context';

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

  // The proxy answers 200 with `{ error, blocked }` for anything it determined,
  // because a 5xx body does not survive the hop from Fly to the Worker: a blocked
  // save encoded as a 502 reached this client as a bare `error code: 502`, and the
  // reader was told the gateway had failed rather than that the site refused us.
  describe('extract() error contract', () => {
    it('raises a blocked FeedProxyError from a 200 determination', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        Response.json({
          error: 'www.cambridge.org is blocking automated access (HTTP 403).',
          blocked: true,
        })
      );

      const err = await createClient()
        .extract('https://www.cambridge.org/core/journals/x')
        .catch((e) => e);
      expect(err).toBeInstanceOf(FeedProxyError);
      expect(err.blocked).toBe(true);
      expect(err.message).toContain('blocking automated access');
    });

    it('raises a non-blocked FeedProxyError from a 200 timeout determination', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: 'Timeout after 12s', blocked: false }));

      const err = await createClient()
        .extract('https://slow.example/a')
        .catch((e) => e);
      expect(err).toBeInstanceOf(FeedProxyError);
      expect(err.blocked).toBe(false);
      expect(err.message).toBe('Timeout after 12s');
    });

    it('returns the article when the body carries no error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ title: 'A piece', content: '<p>hi</p>' }));

      const article = await createClient().extract('https://example.com/a');
      expect(article.title).toBe('A piece');
    });

    // A non-2xx now means the app never answered — the body is the edge's.
    it('carries the status and the edge body out of a bare gateway error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('error code: 502\n', { status: 502 }));

      const err = await createClient()
        .extract('https://example.com/a')
        .catch((e) => e);
      expect(err).toBeInstanceOf(FeedProxyError);
      expect(err.message).toContain('HTTP 502');
      expect(err.message).toContain('error code: 502');
      expect(err.blocked).toBeUndefined();
    });
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

  // Cross-service correlation: the proxy adopts this header and tags its own logs
  // and Sentry events with it, so one id spans both runtimes.
  describe('request id propagation', () => {
    it('sends X-Request-Id when there is an ambient request context', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ feeds: [] }), { status: 200 }));
      globalThis.fetch = fetchMock;

      await runWithRequestContext({ requestId: 'req-abc' }, () =>
        createClient().discoverFeeds('https://example.com')
      );

      const [, init] = fetchMock.mock.calls[0];
      expect(new Headers(init.headers).get('X-Request-Id')).toBe('req-abc');
    });

    it('omits the header outside a request context', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ feeds: [] }), { status: 200 }));
      globalThis.fetch = fetchMock;

      await createClient().discoverFeeds('https://example.com');

      const [, init] = fetchMock.mock.calls[0];
      expect(new Headers(init.headers).get('X-Request-Id')).toBeNull();
    });
  });
});

describe('FeedProxyClient.fetchSignatureDirectory', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('relays the raw signed response, bypassing the outbound cache', async () => {
    const upstream = new Response('{"keys":[]}', {
      status: 200,
      headers: {
        'Content-Type': 'application/http-message-signatures-directory+json',
        'Cache-Control': 'max-age=86400',
        Signature: 'sig1=:abc:',
        'Signature-Input': 'sig1=("@authority";req);tag="http-message-signatures-directory"',
      },
    });
    const fetchSpy = vi.fn().mockResolvedValueOnce(upstream);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await createClient().fetchSignatureDirectory();
    expect(res).toBe(upstream);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example/http-message-signatures-directory');
    // The directory is self-signed with a short expiry: a cached copy would be
    // served past its signature's validity.
    expect(init.cache).toBe('no-store');
    expect((init.headers as Headers).get('X-Proxy-Secret')).toBe('test-secret');
  });

  it('throws a FeedProxyError carrying the status when the proxy has no identity', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"not configured"}', { status: 404 }));
    const err = await createClient()
      .fetchSignatureDirectory()
      .catch((e) => e);
    expect(err).toBeInstanceOf(FeedProxyError);
    expect(err.status).toBe(404);
  });
});
