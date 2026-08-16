import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createApp,
  initDatabase,
  cleanupCache,
  hashUrl,
  classifyError,
  describeFetchFailure,
  calculateBackoff,
  FEED_PARSER_VERSION,
  FEED_ITEMS_CAP,
  writeFeedItems,
  type AppConfig,
  type CacheRow,
} from './app';

// Sample RSS feed for mocking
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <description>A test blog</description>
    <item>
      <title>Post 3</title>
      <link>https://example.com/post-3</link>
      <guid>guid-3</guid>
      <pubDate>Wed, 03 Jan 2024 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Post 2</title>
      <link>https://example.com/post-2</link>
      <guid>guid-2</guid>
      <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Post 1</title>
      <link>https://example.com/post-1</link>
      <guid>guid-1</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const DEFAULT_CONFIG: AppConfig = {
  proxySecret: 'test-secret',
  cacheTtlMs: 15 * 60 * 1000, // 15 min
  staleTtlMs: 60 * 60 * 1000, // 1 hour
  defaultLimit: 100,
};

function createTestApp(config: Partial<AppConfig> = {}) {
  const db = new Database(':memory:');
  initDatabase(db);
  const { app, inFlight, warmStaleFeeds } = createApp(db, {
    ...DEFAULT_CONFIG,
    ...config,
  });
  return { db, app, inFlight, warmStaleFeeds };
}

function mockFetch(responseFactory: () => Response) {
  return spyOn(globalThis, 'fetch').mockImplementation((async () => {
    return responseFactory();
  }) as unknown as typeof fetch);
}

function mockFetchOnce(body: string, init?: ResponseInit) {
  return mockFetch(() => new Response(body, init));
}

describe('Feed parser cache version migration', () => {
  it('marks legacy rows as unparsed and not yet attempted', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE cache (
        url_hash TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        parsed_json TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        cached_at INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at)
       VALUES ('legacy', 'https://example.com/legacy', '{}', 1, 1)`
    );

    initDatabase(db);

    const row = db
      .query<{ parser_version: number; parser_upgrade_attempted_version: number }, []>(
        `SELECT parser_version, parser_upgrade_attempted_version
         FROM cache WHERE url_hash = 'legacy'`
      )
      .get();
    expect(row?.parser_version).toBe(0);
    expect(row?.parser_upgrade_attempted_version).toBe(0);
  });
});

describe('Integration Tests', () => {
  let fetchMock: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchMock?.mockRestore();
  });

  describe('GET /health', () => {
    it('returns status ok without auth', async () => {
      const { app } = createTestApp();

      const res = await app.request('/health');
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.status).toBe('ok');
      expect(json.cachedFeeds).toBe(0);
      expect(json.timestamp).toBeTypeOf('number');
      // Deploy stamp the post-deploy smoke check asserts against; 'dev' when the
      // GIT_COMMIT_SHA build arg isn't set (local, tests).
      expect(json.version).toBe(process.env.GIT_COMMIT_SHA || 'dev');
    });

    it('reports cached feed count', async () => {
      const { db, app } = createTestApp();

      // Insert some cache entries
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        ['hash1', 'https://example.com/feed1', '{}', Date.now(), Date.now()]
      );
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        ['hash2', 'https://example.com/feed2', '{}', Date.now(), Date.now()]
      );

      const res = await app.request('/health');
      const json = await res.json();

      expect(json.cachedFeeds).toBe(2);
    });
  });

  describe('GET /stats', () => {
    it('requires auth when secret is configured', async () => {
      const { app } = createTestApp({ proxySecret: 'my-secret' });

      const res = await app.request('/stats');

      expect(res.status).toBe(401);
    });

    it('accepts valid auth header', async () => {
      const { app } = createTestApp({ proxySecret: 'my-secret' });

      const res = await app.request('/stats', {
        headers: { 'X-Proxy-Secret': 'my-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.total).toBe(0);
      expect(json.cacheTtlSeconds).toBe(900);
    });

    it('works without auth when no secret configured', async () => {
      const { app } = createTestApp({ proxySecret: undefined });

      const res = await app.request('/stats');

      expect(res.status).toBe(200);
    });
  });

  describe('GET /feed', () => {
    it('requires url parameter', async () => {
      const { app } = createTestApp();

      const res = await app.request('/feed', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('Missing url parameter');
    });

    it('validates url format', async () => {
      const { app } = createTestApp();

      const res = await app.request('/feed?url=not-a-url', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('Invalid url');
    });

    it('fetches and parses a feed', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetchOnce(SAMPLE_RSS, {
        headers: { 'Content-Type': 'application/rss+xml' },
      });

      const res = await app.request('/feed?url=https://example.com/feed.xml', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.feed.title).toBe('Test Blog');
      expect(json.feed.items).toHaveLength(3);
      expect(json.feed.items[0].guid).toBe('guid-3');
      expect(json.cache).toBe('MISS');
      expect(typeof json.cursor).toBe('number');
      expect(json.cursor).toBeGreaterThan(0);
      expect(typeof json.generation).toBe('string');
      expect(json.generation.length).toBeGreaterThan(0);
      expect(json.hasMore).toBe(false);
      expect(res.headers.get('X-Cache')).toBe('MISS');
    });

    it('returns cached feed on second request', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetchOnce(SAMPLE_RSS);

      // First request
      await app.request('/feed?url=https://example.com/feed.xml', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      // Second request - should hit cache
      const res = await app.request('/feed?url=https://example.com/feed.xml', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Cache')).toBe('HIT');
      expect(fetchMock).toHaveBeenCalledTimes(1); // Only one fetch
    });

    it('filters items by since_guids', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetchOnce(SAMPLE_RSS);

      const res = await app.request('/feed?url=https://example.com/feed.xml&since_guids=guid-2', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.feed.items).toHaveLength(1); // Only guid-3 (newer than guid-2)
      expect(json.feed.items[0].guid).toBe('guid-3');
      expect(json.returnedItems).toBe(1);
      // since_guids resolves to a boundary seq, then drains forward by cursor.
      expect(json.cursor).toBeGreaterThan(0);
      expect(json.hasMore).toBe(false);
      expect(res.headers.get('X-Returned-Items')).toBe('1');
    });

    it('respects limit parameter', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetchOnce(SAMPLE_RSS);

      const res = await app.request('/feed?url=https://example.com/feed.xml&limit=2', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(json.feed.items).toHaveLength(2);
    });

    it('handles 304 Not Modified', async () => {
      const { db, app } = createTestApp({
        cacheTtlMs: 1000, // 1 second - so our cache is stale
        staleTtlMs: 60 * 60 * 1000, // 1 hour
      });

      const feedUrl = 'https://example.com/feed.xml';
      const urlHash = hashUrl(feedUrl);

      // Pre-populate cache with stale data (fetched 5 seconds ago)
      const cachedFeed = {
        title: 'Cached Blog',
        items: [
          {
            guid: 'cached-1',
            url: '',
            title: 'Cached',
            publishedAt: new Date().toISOString(),
          },
        ],
        fetchedAt: Date.now() - 5000,
      };
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, etag, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          urlHash,
          feedUrl,
          JSON.stringify(cachedFeed),
          '"etag-123"',
          Date.now() - 5000,
          Date.now() - 5000,
        ]
      );

      fetchMock = mockFetch(() => new Response(null, { status: 304 }));

      const res = await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.feed.title).toBe('Cached Blog');
    });

    it('reparses and re-delivers current items after a parser upgrade', async () => {
      const { db, app } = createTestApp();
      const feedUrl = 'https://example.com/arxiv.xml';
      const urlHash = hashUrl(feedUrl);
      const publishedAt = new Date().toISOString();
      const oldFeed = {
        title: 'Physics',
        items: [
          {
            guid: 'math-1',
            url: 'https://example.com/math-1',
            title: 'Math',
            summary: 'Using $10.09\\times10^{9}$ events.',
            publishedAt,
          },
        ],
        fetchedAt: Date.now(),
      };

      db.run(
        `INSERT INTO cache
          (url_hash, url, parsed_json, parser_version, etag, cached_at, fetched_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`,
        [urlHash, feedUrl, JSON.stringify(oldFeed), '"old-etag"', Date.now(), Date.now()]
      );
      writeFeedItems(db, urlHash, oldFeed.items, Date.now());
      const oldCursor = db
        .query<
          { seq: number },
          [string]
        >('SELECT seq FROM feed_items WHERE url_hash = ? AND guid = "math-1"')
        .get(urlHash)?.seq;
      const generation = db
        .query<{ value: string }, []>(`SELECT value FROM sync_state WHERE key = 'items_generation'`)
        .get()?.value;

      const refreshedRss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Physics</title>
<item><title>Math</title><link>https://example.com/math-1</link><guid>math-1</guid>
<description>Using $10.09\\times10^{9}$ events.</description>
<pubDate>${new Date(publishedAt).toUTCString()}</pubDate></item>
</channel></rss>`;
      let requestHeaders: Headers | undefined;
      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(refreshedRss, { headers: { ETag: '"new-etag"' } });
      }) as typeof fetch);

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: { 'X-Proxy-Secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feeds: [{ url: feedUrl, since_seq: oldCursor, generation }],
        }),
      });
      const json = (await res.json()).feeds[feedUrl];

      expect(requestHeaders?.has('If-None-Match')).toBe(false);
      expect(json.feed.items).toHaveLength(1);
      expect(json.feed.items[0].summary).toContain('<math');
      expect(json.feed.items[0].summary).toContain('<mo>×</mo>');
      expect(json.cursor).toBeGreaterThan(oldCursor ?? 0);

      const cache = db
        .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
        .get(urlHash);
      expect(cache?.parser_version).toBe(FEED_PARSER_VERSION);
    });

    it('bypasses an older error backoff once to perform a parser upgrade', async () => {
      const { db, app } = createTestApp();
      const feedUrl = 'https://example.com/arxiv-backoff.xml';
      const urlHash = hashUrl(feedUrl);
      const oldFeed = {
        title: 'Physics',
        items: [
          {
            guid: 'math-backoff',
            url: 'https://example.com/math-backoff',
            title: 'Math',
            summary: 'Using $x^2$.',
            publishedAt: new Date().toISOString(),
          },
        ],
        fetchedAt: Date.now(),
      };

      db.run(
        `INSERT INTO cache
          (url_hash, url, parsed_json, parser_version, etag, cached_at, fetched_at,
           error_count, last_error, last_error_at, next_retry_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, 1, 'HTTP 500', ?, ?)`,
        [
          urlHash,
          feedUrl,
          JSON.stringify(oldFeed),
          '"old-etag"',
          Date.now(),
          Date.now(),
          Date.now(),
          Date.now() + 60 * 60 * 1000,
        ]
      );

      let requestHeaders: Headers | undefined;
      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>Physics</title>
           <item><title>Math</title><link>https://example.com/math-backoff</link>
           <guid>math-backoff</guid><description>Using $x^2$.</description></item>
           </channel></rss>`
        );
      }) as typeof fetch);

      const res = await app.request(`/feed?url=${encodeURIComponent(feedUrl)}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(requestHeaders?.has('If-None-Match')).toBe(false);
      expect(json.feed.items[0].summary).toContain('<math');

      const cache = db
        .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
        .get(urlHash);
      expect(cache?.parser_version).toBe(FEED_PARSER_VERSION);
      expect(cache?.parser_upgrade_attempted_version).toBe(FEED_PARSER_VERSION);
      expect(cache?.next_retry_at).toBeNull();
    });

    it('resumes backoff after a failed parser-upgrade attempt', async () => {
      const { db, app } = createTestApp();
      const feedUrl = 'https://example.com/arxiv-upgrade-fails.xml';
      const urlHash = hashUrl(feedUrl);
      const oldFeed = {
        title: 'Physics',
        items: [
          {
            guid: 'math-failure',
            url: 'https://example.com/math-failure',
            title: 'Math',
            summary: 'Using $x^2$.',
            publishedAt: new Date().toISOString(),
          },
        ],
        fetchedAt: Date.now(),
      };

      db.run(
        `INSERT INTO cache
          (url_hash, url, parsed_json, parser_version, cached_at, fetched_at,
           error_count, last_error, last_error_at, next_retry_at)
         VALUES (?, ?, ?, 0, ?, ?, 1, 'HTTP 500', ?, ?)`,
        [
          urlHash,
          feedUrl,
          JSON.stringify(oldFeed),
          Date.now(),
          Date.now(),
          Date.now(),
          Date.now() + 60 * 60 * 1000,
        ]
      );

      let fetchCalls = 0;
      fetchMock = mockFetch(() => {
        fetchCalls++;
        return new Response('Unavailable', { status: 503 });
      });

      const first = await app.request(`/feed?url=${encodeURIComponent(feedUrl)}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const second = await app.request(`/feed?url=${encodeURIComponent(feedUrl)}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(fetchCalls).toBe(1);

      const cache = db
        .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
        .get(urlHash);
      expect(cache?.parser_version).toBe(0);
      expect(cache?.parser_upgrade_attempted_version).toBe(FEED_PARSER_VERSION);
      expect(cache?.next_retry_at).toBeGreaterThan(Date.now());
    });

    it('backfills the durable log from the blob when feed_items is empty', async () => {
      // Regression: a feed first cached before retention existed has a cache row
      // but no feed_items rows. The write path only runs on a 200 parse, so a feed
      // served from cache (HIT — no upstream fetch at all) or that 304s never
      // populates the log. That pins the client to the blob fallback (cursor=null),
      // so it keeps sending since_guids and never advances to the seq cursor — the
      // feed effectively re-delivers its whole self every poll. readFeedItems must
      // seed the log from the blob and return a real cursor, even on a pure HIT.
      const { db, app } = createTestApp({
        cacheTtlMs: 15 * 60 * 1000, // fresh → cache HIT, no upstream fetch
        staleTtlMs: 60 * 60 * 1000,
      });

      const feedUrl = 'https://example.com/legacy.xml';
      const urlHash = hashUrl(feedUrl);

      const cachedFeed = {
        title: 'Legacy Blog',
        items: [
          { guid: 'a', url: '', title: 'A', publishedAt: new Date().toISOString() },
          { guid: 'b', url: '', title: 'B', publishedAt: new Date().toISOString() },
        ],
        fetchedAt: Date.now(),
      };
      // Fresh cache row WITHOUT any feed_items rows (the pre-retention state).
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        [urlHash, feedUrl, JSON.stringify(cachedFeed), Date.now(), Date.now()]
      );

      const before = db
        .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM feed_items WHERE url_hash = ?')
        .get(urlHash);
      expect(before?.c).toBe(0);

      // No upstream fetch should happen on a HIT; fail loudly if it does.
      fetchMock = mockFetch(() => {
        throw new Error('unexpected upstream fetch on cache HIT');
      });

      const res = await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.cache).toBe('HIT');
      // feed_items is now seeded, so the response carries a real cursor instead
      // of omitting it (which kept the client on since_guids).
      const after = db
        .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM feed_items WHERE url_hash = ?')
        .get(urlHash);
      expect(after?.c).toBe(2);
      expect(json.cursor).toBeGreaterThan(0);
      expect(json.generation).toBeTruthy();
    });

    it('a since_guids poll backfills then drains to the cursor on the next poll', async () => {
      // End-to-end of the stuck-feed fix: poll 1 arrives with since_guids (client
      // has no cursor) against a HIT-cached feed whose log is empty. It must seed
      // the log and hand back a cursor; poll 2 (now on since_seq) must return
      // nothing new rather than the whole feed again.
      const { db, app } = createTestApp();

      const feedUrl = 'https://example.com/legacy2.xml';
      const urlHash = hashUrl(feedUrl);

      const cachedFeed = {
        title: 'Legacy Blog',
        items: [
          { guid: 'a', url: '', title: 'A', publishedAt: new Date().toISOString() },
          { guid: 'b', url: '', title: 'B', publishedAt: new Date().toISOString() },
          { guid: 'c', url: '', title: 'C', publishedAt: new Date().toISOString() },
        ],
        fetchedAt: Date.now(),
      };
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        [urlHash, feedUrl, JSON.stringify(cachedFeed), Date.now(), Date.now()]
      );
      fetchMock = mockFetch(() => {
        throw new Error('unexpected upstream fetch on cache HIT');
      });

      const poll = async (body: object) => {
        const res = await app.request('/feeds', {
          method: 'POST',
          headers: { 'X-Proxy-Secret': 'test-secret', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return (await res.json()).feeds[feedUrl];
      };

      // Poll 1: client sends its newest GUID, no cursor yet.
      const p1 = await poll({ feeds: [{ url: feedUrl, since_guids: ['c'] }] });
      expect(p1.cursor).toBeGreaterThan(0);
      expect(p1.generation).toBeTruthy();

      // Poll 2: now on the cursor — the feed is fully drained, nothing new.
      const p2 = await poll({
        feeds: [{ url: feedUrl, since_seq: p1.cursor, generation: p1.generation }],
      });
      expect(p2.feed.items.length).toBe(0);
      expect(p2.cursor).toBe(p1.cursor);
    });

    it('returns 502 with error details when feed fetch fails', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetch(() => new Response('Server Error', { status: 500 }));

      const res = await app.request('/feed?url=https://example.com/feed.xml', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(502);
      expect(json.feed).toBeNull();
      expect(json.cache).toBe('ERROR');
      expect(json.filter).toBe('NONE');
      expect(json.error).toBe('HTTP 500');
      expect(json.errorCount).toBe(1);
      expect(json.nextRetryAt).toBeGreaterThan(Date.now());
    });

    it('stores and uses ETag for conditional requests', async () => {
      const { db, app } = createTestApp({
        cacheTtlMs: 1000, // 1 second - cache becomes stale quickly
        staleTtlMs: 60 * 60 * 1000, // 1 hour
      });

      const feedUrl = 'https://example.com/feed.xml';
      const urlHash = hashUrl(feedUrl);

      // Pre-populate with stale cache that has an ETag
      const cachedFeed = {
        title: 'Old Feed',
        items: [],
        fetchedAt: Date.now() - 5000,
      };
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, etag, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          urlHash,
          feedUrl,
          JSON.stringify(cachedFeed),
          '"test-etag-123"',
          Date.now() - 5000,
          Date.now() - 5000,
        ]
      );

      // Mock fetch to capture the request headers
      let requestHeaders: Headers | undefined;
      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
        url: unknown,
        init?: RequestInit
      ) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(null, { status: 304 });
      }) as typeof fetch);

      await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      expect(requestHeaders?.get('If-None-Match')).toBe('"test-etag-123"');
    });
  });

  describe('POST /feeds', () => {
    it('requires urls or feeds array', async () => {
      const { app } = createTestApp();

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: {
          'X-Proxy-Secret': 'test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('Missing urls or feeds array');
    });

    it('rejects empty request', async () => {
      const { app } = createTestApp();

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: {
          'X-Proxy-Secret': 'test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ urls: [] }),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('Empty request');
    });

    it('limits bulk requests to 50', async () => {
      const { app } = createTestApp();

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: {
          'X-Proxy-Secret': 'test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          urls: Array.from({ length: 51 }, (_, i) => `https://example.com/feed${i}.xml`),
        }),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('Too many feeds (max 50)');
    });

    it('fetches multiple feeds with urls format', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: {
          'X-Proxy-Secret': 'test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          urls: ['https://example.com/feed1.xml', 'https://example.com/feed2.xml'],
        }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.feeds['https://example.com/feed1.xml'].feed.title).toBe('Test Blog');
      expect(json.feeds['https://example.com/feed2.xml'].feed.title).toBe('Test Blog');
      expect(json.feeds['https://example.com/feed1.xml'].cache).toBe('MISS');
    });

    it('supports per-feed filtering with feeds format', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: {
          'X-Proxy-Secret': 'test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          feeds: [
            { url: 'https://example.com/feed1.xml', since_guids: ['guid-2'] },
            { url: 'https://example.com/feed2.xml', limit: 1 },
          ],
        }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.feeds['https://example.com/feed1.xml'].returnedItems).toBe(1);
      expect(json.feeds['https://example.com/feed1.xml'].feed.items[0].guid).toBe('guid-3');
      expect(json.feeds['https://example.com/feed2.xml'].returnedItems).toBe(1);
    });

    it('handles invalid URLs in bulk request', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: {
          'X-Proxy-Secret': 'test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          urls: ['https://example.com/valid.xml', 'not-a-url'],
        }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.feeds['https://example.com/valid.xml'].feed).not.toBeNull();
      expect(json.feeds['not-a-url'].error).toBe('Invalid URL');
      expect(json.feeds['not-a-url'].cache).toBe('INVALID');
    });
  });

  describe('POST /feeds — batch latency bound', () => {
    // A promise we resolve on demand, to model an upstream feed that hangs well
    // past the inline budget. While it's pending the batch can only return by
    // hitting the budget — so each of these tests would hang (and fail) if the
    // cap were removed and the handler awaited the full 30s fetch.
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('caps how long one slow feed blocks the batch, and never blocks a fast feed', async () => {
      const { app, inFlight } = createTestApp({ batchInlineFetchBudgetMs: 50 });

      const slowUrl = 'https://example.com/slow.xml';
      const fastUrl = 'https://example.com/fast.xml';
      const slow = deferred<void>();

      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
        if (String(input).includes('slow')) await slow.promise; // hangs > budget
        return new Response(SAMPLE_RSS);
      }) as unknown as typeof fetch);

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: { 'X-Proxy-Secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [slowUrl, fastUrl] }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);

      // The fast feed is unaffected by its slow neighbour in the same batch.
      expect(json.feeds[fastUrl].feed.title).toBe('Test Blog');
      expect(json.feeds[fastUrl].cache).toBe('MISS');

      // The slow feed returns no content yet — but crucially with NO error
      // backoff poisoned (errorCount 0, no nextRetryAt), so it self-heals next
      // poll rather than entering a retry delay.
      expect(json.feeds[slowUrl].feed).toBeNull();
      expect(json.feeds[slowUrl].nextRetryAt).toBeUndefined();
      expect(json.feeds[slowUrl].errorCount ?? 0).toBe(0);

      // The fetch is still running in the background and warms the cache: once
      // it finishes, the next poll for that feed is a plain HIT.
      const bg = inFlight.get(hashUrl(slowUrl));
      expect(bg).toBeDefined();
      slow.resolve();
      await bg;

      const res2 = await app.request('/feeds', {
        method: 'POST',
        headers: { 'X-Proxy-Secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [slowUrl] }),
      });
      const json2 = await res2.json();
      expect(json2.feeds[slowUrl].feed.title).toBe('Test Blog');
      expect(json2.feeds[slowUrl].cache).toBe('HIT');
    });

    it('serves past-stale content (not a hang) when the refresh exceeds the budget', async () => {
      const { db, app, inFlight } = createTestApp({
        batchInlineFetchBudgetMs: 50,
        cacheTtlMs: 1000,
        staleTtlMs: 2000,
      });

      const url = 'https://example.com/stale-slow.xml';
      const urlHash = hashUrl(url);
      const slow = deferred<void>();

      // Prior content fetched long enough ago to be past staleTtl, so the serve
      // path falls through to an inline refresh instead of returning it directly.
      const old = {
        title: 'Old Title',
        items: [
          { guid: 'old-1', url: '', title: 'Old Post', publishedAt: new Date().toISOString() },
        ],
        fetchedAt: Date.now() - 10_000,
      };
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        [urlHash, url, JSON.stringify(old), Date.now() - 10_000, Date.now() - 10_000]
      );

      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
        await slow.promise;
        return new Response(SAMPLE_RSS);
      }) as unknown as typeof fetch);

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: { 'X-Proxy-Secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [url] }),
      });
      const json = await res.json();

      // Budget expired, but we have prior content — serve it as STALE rather
      // than blocking on the refresh.
      expect(res.status).toBe(200);
      expect(json.feeds[url].cache).toBe('STALE');
      expect(json.feeds[url].feed.title).toBe('Old Title');

      const bg = inFlight.get(urlHash);
      expect(bg).toBeDefined();
      slow.resolve();
      await bg;
    });

    it('coalesces concurrent batches missing the same feed onto one upstream fetch', async () => {
      const { app, inFlight } = createTestApp({ batchInlineFetchBudgetMs: 50 });

      const url = 'https://example.com/coalesce.xml';
      const slow = deferred<void>();
      let upstreamCalls = 0;

      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
        upstreamCalls++;
        await slow.promise;
        return new Response(SAMPLE_RSS);
      }) as unknown as typeof fetch);

      const headers = { 'X-Proxy-Secret': 'test-secret', 'Content-Type': 'application/json' };
      const body = JSON.stringify({ urls: [url] });
      const [r1, r2] = await Promise.all([
        app.request('/feeds', { method: 'POST', headers, body }),
        app.request('/feeds', { method: 'POST', headers, body }),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      // Both batches missed the same cold feed but shared a single upstream
      // fetch via the in-flight map (the inline path used to bypass it).
      expect(upstreamCalls).toBe(1);

      const bg = inFlight.get(hashUrl(url));
      expect(bg).toBeDefined();
      slow.resolve();
      await bg;
    });
  });

  describe('Cache behavior', () => {
    it('serves stale cache while refreshing', async () => {
      const { db, app, inFlight } = createTestApp({
        cacheTtlMs: 1000, // 1 second
        staleTtlMs: 60000, // 1 minute
      });

      const feedUrl = 'https://example.com/stale.xml';
      const urlHash = hashUrl(feedUrl);

      // Pre-populate with stale cache (fetched 5 seconds ago)
      const cachedFeed = {
        title: 'Stale Feed',
        items: [
          {
            guid: 'stale-1',
            url: '',
            title: 'Stale Post',
            publishedAt: new Date().toISOString(),
          },
        ],
        fetchedAt: Date.now() - 5000,
      };
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        [urlHash, feedUrl, JSON.stringify(cachedFeed), Date.now() - 5000, Date.now() - 5000]
      );

      // Mock fetch with delay to simulate network
      let fetchCalled = false;
      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
        fetchCalled = true;
        await new Promise((r) => setTimeout(r, 100));
        return new Response(SAMPLE_RSS);
      }) as unknown as typeof fetch);

      const res = await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      // Should return stale cache immediately
      expect(res.status).toBe(200);
      expect(json.feed.title).toBe('Stale Feed');
      expect(json.cache).toBe('STALE');
      expect(res.headers.get('X-Cache')).toBe('STALE');

      // Background refresh should have been triggered
      expect(inFlight.size).toBeGreaterThan(0);

      // Wait for background refresh
      await Promise.all(inFlight.values());
      expect(fetchCalled).toBe(true);
    });
  });

  describe('cleanupCache', () => {
    it('removes entries older than 7 days', () => {
      const db = new Database(':memory:');
      initDatabase(db);

      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
      const sixDaysAgo = now - 6 * 24 * 60 * 60 * 1000;

      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        ['old', 'https://example.com/old', '{}', eightDaysAgo, eightDaysAgo]
      );
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        ['recent', 'https://example.com/recent', '{}', sixDaysAgo, sixDaysAgo]
      );

      const cleaned = cleanupCache(db);

      expect(cleaned).toBe(1);

      const remaining = db
        .query<{ count: number }, []>('SELECT COUNT(*) as count FROM cache')
        .get();
      expect(remaining?.count).toBe(1);
    });
  });

  describe('since_guids cursor compat', () => {
    it('cold-starts (returns the recent slice) when no GUID matches', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetchOnce(SAMPLE_RSS);

      const res = await app.request(
        '/feed?url=https://example.com/feed.xml&since_guids=unknown-guid',
        { headers: { 'X-Proxy-Secret': 'test-secret' } }
      );
      const json = await res.json();

      // Unmatched GUIDs resolve to no boundary → cold start (all 3 items).
      expect(json.feed.items).toHaveLength(3);
      expect(json.cursor).toBeGreaterThan(0);
    });

    it('returns empty array when the newest GUID is the boundary', async () => {
      const { app } = createTestApp();
      fetchMock = mockFetchOnce(SAMPLE_RSS);

      const res = await app.request('/feed?url=https://example.com/feed.xml&since_guids=guid-3', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      // guid-3 is the newest → boundary is the max seq → nothing newer to drain.
      expect(json.feed.items).toHaveLength(0);
      expect(json.hasMore).toBe(false);
    });
  });

  describe('Error classification', () => {
    it('classifies 429/500/502/503/504 as transient', () => {
      expect(classifyError(429)).toBe('transient');
      expect(classifyError(500)).toBe('transient');
      expect(classifyError(502)).toBe('transient');
      expect(classifyError(503)).toBe('transient');
      expect(classifyError(504)).toBe('transient');
    });

    it('classifies 401/403/404/410 as permanent', () => {
      expect(classifyError(401)).toBe('permanent');
      expect(classifyError(403)).toBe('permanent');
      expect(classifyError(404)).toBe('permanent');
      expect(classifyError(410)).toBe('permanent');
    });

    it('classifies other status codes as recoverable', () => {
      expect(classifyError(400)).toBe('recoverable');
      expect(classifyError(405)).toBe('recoverable');
      expect(classifyError(408)).toBe('recoverable');
      expect(classifyError(418)).toBe('recoverable');
    });
  });

  describe('describeFetchFailure', () => {
    it('flags a 403 as blocked with a site-specific message', () => {
      const { error, blocked } = describeFetchFailure(403, 'https://www.cbc.ca/news');
      expect(blocked).toBe(true);
      expect(error).toContain('www.cbc.ca');
      expect(error).toContain('blocking automated access');
      expect(error).toContain('403');
    });

    it('does not flag other failures as blocked', () => {
      expect(describeFetchFailure(500, 'https://example.com').blocked).toBe(false);
      expect(describeFetchFailure(404, 'https://example.com').blocked).toBe(false);
      expect(describeFetchFailure(429, 'https://example.com').blocked).toBe(false);
    });

    it('falls back to the raw url when it cannot be parsed as a host', () => {
      const { error } = describeFetchFailure(500, 'not-a-url');
      expect(error).toBe('Failed to fetch not-a-url: HTTP 500');
    });
  });

  describe('Backoff calculation', () => {
    it('calculates exponential backoff', () => {
      const BASE = 5 * 60 * 1000; // 5 minutes
      expect(calculateBackoff(0)).toBe(BASE); // 5 min
      expect(calculateBackoff(1)).toBe(BASE * 2); // 10 min
      expect(calculateBackoff(2)).toBe(BASE * 4); // 20 min
      expect(calculateBackoff(3)).toBe(BASE * 8); // 40 min
    });

    it('caps at 24 hours', () => {
      const MAX = 24 * 60 * 60 * 1000;
      expect(calculateBackoff(10)).toBe(MAX);
      expect(calculateBackoff(20)).toBe(MAX);
    });
  });

  describe('Error handling and backoff', () => {
    it('tracks error on HTTP 500', async () => {
      const { db, app } = createTestApp();
      fetchMock = mockFetch(() => new Response('Server Error', { status: 500 }));

      const feedUrl = 'https://example.com/error.xml';
      const urlHash = hashUrl(feedUrl);

      await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      const cached = db
        .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
        .get(urlHash);
      expect(cached?.error_count).toBe(1);
      expect(cached?.last_error).toBe('HTTP 500');
      expect(cached?.next_retry_at).toBeGreaterThan(Date.now());
    });

    it('increments error count on subsequent failures', async () => {
      const { db, app } = createTestApp({
        cacheTtlMs: 1, // Very short TTL so cache is immediately stale
        staleTtlMs: 60 * 60 * 1000,
      });
      fetchMock = mockFetch(() => new Response('Server Error', { status: 503 }));

      const feedUrl = 'https://example.com/error2.xml';
      const urlHash = hashUrl(feedUrl);

      // First failure
      await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      // Get the first next_retry_at and clear it to allow another fetch
      const first = db
        .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
        .get(urlHash);
      expect(first?.error_count).toBe(1);
      const firstBackoff = first?.next_retry_at;

      // Clear backoff and make cache stale to allow second fetch
      db.run('UPDATE cache SET next_retry_at = NULL, fetched_at = ? WHERE url_hash = ?', [
        Date.now() - 10000,
        urlHash,
      ]);

      // Second failure
      await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      const second = db
        .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
        .get(urlHash);
      expect(second?.error_count).toBe(2);
      // Second backoff should be longer (exponential)
      expect(second?.next_retry_at).toBeGreaterThan(firstBackoff!);
    });

    it('skips fetch when in backoff period (circuit breaker)', async () => {
      const { db, app } = createTestApp();

      const feedUrl = 'https://example.com/backoff.xml';
      const urlHash = hashUrl(feedUrl);

      // Pre-populate cache with a feed in backoff
      const cachedFeed = {
        title: 'Backoff Feed',
        items: [
          {
            guid: 'backoff-1',
            url: '',
            title: 'Post',
            publishedAt: new Date().toISOString(),
          },
        ],
        fetchedAt: Date.now(),
      };
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          urlHash,
          feedUrl,
          JSON.stringify(cachedFeed),
          Date.now(),
          Date.now(),
          3,
          'HTTP 500',
          Date.now() + 60000,
        ]
      );

      // Mock fetch - should NOT be called
      let fetchCalled = false;
      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
        fetchCalled = true;
        return new Response(SAMPLE_RSS);
      }) as unknown as typeof fetch);

      const res = await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.feed.title).toBe('Backoff Feed');
      expect(fetchCalled).toBe(false);
    });

    it('resets error count on successful fetch', async () => {
      const { db, app, inFlight } = createTestApp({
        cacheTtlMs: 1, // Very short TTL so cache is immediately stale
        staleTtlMs: 60 * 60 * 1000,
      });

      const feedUrl = 'https://example.com/recover.xml';
      const urlHash = hashUrl(feedUrl);

      // Pre-populate cache with errors (backoff has expired, cache is stale)
      const cachedFeed = {
        title: 'Old Feed',
        items: [],
        fetchedAt: Date.now() - 10000,
      };
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          urlHash,
          feedUrl,
          JSON.stringify(cachedFeed),
          Date.now() - 10000,
          Date.now() - 10000,
          3,
          'HTTP 500',
          Date.now() - 1000,
        ] // backoff expired
      );

      // Mock successful fetch
      fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

      await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      // Stale cache is served immediately and refreshed in the background; wait for
      // that refresh to settle before asserting the reset error tracking.
      await Promise.all(inFlight.values());

      const cached = db
        .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
        .get(urlHash);
      expect(cached?.error_count).toBe(0);
      expect(cached?.last_error).toBeNull();
      expect(cached?.next_retry_at).toBeNull();
    });

    it('sets long backoff for permanent errors (403)', async () => {
      const { db, app } = createTestApp();
      fetchMock = mockFetch(() => new Response('Forbidden', { status: 403 }));

      const feedUrl = 'https://example.com/forbidden.xml';
      const urlHash = hashUrl(feedUrl);

      await app.request(`/feed?url=${feedUrl}`, {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });

      const cached = db
        .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
        .get(urlHash);
      expect(cached?.error_count).toBe(1);
      expect(cached?.last_error).toContain('blocking automated access');
      // Permanent error should have 7-day backoff
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const expectedMin = Date.now() + sevenDaysMs - 1000;
      expect(cached?.next_retry_at).toBeGreaterThan(expectedMin);
    });

    it('includes error stats in /stats endpoint', async () => {
      const { db, app } = createTestApp();

      // Insert some feeds with errors
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'error1',
          'https://example.com/err1',
          '{}',
          Date.now(),
          Date.now(),
          2,
          'HTTP 500',
          Date.now() + 60000,
        ]
      );
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'error2',
          'https://example.com/err2',
          '{}',
          Date.now(),
          Date.now(),
          5,
          'HTTP 403',
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ]
      );
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count)
				VALUES (?, ?, ?, ?, ?, ?)`,
        ['healthy', 'https://example.com/ok', '{}', Date.now(), Date.now(), 0]
      );

      const res = await app.request('/stats', {
        headers: { 'X-Proxy-Secret': 'test-secret' },
      });
      const json = await res.json();

      expect(json.errors).toBeDefined();
      expect(json.errors.total).toBe(2); // Both error feeds
      expect(json.errors.inBackoff).toBe(2); // Both in backoff
    });

    it('returns error info in bulk feed response for real content with errors', async () => {
      const { db, app } = createTestApp({
        cacheTtlMs: 1, // Very short TTL
        staleTtlMs: 2, // Very short stale TTL so cache is expired
      });

      const feedUrl = 'https://example.com/bulk-error.xml';
      const urlHash = hashUrl(feedUrl);

      // Pre-populate with REAL content that has error state, expired backoff, and expired cache
      const realFeed = {
        title: 'Real Feed',
        items: [
          {
            guid: 'item-1',
            url: '',
            title: 'Post',
            publishedAt: new Date().toISOString(),
          },
        ],
        fetchedAt: Date.now() - 1000,
      };
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          urlHash,
          feedUrl,
          JSON.stringify(realFeed),
          Date.now() - 1000,
          Date.now() - 1000,
          3,
          'HTTP 500',
          Date.now() - 1000,
          Date.now() - 1,
        ] // backoff expired
      );

      // Mock that returns error for any actual fetch
      fetchMock = mockFetch(() => new Response('Error', { status: 500 }));

      const res = await app.request('/feeds', {
        method: 'POST',
        headers: {
          'X-Proxy-Secret': 'test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ urls: [feedUrl] }),
      });
      const json = await res.json();

      // Feed returns cached real content (MISS because cache was expired) but includes error info
      expect(json.feeds[feedUrl].cache).toBe('MISS');
      expect(json.feeds[feedUrl].feed).not.toBeNull();
      expect(json.feeds[feedUrl].feed.title).toBe('Real Feed');
      expect(json.feeds[feedUrl].error).toContain('HTTP 500');
      expect(json.feeds[feedUrl].errorCount).toBe(4); // incremented from 3
      expect(json.feeds[feedUrl].nextRetryAt).toBeGreaterThan(Date.now());
    });
  });

  describe('Cached error placeholder handling', () => {
    describe('GET /feed - empty placeholder errors', () => {
      it('returns ERROR on first 404 fetch', async () => {
        const { app } = createTestApp();
        fetchMock = mockFetch(() => new Response('Not Found', { status: 404 }));

        const res = await app.request('/feed?url=https://example.com/missing.xml', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(502);
        expect(json.feed).toBeNull();
        expect(json.cache).toBe('ERROR');
        expect(json.error).toBe('HTTP 404');
        expect(json.errorCount).toBe(1);
        expect(json.nextRetryAt).toBeGreaterThan(Date.now());
      });

      it('returns ERROR on second request after 404 (not HIT with empty feed)', async () => {
        const { app } = createTestApp();
        fetchMock = mockFetch(() => new Response('Not Found', { status: 404 }));

        const feedUrl = 'https://example.com/missing-feed.xml';

        // First request - creates error placeholder
        const first = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        expect((await first.json()).cache).toBe('ERROR');

        // Second request - should still return ERROR, not HIT with empty feed
        const second = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await second.json();

        expect(second.status).toBe(502);
        expect(json.feed).toBeNull();
        expect(json.cache).toBe('ERROR');
        expect(json.error).toBe('HTTP 404');
        expect(json.errorCount).toBe(1); // Same count, no new fetch attempted
      });

      it('returns ERROR for all permanent error codes (401, 403, 404, 410)', async () => {
        const permanentCodes = [401, 403, 404, 410];

        for (const status of permanentCodes) {
          const { app } = createTestApp();
          fetchMock = mockFetch(() => new Response('Error', { status }));

          const feedUrl = `https://example.com/perm-${status}.xml`;

          // First request
          await app.request(`/feed?url=${feedUrl}`, {
            headers: { 'X-Proxy-Secret': 'test-secret' },
          });

          // Second request - should return ERROR
          const res = await app.request(`/feed?url=${feedUrl}`, {
            headers: { 'X-Proxy-Secret': 'test-secret' },
          });
          const json = await res.json();

          expect(res.status).toBe(502);
          expect(json.cache).toBe('ERROR');
          // A 403 gets an explanatory "blocked" message; others stay compact.
          if (status === 403) {
            expect(json.error).toContain('blocking automated access');
            expect(json.error).toContain('403');
          } else {
            expect(json.error).toBe(`HTTP ${status}`);
          }

          fetchMock?.mockRestore();
        }
      });

      it('returns ERROR for network errors that create empty placeholder', async () => {
        const { app } = createTestApp();
        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch);

        const feedUrl = 'https://example.com/network-error.xml';

        // First request - creates error placeholder
        await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });

        // Second request - should return ERROR, not empty feed as HIT
        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(502);
        expect(json.cache).toBe('ERROR');
        expect(json.error).toContain('Network error');
      });

      it('serves stale content when feed had real content before errors', async () => {
        const { db, app } = createTestApp();

        const feedUrl = 'https://example.com/was-working.xml';
        const urlHash = hashUrl(feedUrl);

        // Pre-populate with REAL content (not empty) that's in error backoff
        const realFeed = {
          title: 'Real Feed Title',
          items: [
            {
              guid: 'item-1',
              url: 'https://example.com/1',
              title: 'Real Post',
              publishedAt: new Date().toISOString(),
            },
          ],
          fetchedAt: Date.now(),
        };
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            urlHash,
            feedUrl,
            JSON.stringify(realFeed),
            Date.now(),
            Date.now(),
            3,
            'HTTP 500',
            Date.now() + 60000,
          ]
        );

        // Should NOT call fetch (in backoff)
        let fetchCalled = false;
        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
          fetchCalled = true;
          return new Response('Error', { status: 500 });
        }) as unknown as typeof fetch);

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        // Should return 200 with real cached content
        expect(res.status).toBe(200);
        expect(json.feed.title).toBe('Real Feed Title');
        expect(json.feed.items).toHaveLength(1);
        expect(json.cache).toBe('HIT');
        expect(fetchCalled).toBe(false);
      });

      it('distinguishes empty title with items from true empty placeholder', async () => {
        const { db, app } = createTestApp();

        const feedUrl = 'https://example.com/no-title-feed.xml';
        const urlHash = hashUrl(feedUrl);

        // Some feeds legitimately have empty titles but have items
        const feedWithEmptyTitle = {
          title: '',
          items: [
            {
              guid: 'item-1',
              url: 'https://example.com/1',
              title: 'Post',
              publishedAt: new Date().toISOString(),
            },
          ],
          fetchedAt: Date.now(),
        };
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            urlHash,
            feedUrl,
            JSON.stringify(feedWithEmptyTitle),
            Date.now(),
            Date.now(),
            2,
            'HTTP 500',
            Date.now() + 60000,
          ]
        );

        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
          return new Response('Error', { status: 500 });
        }) as unknown as typeof fetch);

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        // Should serve the content (has items even though title is empty)
        expect(res.status).toBe(200);
        expect(json.feed.items).toHaveLength(1);
        expect(json.cache).toBe('HIT');
      });

      it('distinguishes feed with title but no items from true empty placeholder', async () => {
        const { db, app } = createTestApp();

        const feedUrl = 'https://example.com/empty-items-feed.xml';
        const urlHash = hashUrl(feedUrl);

        // Some feeds legitimately have a title but are empty (new feed, all items expired)
        const feedWithTitleNoItems = {
          title: 'Empty But Real Feed',
          items: [],
          fetchedAt: Date.now(),
        };
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            urlHash,
            feedUrl,
            JSON.stringify(feedWithTitleNoItems),
            Date.now(),
            Date.now(),
            2,
            'HTTP 500',
            Date.now() + 60000,
          ]
        );

        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
          return new Response('Error', { status: 500 });
        }) as unknown as typeof fetch);

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        // Should serve the content (has title even though items is empty)
        expect(res.status).toBe(200);
        expect(json.feed.title).toBe('Empty But Real Feed');
        expect(json.cache).toBe('HIT');
      });
    });

    describe('POST /feeds - empty placeholder errors', () => {
      it('returns ERROR for 404 feeds in bulk request', async () => {
        const { app } = createTestApp();
        fetchMock = mockFetch(() => new Response('Not Found', { status: 404 }));

        const feedUrl = 'https://example.com/bulk-missing.xml';

        // First request creates the error placeholder
        await app.request('/feeds', {
          method: 'POST',
          headers: {
            'X-Proxy-Secret': 'test-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ urls: [feedUrl] }),
        });

        // Second request should return ERROR, not empty feed
        const res = await app.request('/feeds', {
          method: 'POST',
          headers: {
            'X-Proxy-Secret': 'test-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ urls: [feedUrl] }),
        });
        const json = await res.json();

        expect(res.status).toBe(200); // Bulk endpoint always returns 200
        expect(json.feeds[feedUrl].feed).toBeNull();
        expect(json.feeds[feedUrl].cache).toBe('ERROR');
        expect(json.feeds[feedUrl].error).toBe('HTTP 404');
      });

      it('handles mix of working feeds and error placeholders', async () => {
        const { db, app } = createTestApp();

        const workingUrl = 'https://example.com/working.xml';
        const errorUrl = 'https://example.com/errored.xml';
        const errorUrlHash = hashUrl(errorUrl);

        // Pre-populate error placeholder for one feed
        const emptyFeed = { title: '', items: [], fetchedAt: Date.now() };
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            errorUrlHash,
            errorUrl,
            JSON.stringify(emptyFeed),
            Date.now(),
            Date.now(),
            1,
            'HTTP 404',
            Date.now() + 60000,
          ]
        );

        // Mock fetch returns success for working URL
        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
          if (String(url).includes('working')) {
            return new Response(SAMPLE_RSS);
          }
          return new Response('Not Found', { status: 404 });
        }) as typeof fetch);

        const res = await app.request('/feeds', {
          method: 'POST',
          headers: {
            'X-Proxy-Secret': 'test-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ urls: [workingUrl, errorUrl] }),
        });
        const json = await res.json();

        // Working feed should succeed
        expect(json.feeds[workingUrl].feed).not.toBeNull();
        expect(json.feeds[workingUrl].feed.title).toBe('Test Blog');
        expect(json.feeds[workingUrl].cache).toBe('MISS');

        // Error feed should return ERROR
        expect(json.feeds[errorUrl].feed).toBeNull();
        expect(json.feeds[errorUrl].cache).toBe('ERROR');
        expect(json.feeds[errorUrl].error).toBe('HTTP 404');
      });

      it('serves stale content in bulk when feed had real content before errors', async () => {
        const { db, app } = createTestApp();

        const feedUrl = 'https://example.com/bulk-was-working.xml';
        const urlHash = hashUrl(feedUrl);

        // Pre-populate with REAL content in error backoff
        const realFeed = {
          title: 'Bulk Real Feed',
          items: [
            {
              guid: 'bulk-1',
              url: 'https://example.com/1',
              title: 'Bulk Post',
              publishedAt: new Date().toISOString(),
            },
          ],
          fetchedAt: Date.now(),
        };
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            urlHash,
            feedUrl,
            JSON.stringify(realFeed),
            Date.now(),
            Date.now(),
            3,
            'HTTP 500',
            Date.now() + 60000,
          ]
        );

        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
          return new Response('Error', { status: 500 });
        }) as unknown as typeof fetch);

        const res = await app.request('/feeds', {
          method: 'POST',
          headers: {
            'X-Proxy-Secret': 'test-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ urls: [feedUrl] }),
        });
        const json = await res.json();

        // Should return real cached content
        expect(json.feeds[feedUrl].feed).not.toBeNull();
        expect(json.feeds[feedUrl].feed.title).toBe('Bulk Real Feed');
        expect(json.feeds[feedUrl].cache).toBe('HIT');
      });

      it('returns ERROR for multiple error placeholder feeds in single request', async () => {
        const { db, app } = createTestApp();

        const urls = [
          'https://example.com/err1.xml',
          'https://example.com/err2.xml',
          'https://example.com/err3.xml',
        ];

        // Pre-populate all with error placeholders
        for (const url of urls) {
          const urlHash = hashUrl(url);
          const emptyFeed = { title: '', items: [], fetchedAt: Date.now() };
          db.run(
            `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              urlHash,
              url,
              JSON.stringify(emptyFeed),
              Date.now(),
              Date.now(),
              1,
              'HTTP 404',
              Date.now() + 60000,
            ]
          );
        }

        fetchMock = mockFetch(() => new Response('Not Found', { status: 404 }));

        const res = await app.request('/feeds', {
          method: 'POST',
          headers: {
            'X-Proxy-Secret': 'test-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ urls }),
        });
        const json = await res.json();

        // All should return ERROR
        for (const url of urls) {
          expect(json.feeds[url].feed).toBeNull();
          expect(json.feeds[url].cache).toBe('ERROR');
          expect(json.feeds[url].error).toBe('HTTP 404');
        }
      });
    });

    describe('Edge cases', () => {
      it('returns ERROR when backoff active even if cache age would be STALE', async () => {
        const { db, app } = createTestApp({
          cacheTtlMs: 1000, // 1 second
          staleTtlMs: 60000, // 1 minute
        });

        const feedUrl = 'https://example.com/stale-error.xml';
        const urlHash = hashUrl(feedUrl);

        // Pre-populate with empty placeholder that's "stale" by age but in backoff
        const emptyFeed = {
          title: '',
          items: [],
          fetchedAt: Date.now() - 5000,
        }; // 5 seconds ago
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            urlHash,
            feedUrl,
            JSON.stringify(emptyFeed),
            Date.now() - 5000,
            Date.now() - 5000,
            1,
            'HTTP 404',
            Date.now() + 60000,
          ]
        );

        fetchMock = mockFetch(() => new Response('Not Found', { status: 404 }));

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        // Should return ERROR even though cache age would normally be STALE
        expect(res.status).toBe(502);
        expect(json.cache).toBe('ERROR');
      });

      it('retries and creates new placeholder after backoff expires', async () => {
        const { db, app } = createTestApp({
          cacheTtlMs: 1000,
          staleTtlMs: 60000,
        });

        const feedUrl = 'https://example.com/retry-after-backoff.xml';
        const urlHash = hashUrl(feedUrl);

        // Pre-populate with expired backoff
        const emptyFeed = {
          title: '',
          items: [],
          fetchedAt: Date.now() - 5000,
        };
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            urlHash,
            feedUrl,
            JSON.stringify(emptyFeed),
            Date.now() - 5000,
            Date.now() - 5000,
            1,
            'HTTP 404',
            Date.now() - 1000,
          ] // expired
        );

        fetchMock = mockFetch(() => new Response('Still Not Found', { status: 404 }));

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        // Should have retried and gotten a new error
        expect(res.status).toBe(502);
        expect(json.cache).toBe('ERROR');
        expect(json.errorCount).toBe(2); // Incremented from 1

        // Verify fetch was called
        expect(fetchMock).toHaveBeenCalled();
      });

      it('recovers to HIT when feed starts working after errors', async () => {
        const { db, app } = createTestApp({
          cacheTtlMs: 1000,
          staleTtlMs: 60000,
        });

        const feedUrl = 'https://example.com/recovered.xml';
        const urlHash = hashUrl(feedUrl);

        // Pre-populate with error placeholder, backoff expired
        const emptyFeed = {
          title: '',
          items: [],
          fetchedAt: Date.now() - 5000,
        };
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            urlHash,
            feedUrl,
            JSON.stringify(emptyFeed),
            Date.now() - 5000,
            Date.now() - 5000,
            3,
            'HTTP 404',
            Date.now() - 1000,
          ] // expired
        );

        // Now it works!
        fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feed.title).toBe('Test Blog');
        expect(json.cache).toBe('REVALIDATED');

        // Verify error state was cleared
        const cached = db
          .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
          .get(urlHash);
        expect(cached?.error_count).toBe(0);
        expect(cached?.last_error).toBeNull();
        expect(cached?.next_retry_at).toBeNull();

        // Second request should be HIT
        const second = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const secondJson = await second.json();

        expect(second.status).toBe(200);
        expect(secondJson.cache).toBe('HIT');
      });
    });

    describe('GET /discover', () => {
      it('requires auth when secret is configured', async () => {
        const { app } = createTestApp({ proxySecret: 'my-secret' });

        const res = await app.request('/discover?url=https://example.com');

        expect(res.status).toBe(401);
      });

      it('requires url parameter', async () => {
        const { app } = createTestApp();

        const res = await app.request('/discover', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(400);
        expect(json.error).toBe('Missing url parameter');
      });

      it('validates url format', async () => {
        const { app } = createTestApp();

        const res = await app.request('/discover?url=not-a-url', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(400);
        expect(json.error).toBe('Invalid url');
      });

      it('returns the URL when content-type indicates a feed', async () => {
        const { app } = createTestApp();
        fetchMock = mockFetch(
          () =>
            new Response(SAMPLE_RSS, {
              headers: { 'Content-Type': 'application/rss+xml' },
            })
        );

        const res = await app.request('/discover?url=https://example.com/feed.xml', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toEqual(['https://example.com/feed.xml']);
      });

      it('returns the URL for atom content-type', async () => {
        const { app } = createTestApp();
        fetchMock = mockFetch(
          () =>
            new Response('<feed></feed>', {
              headers: { 'Content-Type': 'application/atom+xml' },
            })
        );

        const res = await app.request('/discover?url=https://example.com/atom.xml', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toEqual(['https://example.com/atom.xml']);
      });

      it('parses HTML to find RSS link tags', async () => {
        const { app } = createTestApp();
        const html = `
					<!DOCTYPE html>
					<html>
					<head>
						<link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS Feed">
					</head>
					<body>Hello</body>
					</html>
				`;
        fetchMock = mockFetch(
          () =>
            new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            })
        );

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toEqual(['https://example.com/feed.xml']);
      });

      it('parses HTML to find Atom link tags', async () => {
        const { app } = createTestApp();
        const html = `
					<!DOCTYPE html>
					<html>
					<head>
						<link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml">
					</head>
					<body>Hello</body>
					</html>
				`;
        fetchMock = mockFetch(
          () =>
            new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            })
        );

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toEqual(['https://example.com/atom.xml']);
      });

      it('finds multiple feed links in HTML', async () => {
        const { app } = createTestApp();
        const html = `
					<!DOCTYPE html>
					<html>
					<head>
						<link rel="alternate" type="application/rss+xml" href="/rss.xml">
						<link rel="alternate" type="application/atom+xml" href="/atom.xml">
					</head>
					<body>Hello</body>
					</html>
				`;
        fetchMock = mockFetch(
          () =>
            new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            })
        );

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toHaveLength(2);
        expect(json.feeds).toContain('https://example.com/rss.xml');
        expect(json.feeds).toContain('https://example.com/atom.xml');
      });

      it('detects standard.site advertisements in HTML', async () => {
        const { app } = createTestApp();
        const html = `
					<!DOCTYPE html>
					<html>
					<head>
						<link rel="alternate" type="application/rss+xml" href="https://underreacted.leaflet.pub/rss">
						<link rel="alternate" href="at://did:plc:fpruhuo22xkm5o7ttr2ktxdo/site.standard.document/3mjfjsk24qk2i">
						<link rel="site.standard.document" href="at://did:plc:fpruhuo22xkm5o7ttr2ktxdo/site.standard.document/3mjfjsk24qk2i">
					</head>
					<body>Hello</body>
					</html>
				`;
        fetchMock = mockFetch(
          () =>
            new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            })
        );

        const res = await app.request('/discover?url=https://underreacted.leaflet.pub/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        // RSS feed is still discovered alongside the standard.site
        expect(json.feeds).toContain('https://underreacted.leaflet.pub/rss');
        // The at:// document URI is reported once (deduped across both link tags)
        expect(json.standardSites).toEqual([
          'at://did:plc:fpruhuo22xkm5o7ttr2ktxdo/site.standard.document/3mjfjsk24qk2i',
        ]);
      });

      it('detects a site.standard.publication advertised on a homepage', async () => {
        const { app } = createTestApp();
        // Publication homepages advertise the publication record directly rather
        // than a per-article document (matches underreacted.leaflet.pub).
        const html = `
					<!DOCTYPE html>
					<html>
					<head>
						<link rel="alternate" type="application/rss+xml" href="https://underreacted.leaflet.pub/rss">
						<link rel="alternate" href="at://did:plc:fpruhuo22xkm5o7ttr2ktxdo/site.standard.publication/3m23dstduds2v">
						<link rel="site.standard.publication" href="at://did:plc:fpruhuo22xkm5o7ttr2ktxdo/site.standard.publication/3m23dstduds2v">
					</head>
					<body>Hello</body>
					</html>
				`;
        fetchMock = mockFetch(
          () =>
            new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            })
        );

        const res = await app.request('/discover?url=https://underreacted.leaflet.pub/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toContain('https://underreacted.leaflet.pub/rss');
        expect(json.standardSites).toEqual([
          'at://did:plc:fpruhuo22xkm5o7ttr2ktxdo/site.standard.publication/3m23dstduds2v',
        ]);
      });

      it('returns an empty standardSites array when none are advertised', async () => {
        const { app } = createTestApp();
        const html = `
					<!DOCTYPE html>
					<html>
					<head>
						<link rel="alternate" type="application/rss+xml" href="/feed.xml">
					</head>
					<body>Hello</body>
					</html>
				`;
        fetchMock = mockFetch(
          () =>
            new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            })
        );

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.standardSites).toEqual([]);
      });

      it('probes common feed paths when no links found', async () => {
        const { app } = createTestApp();
        const html = `<!DOCTYPE html><html><body>No feeds here</body></html>`;

        let callCount = 0;
        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
          url: unknown,
          init?: RequestInit
        ) => {
          callCount++;
          const urlStr = String(url);

          // First call is the main page
          if (callCount === 1) {
            return new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            });
          }

          // HEAD request to /feed returns XML content-type
          if (urlStr.endsWith('/feed') && init?.method === 'HEAD') {
            return new Response(null, {
              headers: { 'Content-Type': 'application/rss+xml' },
            });
          }

          // Other probes return 404
          return new Response('Not Found', { status: 404 });
        }) as typeof fetch);

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toContain('https://example.com/feed');
      });

      it('returns empty array when no feeds found', async () => {
        const { app } = createTestApp();
        const html = `<!DOCTYPE html><html><body>No feeds</body></html>`;

        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
          _url: unknown,
          init?: RequestInit
        ) => {
          if (init?.method === 'HEAD') {
            return new Response('Not Found', { status: 404 });
          }
          return new Response(html, {
            headers: { 'Content-Type': 'text/html' },
          });
        }) as typeof fetch);

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toEqual([]);
      });

      it('surfaces a 403 as a clean "blocked" condition, not a 502 gateway error', async () => {
        const { app } = createTestApp();
        fetchMock = mockFetch(() => new Response('Forbidden', { status: 403 }));

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        // 200, not 502: the proxy worked; the site refused us.
        expect(res.status).toBe(200);
        expect(json.blocked).toBe(true);
        expect(json.error).toContain('blocking automated access');
        expect(json.error).toContain('example.com');
        expect(json.error).toContain('403');
      });

      it('keeps a non-403 upstream failure as a 502', async () => {
        const { app } = createTestApp();
        fetchMock = mockFetch(() => new Response('Server Error', { status: 500 }));

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(502);
        expect(json.blocked).toBe(false);
        expect(json.error).toBe('Failed to fetch example.com: HTTP 500');
      });

      it('handles network errors', async () => {
        const { app } = createTestApp();
        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch);

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(502);
        expect(json.error).toBe('ECONNREFUSED');
      });

      it('limits feeds found from HTML to 10', async () => {
        const { app } = createTestApp();
        // HTML with 15 feed links
        const links = Array.from(
          { length: 15 },
          (_, i) => `<link rel="alternate" type="application/rss+xml" href="/feed${i}.xml">`
        ).join('\n');
        const html = `<!DOCTYPE html><html><head>${links}</head><body></body></html>`;

        fetchMock = mockFetch(
          () =>
            new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            })
        );

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toHaveLength(10);
      });

      it('stops probing common paths after first match', async () => {
        const { app } = createTestApp();
        const html = `<!DOCTYPE html><html><body>No feeds</body></html>`;

        const probedUrls: string[] = [];
        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
          url: unknown,
          init?: RequestInit
        ) => {
          const urlStr = String(url);

          // First call is the main page
          if (!init?.method) {
            return new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            });
          }

          // Track HEAD requests
          if (init?.method === 'HEAD') {
            probedUrls.push(urlStr);
            // First common path (/feed) returns a feed
            if (urlStr.endsWith('/feed')) {
              return new Response(null, {
                headers: { 'Content-Type': 'application/rss+xml' },
              });
            }
            return new Response('Not Found', { status: 404 });
          }

          return new Response('Not Found', { status: 404 });
        }) as typeof fetch);

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toEqual(['https://example.com/feed']);
        // Should only probe /feed (first path that matches)
        expect(probedUrls).toHaveLength(1);
      });

      it('limits common path probes to 3 when no match found', async () => {
        const { app } = createTestApp();
        const html = `<!DOCTYPE html><html><body>No feeds</body></html>`;

        const probedUrls: string[] = [];
        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
          url: unknown,
          init?: RequestInit
        ) => {
          const urlStr = String(url);

          if (!init?.method) {
            return new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            });
          }

          if (init?.method === 'HEAD') {
            probedUrls.push(urlStr);
            return new Response('Not Found', { status: 404 });
          }

          return new Response('Not Found', { status: 404 });
        }) as typeof fetch);

        const res = await app.request('/discover?url=https://example.com/', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feeds).toEqual([]);
        // Should only try 3 paths max
        expect(probedUrls).toHaveLength(3);
      });
    });

    describe('Response size limits', () => {
      it('accepts responses under the size limit', async () => {
        const { app } = createTestApp();
        fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

        const res = await app.request('/feed?url=https://example.com/normal-size.xml', {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.feed).not.toBeNull();
        expect(json.feed.title).toBe('Test Blog');
      });

      it('rejects responses over the size limit via Content-Length header', async () => {
        const { db, app } = createTestApp();
        // Response with Content-Length header indicating > 10MB
        fetchMock = mockFetch(
          () =>
            new Response('small body', {
              headers: { 'Content-Length': String(11 * 1024 * 1024) }, // 11 MB
            })
        );

        const feedUrl = 'https://example.com/too-large-header.xml';
        const urlHash = hashUrl(feedUrl);

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(502);
        expect(json.feed).toBeNull();
        expect(json.cache).toBe('ERROR');
        expect(json.error).toContain('exceeds limit');

        // Verify it's treated as permanent error (7-day backoff)
        const cached = db
          .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
          .get(urlHash);
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const expectedMin = Date.now() + sevenDaysMs - 1000;
        expect(cached?.next_retry_at).toBeGreaterThan(expectedMin);
      });

      it('rejects responses over the size limit via actual body size', async () => {
        const { db, app } = createTestApp();
        // Create a response body > 10MB without Content-Length header
        const largeBody = 'x'.repeat(11 * 1024 * 1024); // 11 MB
        fetchMock = mockFetch(() => new Response(largeBody));

        const feedUrl = 'https://example.com/too-large-body.xml';
        const urlHash = hashUrl(feedUrl);

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        expect(res.status).toBe(502);
        expect(json.feed).toBeNull();
        expect(json.cache).toBe('ERROR');
        expect(json.error).toContain('exceeds limit');

        // Verify it's treated as permanent error
        const cached = db
          .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
          .get(urlHash);
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const expectedMin = Date.now() + sevenDaysMs - 1000;
        expect(cached?.next_retry_at).toBeGreaterThan(expectedMin);
      });

      it('returns cached content when new fetch exceeds size limit', async () => {
        const { db, app } = createTestApp({
          cacheTtlMs: 1, // Very short TTL to force refetch
          staleTtlMs: 60 * 60 * 1000,
        });

        const feedUrl = 'https://example.com/grew-too-large.xml';
        const urlHash = hashUrl(feedUrl);

        // Pre-populate cache with valid content
        const cachedFeed = {
          title: 'Good Feed',
          items: [
            {
              guid: 'item-1',
              url: 'https://example.com/1',
              title: 'Post',
              publishedAt: new Date().toISOString(),
            },
          ],
          fetchedAt: Date.now() - 10000,
        };
        db.run(
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count)
					VALUES (?, ?, ?, ?, ?, ?)`,
          [urlHash, feedUrl, JSON.stringify(cachedFeed), Date.now() - 10000, Date.now() - 10000, 0]
        );

        // Now the feed has grown too large
        fetchMock = mockFetch(() => new Response('x'.repeat(11 * 1024 * 1024)));

        const res = await app.request(`/feed?url=${feedUrl}`, {
          headers: { 'X-Proxy-Secret': 'test-secret' },
        });
        const json = await res.json();

        // Should return the cached content
        expect(res.status).toBe(200);
        expect(json.feed.title).toBe('Good Feed');
        expect(json.feed.items).toHaveLength(1);
      });

      it('handles size limit error in bulk requests', async () => {
        const { app } = createTestApp();

        const normalUrl = 'https://example.com/normal-bulk.xml';
        const largeUrl = 'https://example.com/large-bulk.xml';

        fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
          if (String(url).includes('large')) {
            return new Response('x'.repeat(11 * 1024 * 1024));
          }
          return new Response(SAMPLE_RSS);
        }) as typeof fetch);

        const res = await app.request('/feeds', {
          method: 'POST',
          headers: {
            'X-Proxy-Secret': 'test-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ urls: [normalUrl, largeUrl] }),
        });
        const json = await res.json();

        // Normal feed should succeed
        expect(json.feeds[normalUrl].feed).not.toBeNull();
        expect(json.feeds[normalUrl].feed.title).toBe('Test Blog');

        // Large feed should fail
        expect(json.feeds[largeUrl].feed).toBeNull();
        expect(json.feeds[largeUrl].cache).toBe('ERROR');
        expect(json.feeds[largeUrl].error).toContain('exceeds limit');
      });
    });
  });
});

describe('Self-warming loop', () => {
  let fetchMock: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchMock?.mockRestore();
  });

  interface InsertOpts {
    urlHash?: string;
    fetchedAt: number;
    lastRequestedAt: number | null;
    nextRetryAt?: number | null;
    errorCount?: number;
    parsedJson?: string;
  }

  function insertCacheRow(db: Database, url: string, opts: InsertOpts) {
    const parsed =
      opts.parsedJson ?? JSON.stringify({ title: 'Cached', items: [], fetchedAt: opts.fetchedAt });
    db.run(
      `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, next_retry_at, last_requested_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.urlHash ?? hashUrl(url),
        url,
        parsed,
        opts.fetchedAt,
        opts.fetchedAt,
        opts.errorCount ?? 0,
        opts.nextRetryAt ?? null,
        opts.lastRequestedAt,
      ]
    );
  }

  it('refreshes an active feed that is older than the threshold', async () => {
    const { db, warmStaleFeeds } = createTestApp({
      warmRefreshThresholdMs: 1000,
    });
    fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

    const url = 'https://example.com/stale-feed';
    const now = Date.now();
    insertCacheRow(db, url, {
      fetchedAt: now - 10_000,
      lastRequestedAt: now - 5_000,
    });

    const refreshed = await warmStaleFeeds();

    expect(refreshed).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(1);

    // fetched_at should be bumped to ~now and content replaced with the live feed
    const row = db.query<CacheRow, [string]>('SELECT * FROM cache WHERE url = ?').get(url);
    expect(row!.fetched_at).toBeGreaterThan(now - 1000);
    expect(JSON.parse(row!.parsed_json).title).toBe('Test Blog');
  });

  it('preserves last_requested_at across a warm refresh (so abandoned feeds age out)', async () => {
    const { db, warmStaleFeeds } = createTestApp({
      warmRefreshThresholdMs: 1000,
    });
    fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

    const url = 'https://example.com/stale-feed';
    const now = Date.now();
    const lastRequested = now - 5_000;
    insertCacheRow(db, url, {
      fetchedAt: now - 10_000,
      lastRequestedAt: lastRequested,
    });

    await warmStaleFeeds();

    const row = db.query<CacheRow, [string]>('SELECT * FROM cache WHERE url = ?').get(url);
    expect(row!.last_requested_at).toBe(lastRequested);
  });

  it('skips feeds that are still fresh', async () => {
    const { db, warmStaleFeeds } = createTestApp({
      warmRefreshThresholdMs: 60_000,
    });
    fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

    const now = Date.now();
    insertCacheRow(db, 'https://example.com/fresh', {
      fetchedAt: now - 1000,
      lastRequestedAt: now - 1000,
    });

    const refreshed = await warmStaleFeeds();

    expect(refreshed).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('skips feeds outside the active window', async () => {
    const { db, warmStaleFeeds } = createTestApp({
      warmRefreshThresholdMs: 1000,
      warmActiveWindowMs: 10_000,
    });
    fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

    const now = Date.now();
    // Stale, but not requested within the active window
    insertCacheRow(db, 'https://example.com/abandoned', {
      fetchedAt: now - 60_000,
      lastRequestedAt: now - 60_000,
    });
    // Stale, but never requested by a client (NULL)
    insertCacheRow(db, 'https://example.com/never-requested', {
      fetchedAt: now - 60_000,
      lastRequestedAt: null,
    });

    const refreshed = await warmStaleFeeds();

    expect(refreshed).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('skips feeds in error backoff', async () => {
    const { db, warmStaleFeeds } = createTestApp({
      warmRefreshThresholdMs: 1000,
    });
    fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

    const now = Date.now();
    insertCacheRow(db, 'https://example.com/backoff', {
      fetchedAt: now - 60_000,
      lastRequestedAt: now - 1000,
      errorCount: 3,
      nextRetryAt: now + 60_000,
    });

    const refreshed = await warmStaleFeeds();

    expect(refreshed).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('warms a parser upgrade once despite an older error backoff', async () => {
    const { db, warmStaleFeeds } = createTestApp({
      warmRefreshThresholdMs: 60_000,
    });
    fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

    const url = 'https://example.com/backoff-parser-upgrade';
    const now = Date.now();
    insertCacheRow(db, url, {
      fetchedAt: now - 1000,
      lastRequestedAt: now - 1000,
      errorCount: 3,
      nextRetryAt: now + 60_000,
    });
    db.run('UPDATE cache SET parser_version = 0 WHERE url = ?', [url]);

    const refreshed = await warmStaleFeeds();

    expect(refreshed).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(1);
    const row = db.query<CacheRow, [string]>('SELECT * FROM cache WHERE url = ?').get(url);
    expect(row?.parser_version).toBe(FEED_PARSER_VERSION);
    expect(row?.parser_upgrade_attempted_version).toBe(FEED_PARSER_VERSION);
    expect(row?.next_retry_at).toBeNull();
  });

  it('honors the batch cap', async () => {
    const { db, warmStaleFeeds } = createTestApp({
      warmRefreshThresholdMs: 1000,
      warmBatchCap: 2,
    });
    fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      insertCacheRow(db, `https://example.com/feed-${i}`, {
        fetchedAt: now - 10_000 - i,
        lastRequestedAt: now - 5_000,
      });
    }

    const refreshed = await warmStaleFeeds();

    expect(refreshed).toBe(2);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('GET /feed bumps last_requested_at on a cache hit', async () => {
    const { db, app } = createTestApp();
    fetchMock = mockFetch(() => new Response(SAMPLE_RSS));

    const url = 'https://example.com/hit-feed';
    const now = Date.now();
    // Fresh row with real content but no recorded request yet
    insertCacheRow(db, url, {
      fetchedAt: now - 1000,
      lastRequestedAt: null,
      parsedJson: JSON.stringify({
        title: 'Test Blog',
        items: [{ guid: 'g', title: 't', url: 'u' }],
        fetchedAt: now,
      }),
    });

    const res = await app.request(`/feed?url=${encodeURIComponent(url)}`, {
      headers: { 'X-Proxy-Secret': 'test-secret' },
    });
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(fetchMock.mock.calls.length).toBe(0); // served from cache

    const row = db.query<CacheRow, [string]>('SELECT * FROM cache WHERE url = ?').get(url);
    expect(row!.last_requested_at).not.toBeNull();
    expect(row!.last_requested_at!).toBeGreaterThanOrEqual(now - 1000);
  });
});

describe('Durable item retention (feed_items cursor)', () => {
  let fetchMock: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchMock?.mockRestore();
  });

  const URL = 'https://example.com/retain.xml';

  // Build a newest-first RSS feed from a list of { guid, content? }. Mirrors how
  // a real source serves its current live window — items not listed are "dropped".
  function rss(items: Array<{ guid: string; content?: string }>): string {
    const body = items
      .map(
        (it) =>
          `<item><title>${it.guid}</title><link>https://example.com/${it.guid}</link>` +
          `<guid>${it.guid}</guid>` +
          (it.content ? `<description>${it.content}</description>` : '') +
          `</item>`
      )
      .join('');
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Retain</title><link>https://example.com</link>${body}</channel></rss>`;
  }

  async function poll(
    app: ReturnType<typeof createTestApp>['app'],
    params: Record<string, string | number> = {}
  ) {
    const qs = new URLSearchParams({ url: URL });
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const res = await app.request(`/feed?${qs}`, {
      headers: { 'X-Proxy-Secret': 'test-secret' },
    });
    return res.json() as Promise<{
      feed: { items: Array<{ guid: string; summary?: string }> };
      cache: string;
      cursor: number;
      generation: string;
      hasMore: boolean;
    }>;
  }

  // Force the warm loop to consider the feed due for refresh on the next tick.
  function ageOut(db: Database) {
    db.run('UPDATE cache SET fetched_at = 0');
  }

  function feedItemGuids(db: Database): Array<{ seq: number; guid: string }> {
    return db
      .query<
        { seq: number; guid: string },
        [string]
      >('SELECT seq, guid FROM feed_items WHERE url_hash = ? ORDER BY seq ASC')
      .all(hashUrl(URL));
  }

  it('HEADLINE: delivers an item the warm loop observed but the source later dropped', async () => {
    const { db, app, warmStaleFeeds } = createTestApp({ warmRefreshThresholdMs: 1 });
    let current = rss([{ guid: 'A' }]);
    fetchMock = mockFetch(() => new Response(current));

    // Poll 1 (cold): client sees A.
    const first = await poll(app);
    expect(first.feed.items.map((i) => i.guid)).toEqual(['A']);
    const cursor = first.cursor;
    const generation = first.generation;

    // Source publishes B (A still live); warm loop observes both.
    current = rss([{ guid: 'B' }, { guid: 'A' }]);
    ageOut(db);
    await warmStaleFeeds();

    // Source drops A and B from its live window, publishes C; warm loop observes.
    current = rss([{ guid: 'C' }]);
    ageOut(db);
    await warmStaleFeeds();

    // Poll 2 (incremental): B was dropped from the source entirely, but the proxy
    // retained it — the client still catches it, plus C. A is <= cursor (seen).
    const second = await poll(app, { since_seq: cursor, generation });
    const guids = second.feed.items.map((i) => i.guid);
    expect(guids).toContain('B');
    expect(guids).toContain('C');
    expect(guids).not.toContain('A');
  });

  it('keeps seq monotonic across re-parses and does not re-deliver a re-seen GUID', async () => {
    const { db, app, warmStaleFeeds } = createTestApp({ warmRefreshThresholdMs: 1 });
    const current = rss([{ guid: 'c' }, { guid: 'b' }, { guid: 'a' }]);
    fetchMock = mockFetch(() => new Response(current));

    const first = await poll(app);
    const before = feedItemGuids(db);
    expect(before.map((r) => r.guid)).toEqual(['a', 'b', 'c']); // oldest→newest seq

    // Re-parse identical content via the warm loop.
    ageOut(db);
    await warmStaleFeeds();

    const after = feedItemGuids(db);
    expect(after).toEqual(before); // same seqs, same rows — no churn

    // Incremental poll from the first cursor returns nothing new.
    const second = await poll(app, { since_seq: first.cursor, generation: first.generation });
    expect(second.feed.items).toHaveLength(0);
    expect(second.hasMore).toBe(false);
  });

  it('updates an edited item in place (seq unchanged) and does not re-deliver it', async () => {
    const { db, app, warmStaleFeeds } = createTestApp({ warmRefreshThresholdMs: 1 });
    let current = rss([{ guid: 'a', content: 'v1' }]);
    fetchMock = mockFetch(() => new Response(current));

    const first = await poll(app);
    expect(first.feed.items[0].summary).toBe('v1');
    const seqBefore = feedItemGuids(db)[0].seq;

    // Same GUID, changed content.
    current = rss([{ guid: 'a', content: 'v2' }]);
    ageOut(db);
    await warmStaleFeeds();

    const rows = feedItemGuids(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(seqBefore); // seq preserved

    // Not re-delivered to a client at the old cursor (edit doesn't move the seq).
    const second = await poll(app, { since_seq: first.cursor, generation: first.generation });
    expect(second.feed.items).toHaveLength(0);

    // But a fresh (cold) read reflects the new content.
    const cold = await poll(app, { generation: 'different-gen' });
    expect(cold.feed.items[0].summary).toBe('v2');
  });

  it('cold-starts on a generation mismatch instead of draining', async () => {
    const { app } = createTestApp();
    fetchMock = mockFetch(() => new Response(rss([{ guid: 'a' }, { guid: 'b' }, { guid: 'c' }])));

    const first = await poll(app);
    expect(first.feed.items).toHaveLength(3);

    // A stale cursor with a mismatched generation → cold start (recent slice),
    // not an empty drain.
    const mismatch = await poll(app, { since_seq: first.cursor, generation: 'stale-gen' });
    expect(mismatch.feed.items).toHaveLength(3);
    expect(mismatch.hasMore).toBe(false);
  });

  it('cold start returns the newest slice and jumps the cursor past it (no backlog dump)', async () => {
    const { db, app, warmStaleFeeds } = createTestApp({ warmRefreshThresholdMs: 1 });
    // Accumulate 5 retained items across two observations.
    let current = rss([{ guid: 'b' }, { guid: 'a' }]);
    fetchMock = mockFetch(() => new Response(current));
    await poll(app);
    current = rss([{ guid: 'e' }, { guid: 'd' }, { guid: 'c' }]);
    ageOut(db);
    await warmStaleFeeds();
    expect(feedItemGuids(db)).toHaveLength(5);

    // Cold start with limit=2 → newest 2, cursor at their max. Older retained
    // items are intentionally NOT delivered to a brand-new client.
    const cold = await poll(app, { limit: 2 });
    expect(cold.feed.items).toHaveLength(2);
    const seen = cold.feed.items.map((i) => i.guid);
    expect(seen).toContain('e');
    expect(seen).toContain('d');

    // A follow-up incremental poll from that cursor delivers nothing older.
    const next = await poll(app, { since_seq: cold.cursor, generation: cold.generation });
    expect(next.feed.items).toHaveLength(0);
  });

  it('drains a backlog across successive polls with no skips and hasMore signalling', async () => {
    const { db, app, warmStaleFeeds } = createTestApp({ warmRefreshThresholdMs: 1 });
    // Client first sees only item 1 (cursor parks at seq1).
    let current = rss([{ guid: '1' }]);
    fetchMock = mockFetch(() => new Response(current));
    const first = await poll(app);
    expect(first.feed.items.map((i) => i.guid)).toEqual(['1']);

    // Four more items accumulate while the client is away.
    current = rss([{ guid: '5' }, { guid: '4' }, { guid: '3' }, { guid: '2' }, { guid: '1' }]);
    ageOut(db);
    await warmStaleFeeds();

    // Drain in pages of 2: [2,3] (hasMore), then [4,5] (done). No item skipped.
    const page1 = await poll(app, {
      since_seq: first.cursor,
      generation: first.generation,
      limit: 2,
    });
    expect(page1.feed.items.map((i) => i.guid)).toEqual(['2', '3']);
    expect(page1.hasMore).toBe(true);

    const page2 = await poll(app, {
      since_seq: page1.cursor,
      generation: page1.generation,
      limit: 2,
    });
    expect(page2.feed.items.map((i) => i.guid)).toEqual(['4', '5']);
    expect(page2.hasMore).toBe(false);
  });

  it('trims each feed to the newest K (per-feed cap), bounding a GUID-mutating feed', async () => {
    const { db, app, warmStaleFeeds } = createTestApp({ warmRefreshThresholdMs: 1 });
    const batch = (prefix: string) =>
      rss(Array.from({ length: 100 }, (_, i) => ({ guid: `${prefix}-${99 - i}` })));

    // Three batches of 100 unique GUIDs each = 300 observed; cap holds at K.
    let current = batch('a');
    fetchMock = mockFetch(() => new Response(current));
    await poll(app);
    current = batch('b');
    ageOut(db);
    await warmStaleFeeds();
    current = batch('c');
    ageOut(db);
    await warmStaleFeeds();

    const count = db
      .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM feed_items WHERE url_hash = ?')
      .get(hashUrl(URL))!.c;
    expect(count).toBe(FEED_ITEMS_CAP);

    // Oldest batch is gone; the newest batch survives in full.
    const guids = new Set(feedItemGuids(db).map((r) => r.guid));
    expect(guids.has('a-0')).toBe(false);
    expect(guids.has('c-0')).toBe(true);
    expect(guids.has('c-99')).toBe(true);
  });

  it('cascades feed_items deletion when cleanupCache evicts a cold feed', async () => {
    const { db, app } = createTestApp();
    fetchMock = mockFetch(() => new Response(rss([{ guid: 'a' }, { guid: 'b' }])));
    await poll(app);
    expect(feedItemGuids(db).length).toBe(2);

    // Age the cache row past the 7-day cleanup threshold.
    db.run('UPDATE cache SET fetched_at = ?', [Date.now() - 8 * 24 * 60 * 60 * 1000]);
    cleanupCache(db);

    expect(feedItemGuids(db).length).toBe(0);
  });

  it('cold-starts a cursor that exceeds the live high-water (volume-restore guard)', async () => {
    const { app } = createTestApp();
    fetchMock = mockFetch(() => new Response(rss([{ guid: 'a' }, { guid: 'b' }, { guid: 'c' }])));

    const first = await poll(app);
    expect(first.feed.items).toHaveLength(3);

    // Simulate a volume-snapshot restore to an OLDER state: the generation token
    // is unchanged (it's persisted), but the client holds a cursor from the
    // since-rewound future — above the restored high-water mark. A cursor can
    // never legitimately exceed sqlite_sequence's high-water, so the proxy treats
    // it as the restore case and cold-starts. Without the guard, `seq > cursor`
    // would return nothing forever, silently starving this client.
    const restored = await poll(app, {
      since_seq: first.cursor + 1000,
      generation: first.generation,
    });
    expect(restored.feed.items.map((i) => i.guid).sort()).toEqual(['a', 'b', 'c']);
    expect(restored.hasMore).toBe(false);
  });

  it('backfills the durable log from the blob and returns a cursor (no since_guids pin)', async () => {
    const { db, app } = createTestApp();
    fetchMock = mockFetch(() => new Response(rss([{ guid: 'a' }, { guid: 'b' }])));

    // First poll populates both the cache blob and the durable log.
    await poll(app);
    // Simulate a legacy cache row with no durable-log rows (a pre-retention cache,
    // or a stale blob served before any successful retain).
    db.run('DELETE FROM feed_items WHERE url_hash = ?', [hashUrl(URL)]);
    expect(feedItemGuids(db).length).toBe(0);

    // Next poll is a cache HIT (no re-parse). The read must seed the durable log
    // from the blob and hand back a real cursor — otherwise the client is pinned
    // to the blob fallback (cursor=null) and keeps re-draining the whole feed via
    // since_guids forever.
    const res = await poll(app);
    expect(res.feed.items.map((i) => i.guid)).toEqual(['a', 'b']);
    expect(feedItemGuids(db).length).toBe(2);
    expect(res.cursor).toBeGreaterThan(0);
    expect(res.generation).toBeTruthy();

    // And the cursor actually advances the client off the backlog: a follow-up
    // poll on that cursor returns nothing new.
    const next = await poll(app, { since_seq: res.cursor, generation: res.generation });
    expect(next.feed.items).toHaveLength(0);
  });
});
