import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { handlePublicLink } from '../src/routes/public-link';
import { getRateLimitConfig } from '../src/services/rate-limit';

/**
 * GET /api/public/link — the data behind the public link page
 * (read.skyreader.app). Session-free, cached at the edge by normalized URL, and
 * limited by one shared budget on cache misses.
 */

// Each test uses its own article URL: the edge cache outlives a test.
let seq = 0;
function article(): string {
  seq += 1;
  return `https://example.com/article-${Date.now()}-${seq}`;
}

function request(url: string | null, method = 'GET'): Request {
  const target = new URL('https://api.example/api/public/link');
  if (url !== null) target.searchParams.set('url', url);
  return new Request(target, { method, headers: { 'CF-Connecting-IP': '198.51.100.7' } });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await handlePublicLink(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

type ProxyAnswer = Record<string, unknown> | ((url: string) => Response);

describe('public link page data', () => {
  let originalFetch: typeof fetch;
  let proxyBodies: Array<{ url: string }>;
  let answer: ProxyAnswer;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    proxyBodies = [];
    answer = {};
    (env as Env).FEED_PROXY_URL = 'https://proxy.example';
    (env as Env).FEED_PROXY_SECRET = 'test-secret';
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { url: string };
      proxyBodies.push(body);
      if (typeof answer === 'function') return answer(body.url);
      return new Response(
        JSON.stringify({
          url: body.url,
          meta: { title: 'An article' },
          total: 1,
          lanes: [{ lane: 'bluesky', label: 'Bluesky', verb: 'posted', count: 1 }],
          entries: {
            bluesky: [
              {
                did: 'did:plc:alice',
                handle: 'alice.example',
                displayName: 'Alice',
                avatar: null,
                createdAt: '2026-10-01T00:00:00.000Z',
                note: 'worth it',
                url: 'https://bsky.app/profile/did:plc:alice/post/1',
                collections: [],
                verb: null,
                quote: null,
                likeCount: 12,
                source: 'internal',
              },
            ],
          },
          pending: false,
          unavailable: false,
          ...answer,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it('answers with the page data, keeping only the fields a public page shows', async () => {
    const url = article();
    const res = await call(request(url));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const body = (await res.json()) as {
      url: string;
      meta: { title: string };
      entries: { bluesky: Array<Record<string, unknown>> };
    };
    expect(body.url).toBe(url);
    expect(body.meta.title).toBe('An article');
    expect(body.entries.bluesky[0].handle).toBe('alice.example');
    expect(body.entries.bluesky[0]).not.toHaveProperty('likeCount');
    expect(body.entries.bluesky[0]).not.toHaveProperty('source');
  });

  it('serves a repeat visit, and a tracking-param variant, from the cache', async () => {
    const url = article();
    expect((await call(request(url))).status).toBe(200);
    expect((await call(request(`${url}?utm_source=bsky`))).status).toBe(200);
    expect((await call(request(`${url}/`))).status).toBe(200);
    expect(proxyBodies).toHaveLength(1);
    // The proxy is asked about the normalized URL, not the visitor's spelling.
    expect(proxyBodies[0].url).toBe(url);
  });

  it('caches a pending answer only briefly', async () => {
    answer = { pending: true, lanes: [], entries: {}, total: 0 };
    const res = await call(request(article()));
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=5');
  });

  it('never caches an answer the index could not give', async () => {
    answer = { unavailable: true };
    const url = article();
    const first = await call(request(url));
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    await call(request(url));
    expect(proxyBodies).toHaveLength(2);
  });

  it('turns a proxy failure into an uncached 502', async () => {
    answer = () => new Response('{"error":"boom"}', { status: 500 });
    const url = article();
    const res = await call(request(url));
    expect(res.status).toBe(502);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    await call(request(url));
    expect(proxyBodies).toHaveLength(2);
  });

  it('rejects a non-GET, a missing url, a non-http url and an oversized one', async () => {
    expect((await call(request(article(), 'POST'))).status).toBe(405);
    expect((await call(request(null))).status).toBe(400);
    expect((await call(request('javascript:alert(1)'))).status).toBe(400);
    expect((await call(request(`https://example.com/${'a'.repeat(2100)}`))).status).toBe(400);
    expect(proxyBodies).toEqual([]);
  });

  it('is reachable through the worker without a session', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(request(article()), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });

  it('limits cache misses with one shared budget, whoever is asking', async () => {
    const { limit, windowMs } = getRateLimitConfig('/api/public/link');
    const now = Math.floor(Date.now() / windowMs) * windowMs;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    for (let i = 0; i < limit; i++) {
      expect((await call(request(article()))).status).toBe(200);
    }
    const limited = await call(request(article()));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expect(proxyBodies).toHaveLength(limit);
  });
});
