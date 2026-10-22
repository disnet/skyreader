import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleDiscoverSites, normalizeSite } from '../src/routes/site-feeds';
import type { Env } from '../src/types';

const ENV = {
  ...env,
  FEED_PROXY_URL: 'https://proxy.example',
  FEED_PROXY_SECRET: 'test-secret',
} as Env;

function request(body: unknown): Request {
  return new Request('https://api.example/api/v2/feeds/discover-sites', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stubs the proxy's /discover with an answer per site URL. */
function mockProxy(answers: Record<string, () => Response>) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const site = url.searchParams.get('url') ?? '';
    calls.push(site);
    const answer = answers[site];
    if (!answer) throw new Error(`Unexpected discover: ${site}`);
    return answer();
  }) as unknown as typeof fetch;
  return calls;
}

async function discover(sites: string[]) {
  const res = await handleDiscoverSites(request({ sites }), ENV);
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: Array<{ site: string; feeds: string[] }> }).results;
}

describe('normalizeSite', () => {
  it('keys a site by host and path, without scheme, www or trailing slash', () => {
    expect(normalizeSite('https://www.Example.com/blog/')).toEqual({
      key: 'example.com/blog',
      url: 'https://example.com/blog',
    });
    expect(normalizeSite('someone.com')).toEqual({
      key: 'someone.com',
      url: 'https://someone.com/',
    });
  });

  it('refuses addresses that are not public web sites', () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://localhost:8787',
      'https://[::1]/',
      'https://intranet/',
      'ftp://example.com',
      'https://user:pw@example.com',
      'https://example.com:8443/',
    ]) {
      expect(normalizeSite(bad), bad).toBeNull();
    }
  });
});

describe('POST /api/v2/feeds/discover-sites', () => {
  afterEach(async () => {
    await env.DB.prepare('DELETE FROM site_feed_discovery').run();
  });

  it('answers in input order, drops comment feeds, and caches per site', async () => {
    const calls = mockProxy({
      'https://writer.example/': () =>
        json({
          feeds: ['https://writer.example/comments/feed/', 'https://writer.example/feed/'],
          standardSites: [],
        }),
      'https://nofeed.example/': () => json({ feeds: [], standardSites: [] }),
    });

    const first = await discover(['writer.example', 'https://nofeed.example', 'not a url']);
    expect(first).toEqual([
      { site: 'writer.example', feeds: ['https://writer.example/feed/'] },
      { site: 'https://nofeed.example', feeds: [] },
      { site: 'not a url', feeds: [] },
    ]);
    expect(calls).toHaveLength(2);

    // A second reader following the same people costs no proxy calls.
    const second = await discover(['https://www.writer.example/', 'nofeed.example']);
    expect(second.map((r) => r.feeds)).toEqual([['https://writer.example/feed/'], []]);
    expect(calls).toHaveLength(2);
  });

  it('asks again once a cached answer expires', async () => {
    await env.DB.prepare(
      'INSERT INTO site_feed_discovery (site, feeds_json, expires_at) VALUES (?, ?, ?)'
    )
      .bind('writer.example', '[]', Date.now() - 1)
      .run();
    const calls = mockProxy({
      'https://writer.example/': () =>
        json({ feeds: ['https://writer.example/rss'], standardSites: [] }),
    });

    const results = await discover(['writer.example']);
    expect(results[0].feeds).toEqual(['https://writer.example/rss']);
    expect(calls).toEqual(['https://writer.example/']);
  });

  it("caches the proxy's verdict on a dead site, but not a proxy failure", async () => {
    mockProxy({
      'https://dead.example/': () => json({ error: 'fetch failed', blocked: false }),
      'https://flaky.example/': () => new Response('upstream connect error', { status: 503 }),
    });

    const results = await discover(['dead.example', 'flaky.example']);
    expect(results.map((r) => r.feeds)).toEqual([[], []]);

    const { results: rows } = await env.DB.prepare(
      'SELECT site FROM site_feed_discovery ORDER BY site'
    ).all<{ site: string }>();
    expect(rows.map((r) => r.site)).toEqual(['dead.example']);
  });

  it('rejects a malformed or oversized body', async () => {
    expect((await handleDiscoverSites(request({ sites: 'x' }), ENV)).status).toBe(400);
    expect((await handleDiscoverSites(request({ sites: [1] }), ENV)).status).toBe(400);
    const many = Array.from({ length: 41 }, (_, i) => `s${i}.example`);
    expect((await handleDiscoverSites(request({ sites: many }), ENV)).status).toBe(400);
  });
});
