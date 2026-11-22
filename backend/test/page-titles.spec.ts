import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handlePageTitles } from '../src/routes/page-titles';

/** POST /api/page-titles: the real titles of an article's links, via the proxy. */

function request(body: unknown, method = 'POST'): Request {
  return new Request('https://api.example/api/page-titles', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

describe('page titles', () => {
  let originalFetch: typeof fetch;
  let sent: Array<{ path: string; urls: string[] }>;
  let answer: () => Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sent = [];
    (env as Env).FEED_PROXY_URL = 'https://proxy.example';
    (env as Env).FEED_PROXY_SECRET = 'test-secret';
    answer = () =>
      new Response(
        JSON.stringify({ titles: { 'https://a.example/1': 'A Real Title', bad: 7 }, pending: true }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      sent.push({ path: new URL(String(input)).pathname, urls: body.urls });
      return answer();
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('asks the proxy for web links only, once each, at most 50', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `https://a.example/${i}`);
    const res = await handlePageTitles(
      request({ urls: ['javascript:alert(1)', 'mailto:x@y', 'https://a.example/1', ...many] }),
      env
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/page-titles');
    expect(sent[0].urls).toHaveLength(50);
    expect(sent[0].urls[0]).toBe('https://a.example/1');
    expect(sent[0].urls.every((u) => u.startsWith('https://'))).toBe(true);
    expect(await res.json()).toEqual({
      titles: { 'https://a.example/1': 'A Real Title' },
      pending: true,
    });
  });

  it("doesn't call the proxy for nothing", async () => {
    const res = await handlePageTitles(request({ urls: ['ftp://x.example/f'] }), env);
    expect(await res.json()).toEqual({ titles: {}, pending: false });
    expect(sent).toHaveLength(0);
  });

  it('answers empty when the proxy fails', async () => {
    answer = () => new Response('busy', { status: 503 });
    const res = await handlePageTitles(request({ urls: ['https://a.example/1'] }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ titles: {}, pending: false });
  });

  it('refuses a body without a list', async () => {
    expect((await handlePageTitles(request({ url: 'https://a.example' }), env)).status).toBe(400);
    expect((await handlePageTitles(request(null, 'GET'), env)).status).toBe(405);
  });
});
