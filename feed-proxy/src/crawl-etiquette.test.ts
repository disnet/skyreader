// The crawl path's manners, end to end through createApp: robots.txt gating
// (robots.ts) and the Web Bot Auth key directory route (web-bot-auth.ts).
import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createApp,
  initDatabase,
  hashUrl,
  BLOCKED_MESSAGE_MARKER,
  HONEST_UA,
  configureWebBotAuth,
  type AppConfig,
  type CacheRow,
} from './app';
import { RobotsPolicy } from './robots';
import { generateWebBotAuthKey, loadWebBotAuth } from './web-bot-auth';

const SECRET = { 'X-Proxy-Secret': 'test-secret' };
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>One</title><link>https://example.com/1</link><guid>1</guid></item></channel></rss>`;

function createTestApp(config: Partial<AppConfig> = {}) {
  const db = new Database(':memory:');
  initDatabase(db);
  const { app } = createApp(db, {
    proxySecret: 'test-secret',
    cacheTtlMs: 15 * 60 * 1000,
    staleTtlMs: 60 * 60 * 1000,
    defaultLimit: 100,
    ...config,
  });
  return { db, app };
}

function row(db: Database, url: string): CacheRow | null {
  return db.query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?').get(hashUrl(url));
}

describe('robots.txt on the crawl path', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => fetchMock?.mockRestore());

  // Feed fetches go through the (mocked) global fetch; robots.txt goes through
  // the policy's own injected fetch so the two are distinguishable.
  function robotsWith(text: string | null, calls: string[] = []) {
    return new RobotsPolicy({
      userAgent: HONEST_UA,
      fetch: async (url) => {
        calls.push(url);
        return text === null ? new Response('', { status: 404 }) : new Response(text);
      },
    });
  }
  // Different robots.txt per origin, for the redirect cases.
  function robotsPerOrigin(byOrigin: Record<string, string>, calls: string[] = []) {
    return new RobotsPolicy({
      userAgent: HONEST_UA,
      fetch: async (url) => {
        calls.push(url);
        const text = byOrigin[new URL(url).origin];
        return text === undefined ? new Response('', { status: 404 }) : new Response(text);
      },
    });
  }
  // Feed fetch that 301s `from` to `to` and serves RSS everywhere else.
  function mockRedirectingFeedFetch(from: string, to: string, seen: string[]) {
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      seen.push(String(url));
      return String(url) === from
        ? new Response(null, { status: 301, headers: { location: to } })
        : new Response(RSS, { status: 200 });
    }) as unknown as typeof fetch);
  }
  function mockFeedFetch(seen: string[]) {
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      seen.push(String(url));
      return new Response(RSS, { status: 200 });
    }) as unknown as typeof fetch);
  }

  it('records a disallowed feed as blocked and never fetches it', async () => {
    const robotsCalls: string[] = [];
    const { db, app } = createTestApp({
      robots: robotsWith('User-agent: *\nDisallow: /private/', robotsCalls),
    });
    const feedCalls: string[] = [];
    mockFeedFetch(feedCalls);

    const url = 'https://example.com/private/feed.xml';
    const res = await app.request(`/feed?url=${encodeURIComponent(url)}`, { headers: SECRET });

    expect(robotsCalls).toEqual(['https://example.com/robots.txt']);
    expect(feedCalls).toEqual([]);
    const cached = row(db, url);
    expect(cached?.error_count).toBe(1);
    expect(cached?.last_error).toContain(BLOCKED_MESSAGE_MARKER);
    expect(cached?.last_error).toContain('robots.txt');
    expect(cached?.last_error).toContain('Disallow: /private/');
    // Re-tried after a day, not the 7-day "permanent" bucket.
    const day = 24 * 60 * 60 * 1000;
    expect(cached!.next_retry_at! - Date.now()).toBeGreaterThan(day - 5000);
    expect(cached!.next_retry_at! - Date.now()).toBeLessThanOrEqual(day);
    // Second request: in backoff, still no upstream fetch, error surfaced.
    const again = await app.request(`/feed?url=${encodeURIComponent(url)}`, { headers: SECRET });
    expect(again.status).toBe(502);
    expect(((await again.json()) as { error: string }).error).toContain('robots.txt');
    expect(feedCalls).toEqual([]);
    expect(res.status).toBe(502);
  });

  it('fetches an allowed feed normally, checking robots.txt once per origin', async () => {
    const robotsCalls: string[] = [];
    const { db, app } = createTestApp({
      robots: robotsWith('User-agent: *\nDisallow: /private/', robotsCalls),
    });
    const feedCalls: string[] = [];
    mockFeedFetch(feedCalls);

    const a = 'https://example.com/feed.xml';
    const b = 'https://example.com/blog/rss';
    expect(
      (await app.request(`/feed?url=${encodeURIComponent(a)}`, { headers: SECRET })).status
    ).toBe(200);
    expect(
      (await app.request(`/feed?url=${encodeURIComponent(b)}`, { headers: SECRET })).status
    ).toBe(200);
    expect(feedCalls).toEqual([a, b]);
    expect(robotsCalls).toEqual(['https://example.com/robots.txt']);
    expect(row(db, a)?.error_count).toBe(0);
  });

  it('treats a missing robots.txt as no restrictions', async () => {
    const { app } = createTestApp({ robots: robotsWith(null) });
    const feedCalls: string[] = [];
    mockFeedFetch(feedCalls);
    const url = 'https://example.com/anything/feed.xml';
    expect(
      (await app.request(`/feed?url=${encodeURIComponent(url)}`, { headers: SECRET })).status
    ).toBe(200);
    expect(feedCalls).toEqual([url]);
  });

  it('defers (without an error) a fetch whose crawl-delay turn is too far off', async () => {
    // Crawl-delay 60s: the first fetch on the host goes now; the second would
    // wait 60s, beyond the crawl's patience, so it is deferred to the next
    // cycle — no upstream fetch, no error row.
    const { db, app } = createTestApp({ robots: robotsWith('User-agent: *\nCrawl-delay: 60') });
    const feedCalls: string[] = [];
    mockFeedFetch(feedCalls);
    const a = 'https://slow.example/a.xml';
    const b = 'https://slow.example/b.xml';
    expect(
      (await app.request(`/feed?url=${encodeURIComponent(a)}`, { headers: SECRET })).status
    ).toBe(200);
    await app.request(`/feed?url=${encodeURIComponent(b)}`, { headers: SECRET });
    expect(feedCalls).toEqual([a]);
    expect(row(db, b)).toBeNull();
  });

  // A redirect leaves the URL robots.txt was consulted for. The target's own
  // rules are the ones that govern it — checking only the pre-redirect URL is a
  // hole in exactly the sites that care about crawler standing.
  it('blocks a redirect into a path the target host disallows', async () => {
    const robotsCalls: string[] = [];
    const { db, app } = createTestApp({
      robots: robotsPerOrigin(
        {
          'https://a.example': 'User-agent: *\nDisallow:',
          'https://b.example': 'User-agent: *\nDisallow: /private/',
        },
        robotsCalls
      ),
    });
    const url = 'https://a.example/feed';
    const target = 'https://b.example/private/feed.xml';
    const feedCalls: string[] = [];
    mockRedirectingFeedFetch(url, target, feedCalls);

    const res = await app.request(`/feed?url=${encodeURIComponent(url)}`, { headers: SECRET });

    expect(res.status).toBe(502);
    // The disallowed target is never fetched.
    expect(feedCalls).toEqual([url]);
    expect(robotsCalls).toEqual(['https://a.example/robots.txt', 'https://b.example/robots.txt']);
    // Recorded like the pre-fetch disallow: blocked marker, daily re-check.
    const cached = row(db, url);
    expect(cached?.error_count).toBe(1);
    expect(cached?.last_error).toContain(BLOCKED_MESSAGE_MARKER);
    expect(cached?.last_error).toContain('b.example');
    expect(cached?.last_error).toContain('Disallow: /private/');
    const day = 24 * 60 * 60 * 1000;
    expect(cached!.next_retry_at! - Date.now()).toBeGreaterThan(day - 5000);
    expect(cached!.next_retry_at! - Date.now()).toBeLessThanOrEqual(day);
  });

  it('follows a redirect the target host allows', async () => {
    const { db, app } = createTestApp({
      robots: robotsPerOrigin({
        'https://a.example': 'User-agent: *\nDisallow:',
        'https://b.example': 'User-agent: *\nDisallow: /private/',
      }),
    });
    const url = 'https://a.example/feed';
    const target = 'https://b.example/public/feed.xml';
    const feedCalls: string[] = [];
    mockRedirectingFeedFetch(url, target, feedCalls);

    const res = await app.request(`/feed?url=${encodeURIComponent(url)}`, { headers: SECRET });

    expect(res.status).toBe(200);
    expect(feedCalls).toEqual([url, target]);
    expect(row(db, url)?.error_count).toBe(0);
  });

  it('does not gate the crawl when no policy is configured', async () => {
    const { app } = createTestApp();
    const feedCalls: string[] = [];
    mockFeedFetch(feedCalls);
    const url = 'https://example.com/private/feed.xml';
    expect(
      (await app.request(`/feed?url=${encodeURIComponent(url)}`, { headers: SECRET })).status
    ).toBe(200);
    expect(feedCalls).toEqual([url]);
  });
});

describe('GET /http-message-signatures-directory', () => {
  afterEach(() => configureWebBotAuth(null));

  it('is 404 until an identity is configured', async () => {
    const { app } = createTestApp({ webBotAuth: null });
    const res = await app.request('/http-message-signatures-directory', { headers: SECRET });
    expect(res.status).toBe(404);
  });

  it('requires the proxy secret', async () => {
    const { app } = createTestApp();
    expect((await app.request('/http-message-signatures-directory')).status).toBe(401);
  });

  it('serves the signed public-key directory', async () => {
    const jwk = await generateWebBotAuthKey();
    const webBotAuth = await loadWebBotAuth({
      key: JSON.stringify(jwk),
      signatureAgent: 'https://api.skyreader.app',
    });
    const { app } = createTestApp({ webBotAuth });
    const res = await app.request('/http-message-signatures-directory', { headers: SECRET });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/http-message-signatures-directory+json'
    );
    expect(res.headers.get('cache-control')).toBe('max-age=86400');
    expect(res.headers.get('signature-input')).toContain('tag="http-message-signatures-directory"');
    expect(res.headers.get('signature')).toMatch(/^sig1=:/);
    const body = (await res.json()) as { keys: Array<Record<string, string>> };
    expect(body.keys).toEqual([{ kty: 'OKP', crv: 'Ed25519', x: jwk.x! }]);
    // /stats reports the identity so ops can see signing is on.
    const stats = (await (await app.request('/stats', { headers: SECRET })).json()) as {
      crawler: { webBotAuth: { keyid: string } | null };
    };
    expect(stats.crawler.webBotAuth?.keyid).toBe(jwk.kid);
  });
});
