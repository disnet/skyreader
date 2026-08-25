import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initDatabase,
  hashUrl,
  writeFeedItems,
  cleanupCache,
  itemContentHash,
  FEED_ITEMS_CAP,
} from './app';
import {
  pushDirtyItems,
  pullCrawlSet,
  registerCrawlFeeds,
  reportFeedHealth,
  CRAWL_STALE_MS,
  selectDirtyRows,
  selectFeedHealth,
  MAX_HEALTH_REPORT_FEEDS,
  countDirtyRows,
  createPushLoop,
  type IngestConfig,
  type PushResult,
} from './ingest-push';
import type { FeedItem } from './types';

const FEED_URL = 'https://example.com/feed.xml';
const URL_HASH = hashUrl(FEED_URL);

const CONFIG: IngestConfig = {
  ingestUrl: 'https://api.example',
  secret: 'test-secret',
  batchSize: 2,
};

function item(guid: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    guid,
    url: `https://example.com/${guid}`,
    title: `Title ${guid}`,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function seedCache(db: Database, url = FEED_URL, feedTitle = 'Test Blog'): void {
  db.run(
    `INSERT INTO cache (url_hash, url, parsed_json, parser_version, cached_at, fetched_at, last_requested_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    [
      hashUrl(url),
      url,
      JSON.stringify({
        title: feedTitle,
        siteUrl: 'https://example.com',
        description: 'A test blog',
        items: [],
      }),
      Date.now(),
      Date.now(),
      Date.now(),
    ]
  );
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    feeds: Array<{ feedUrl: string; title?: string | null; siteUrl?: string | null }>;
    items: Array<{ feedUrl: string; guid: string; contentHash: string; item: FeedItem }>;
  };
}

// Capture what the pusher sends and control the Worker's reply.
function mockIngestEndpoint(status = 200): { calls: CapturedRequest[]; restore: () => void } {
  const calls: CapturedRequest[] = [];
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string,
    init?: RequestInit
  ) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : { feeds: [], items: [] },
    });
    return new Response(JSON.stringify({ ok: status === 200 }), { status });
  }) as unknown as typeof fetch);
  return { calls, restore: () => spy.mockRestore() };
}

describe('ingest push', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
    seedCache(db);
  });

  afterEach(() => {
    db.close();
  });

  it('pushes dirty rows in seq order and acks them', async () => {
    writeFeedItems(db, URL_HASH, [item('g2'), item('g1')], Date.now());
    expect(countDirtyRows(db)).toBe(2);

    const endpoint = mockIngestEndpoint();
    const result = await pushDirtyItems(db, CONFIG);
    endpoint.restore();

    expect(result.pushed).toBe(2);
    expect(endpoint.calls.length).toBe(1);
    expect(endpoint.calls[0].url).toBe('https://api.example/api/internal/ingest');
    expect(endpoint.calls[0].headers['X-Proxy-Secret']).toBe('test-secret');
    // Items are newest-first in the feed, written oldest-first, so seq order is g1, g2.
    expect(endpoint.calls[0].body.items.map((i) => i.guid)).toEqual(['g1', 'g2']);
    // Always the registered URL, never a post-redirect one.
    expect(endpoint.calls[0].body.items.every((i) => i.feedUrl === FEED_URL)).toBe(true);
    expect(endpoint.calls[0].body.feeds[0]).toMatchObject({
      feedUrl: FEED_URL,
      title: 'Test Blog',
      siteUrl: 'https://example.com',
    });

    expect(countDirtyRows(db)).toBe(0);
  });

  it('pages a backlog larger than one batch', async () => {
    writeFeedItems(db, URL_HASH, [item('g3'), item('g2'), item('g1')], Date.now());

    const endpoint = mockIngestEndpoint();
    const first = await pushDirtyItems(db, CONFIG);
    expect(first.pushed).toBe(2);
    expect(first.hasMore).toBe(true);

    const second = await pushDirtyItems(db, CONFIG);
    endpoint.restore();
    expect(second.pushed).toBe(1);
    expect(second.hasMore).toBe(false);
    expect(countDirtyRows(db)).toBe(0);
  });

  it('leaves state untouched on a 5xx so the same rows retry', async () => {
    writeFeedItems(db, URL_HASH, [item('g1')], Date.now());

    const failing = mockIngestEndpoint(500);
    const result = await pushDirtyItems(db, CONFIG);
    failing.restore();
    expect(result.pushed).toBe(0);
    expect(result.error).toContain('500');
    expect(countDirtyRows(db)).toBe(1);

    const ok = mockIngestEndpoint();
    const retry = await pushDirtyItems(db, CONFIG);
    ok.restore();
    expect(retry.pushed).toBe(1);
    expect(countDirtyRows(db)).toBe(0);
  });

  it('re-qualifies an item edited after it was pushed', async () => {
    writeFeedItems(db, URL_HASH, [item('g1', { title: 'Old' })], Date.now());
    const first = mockIngestEndpoint();
    await pushDirtyItems(db, CONFIG);
    first.restore();
    expect(countDirtyRows(db)).toBe(0);

    // An edit rewrites content_hash in place (seq unchanged) → dirty again.
    writeFeedItems(db, URL_HASH, [item('g1', { title: 'New' })], Date.now());
    expect(countDirtyRows(db)).toBe(1);

    const second = mockIngestEndpoint();
    const result = await pushDirtyItems(db, CONFIG);
    second.restore();
    expect(result.pushed).toBe(1);
    expect(second.calls[0].body.items[0].item.title).toBe('New');
  });

  it('acks the hash it pushed, so an edit mid-flight is not lost', async () => {
    writeFeedItems(db, URL_HASH, [item('g1', { title: 'Old' })], Date.now());
    const rows = selectDirtyRows(db, 10);
    expect(rows.length).toBe(1);

    const endpoint = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      // The warm loop rewrites the item while the request is in flight.
      writeFeedItems(db, URL_HASH, [item('g1', { title: 'Newer' })], Date.now());
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    await pushDirtyItems(db, CONFIG);
    endpoint.mockRestore();

    // The acked hash is the one we sent, which no longer matches — still dirty.
    expect(countDirtyRows(db)).toBe(1);
  });

  it('supplies a hash for legacy rows that have none', async () => {
    const parsed = item('legacy');
    db.run(
      `INSERT INTO feed_items (url_hash, guid, item_json, published_at, first_seen_at, content_hash)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [URL_HASH, 'legacy', JSON.stringify(parsed), Date.now(), Date.now()]
    );

    const endpoint = mockIngestEndpoint();
    await pushDirtyItems(db, CONFIG);
    endpoint.restore();

    expect(endpoint.calls[0].body.items[0].contentHash).toBe(itemContentHash(parsed));
    // Acked as '' (matching COALESCE), so it doesn't re-push every cycle.
    expect(countDirtyRows(db)).toBe(0);
  });

  it('cascades push_state when the per-feed cap trims items', async () => {
    // Fill past the cap so the oldest rows are trimmed on the next write.
    const initial = Array.from({ length: FEED_ITEMS_CAP }, (_, i) => item(`old-${i}`));
    writeFeedItems(db, URL_HASH, initial, Date.now());
    const endpoint = mockIngestEndpoint();
    let guard = 0;
    while (countDirtyRows(db) > 0 && guard++ < 200) {
      await pushDirtyItems(db, { ...CONFIG, batchSize: 100 });
    }
    endpoint.restore();
    expect(db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM push_state').get()?.c).toBe(
      FEED_ITEMS_CAP
    );

    writeFeedItems(db, URL_HASH, [item('fresh-1'), item('fresh-2')], Date.now());

    const itemCount = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM feed_items').get()?.c;
    const stateCount = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM push_state').get()?.c;
    expect(itemCount).toBe(FEED_ITEMS_CAP);
    // Two trimmed rows dropped their delivery state with them (2 fresh rows are
    // not yet pushed, so push_state holds cap - 2).
    expect(stateCount).toBe(FEED_ITEMS_CAP - 2);
  });

  it('cascades push_state when an idle feed is evicted', async () => {
    writeFeedItems(db, URL_HASH, [item('g1')], Date.now());
    const endpoint = mockIngestEndpoint();
    await pushDirtyItems(db, CONFIG);
    endpoint.restore();
    expect(db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM push_state').get()?.c).toBe(1);

    // Age the feed past the 7-day eviction window.
    db.run('UPDATE cache SET fetched_at = ? WHERE url_hash = ?', [
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      URL_HASH,
    ]);
    cleanupCache(db);

    expect(db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM feed_items').get()?.c).toBe(0);
    expect(db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM push_state').get()?.c).toBe(0);
  });
});

describe('crawl-set registration', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a cache row for an unknown feed, due for the warm loop', () => {
    const now = Date.now();
    expect(registerCrawlFeeds(db, [FEED_URL], now)).toBe(1);

    const row = db
      .query<
        { url: string; fetched_at: number; parser_version: number; last_requested_at: number },
        [string]
      >('SELECT url, fetched_at, parser_version, last_requested_at FROM cache WHERE url_hash = ?')
      .get(URL_HASH);
    expect(row?.url).toBe(FEED_URL);
    expect(row?.last_requested_at).toBe(now);
    // fetched_at 0 + a stale parser version make it immediately warm-eligible.
    expect(row?.fetched_at).toBe(0);
    expect(row?.parser_version).toBe(0);
  });

  it('keeps a known feed warm without any read traffic', () => {
    seedCache(db);
    db.run('UPDATE cache SET last_requested_at = ? WHERE url_hash = ?', [1000, URL_HASH]);

    const now = Date.now();
    registerCrawlFeeds(db, [FEED_URL], now);

    const row = db
      .query<{ last_requested_at: number; parsed_json: string; parser_version: number }, [string]>(
        'SELECT last_requested_at, parsed_json, parser_version FROM cache WHERE url_hash = ?'
      )
      .get(URL_HASH);
    expect(row?.last_requested_at).toBe(now);
    // The existing cached parse is untouched.
    expect(row?.parser_version).toBe(1);
    expect(JSON.parse(row!.parsed_json).title).toBe('Test Blog');
  });

  it('pulls the crawl set from the paired Worker', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: string,
      init?: RequestInit
    ) => {
      expect(String(input)).toBe('https://api.example/api/internal/crawl-set');
      expect((init?.headers as Record<string, string>)['X-Proxy-Secret']).toBe('test-secret');
      return new Response(
        JSON.stringify({
          feeds: [
            { feedUrl: FEED_URL, subscribers: 3 },
            { feedUrl: 'https://other.example/f.xml' },
          ],
        })
      );
    }) as unknown as typeof fetch);

    const result = await pullCrawlSet(db, CONFIG);
    spy.mockRestore();

    expect(result.registered).toBe(2);
    expect(db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM cache').get()?.c).toBe(2);
  });

  it('reports a failed pull without touching the cache', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return new Response('nope', { status: 503 });
    }) as unknown as typeof fetch);

    const result = await pullCrawlSet(db, CONFIG);
    spy.mockRestore();

    expect(result.registered).toBe(0);
    expect(result.error).toContain('503');
    expect(db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM cache').get()?.c).toBe(0);
  });
});

describe('feed health reporting', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
    seedCache(db);
  });

  afterEach(() => {
    db.close();
  });

  function breakFeed(
    url: string,
    opts: { errorCount?: number; error?: string; at?: number; retryAt?: number } = {}
  ): void {
    const at = opts.at ?? Date.now();
    db.run(
      'UPDATE cache SET error_count = ?, last_error = ?, last_error_at = ?, next_retry_at = ? WHERE url_hash = ?',
      [
        opts.errorCount ?? 3,
        opts.error ?? 'Failed to fetch (HTTP 404)',
        at,
        opts.retryAt ?? at + 600_000,
        hashUrl(url),
      ]
    );
  }

  it('caps an oversized report, keeping every erroring feed and dropping stale-only ones', () => {
    // The Worker rejects a body over MAX_HEALTH_FEEDS (2000) outright, so an
    // uncapped report is not "a big report" — it is no report at all, in both
    // directions, until the crawler catches up.
    const now = Date.now();
    const staleAt = now - CRAWL_STALE_MS - 1;
    const total = MAX_HEALTH_REPORT_FEEDS + 500;
    const erroringCount = 50;

    const insert = db.query(
      `INSERT INTO cache (url_hash, url, parsed_json, parser_version, parser_upgrade_attempted_version,
                          cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at, last_requested_at)
       VALUES (?, ?, '{"title":"","items":[],"fetchedAt":0}', 0, 0, 0, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (let i = 0; i < total; i++) {
        const url = `https://example.com/bulk-${i}.xml`;
        const erroring = i < erroringCount;
        insert.run(
          hashUrl(url),
          url,
          staleAt,
          erroring ? 3 : 0,
          erroring ? 'boom' : null,
          erroring ? now : null,
          erroring ? now + 600_000 : null,
          now
        );
      }
    })();

    const health = selectFeedHealth(db, now);

    expect(health).toHaveLength(MAX_HEALTH_REPORT_FEEDS);
    // Every erroring feed survives: dropping one silently clears a real error
    // badge, because the Worker infers recovery from a feed's absence.
    expect(health.filter((f) => f.errorCount > 0)).toHaveLength(erroringCount);
    // The rest of the budget goes to stale-only entries, which are an operator
    // signal (excluded from feed_health_rev) and safe to shed.
    expect(health.filter((f) => f.errorCount === 0 && f.crawlStale)).toHaveLength(
      MAX_HEALTH_REPORT_FEEDS - erroringCount
    );
  });

  it('reports only broken feeds, converting milliseconds to seconds', () => {
    const at = 1_770_000_000_000;
    breakFeed(FEED_URL, { errorCount: 4, at, retryAt: at + 600_000 });

    const health = selectFeedHealth(db);
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({
      feedUrl: FEED_URL,
      errorCount: 4,
      lastError: 'Failed to fetch (HTTP 404)',
      lastErrorAt: Math.floor(at / 1000),
      nextRetryAt: Math.floor((at + 600_000) / 1000),
    });
  });

  it('leaves healthy feeds out entirely — absence is the recovery signal', () => {
    seedCache(db, 'https://other.example/feed.xml', 'Other');
    breakFeed(FEED_URL);

    expect(selectFeedHealth(db).map((f) => f.feedUrl)).toEqual([FEED_URL]);
  });

  it('flags a crawl-set feed the warm loop has not fetched in hours', () => {
    // Nothing is erroring; the feed is simply losing its turn every tick, which
    // is what a capped warm batch does and what the admin needs to see.
    const now = Date.now();
    db.run('UPDATE cache SET fetched_at = ? WHERE url_hash = ?', [
      now - CRAWL_STALE_MS - 60_000,
      URL_HASH,
    ]);

    const health = selectFeedHealth(db, now);
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ feedUrl: FEED_URL, errorCount: 0, crawlStale: true });
  });

  it('does not flag a feed fetched within the window', () => {
    const now = Date.now();
    db.run('UPDATE cache SET fetched_at = ? WHERE url_hash = ?', [now - 60_000, URL_HASH]);
    expect(selectFeedHealth(db, now)).toHaveLength(0);
  });

  it('reports a feed that is both erroring and starved', () => {
    const now = Date.now();
    breakFeed(FEED_URL);
    db.run('UPDATE cache SET fetched_at = ? WHERE url_hash = ?', [
      now - CRAWL_STALE_MS - 60_000,
      URL_HASH,
    ]);

    const health = selectFeedHealth(db, now);
    expect(health[0]).toMatchObject({ errorCount: 3, crawlStale: true });
  });

  it('skips feeds that have dropped out of the crawl set', () => {
    // last_requested_at NULL = evicted / never registered, so nobody is
    // subscribed and its errors are not the reader's problem.
    breakFeed(FEED_URL);
    db.run('UPDATE cache SET last_requested_at = NULL WHERE url_hash = ?', [URL_HASH]);

    expect(selectFeedHealth(db)).toHaveLength(0);
  });

  it('posts the set to the Worker, and posts an empty set too', async () => {
    const endpoint = mockIngestEndpoint();
    await reportFeedHealth(db, CONFIG);

    expect(endpoint.calls[0].url).toBe('https://api.example/api/internal/feed-health');
    expect(endpoint.calls[0].headers['X-Proxy-Secret']).toBe('test-secret');
    // Everything is healthy: the empty list is what clears the Worker's flags.
    expect((endpoint.calls[0].body as unknown as { feeds: unknown[] }).feeds).toEqual([]);

    breakFeed(FEED_URL);
    const result = await reportFeedHealth(db, CONFIG);
    endpoint.restore();

    expect(result.reported).toBe(1);
    expect(
      (endpoint.calls[1].body as unknown as { feeds: Array<{ feedUrl: string }> }).feeds[0].feedUrl
    ).toBe(FEED_URL);
  });

  it('surfaces a rejected report instead of pretending it landed', async () => {
    breakFeed(FEED_URL);
    const endpoint = mockIngestEndpoint(503);
    const result = await reportFeedHealth(db, CONFIG);
    endpoint.restore();

    expect(result.reported).toBe(0);
    expect(result.error).toContain('503');
  });
});

describe('push loop (drain chaining, backoff, re-entrancy)', () => {
  interface Deferred {
    promise: Promise<PushResult>;
    resolve: (r: PushResult) => void;
    reject: (e: unknown) => void;
  }

  function deferred(): Deferred {
    let resolve!: (r: PushResult) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<PushResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // Let the loop's .then/.finally microtasks run.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  interface Harness {
    runPush: () => void;
    pushes: Deferred[];
    scheduled: Array<{ fn: () => void; delayMs: number }>;
    backoffCalls: number[];
    clock: { now: number };
  }

  function harness(): Harness {
    const pushes: Deferred[] = [];
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const backoffCalls: number[] = [];
    const clock = { now: 1_000_000 };
    const runPush = createPushLoop({
      push: () => {
        const d = deferred();
        pushes.push(d);
        return d.promise;
      },
      chainDelayMs: 1000,
      backoff: (failures) => {
        backoffCalls.push(failures);
        return 30_000;
      },
      schedule: (fn, delayMs) => scheduled.push({ fn, delayMs }),
      now: () => clock.now,
    });
    return { runPush, pushes, scheduled, backoffCalls, clock };
  }

  it('chains with the configured delay while a backlog remains, then stops', async () => {
    const h = harness();

    h.runPush();
    expect(h.pushes.length).toBe(1);
    h.pushes[0].resolve({ pushed: 100, hasMore: true });
    await settle();

    expect(h.scheduled.length).toBe(1);
    expect(h.scheduled[0].delayMs).toBe(1000);

    // The chained run drains the rest; no further chaining once hasMore=false.
    h.scheduled[0].fn();
    expect(h.pushes.length).toBe(2);
    h.pushes[1].resolve({ pushed: 50, hasMore: false });
    await settle();
    expect(h.scheduled.length).toBe(1);
  });

  it('never chains on a push that moved nothing, even with hasMore set', async () => {
    const h = harness();

    h.runPush();
    h.pushes[0].resolve({ pushed: 0, hasMore: true });
    await settle();

    expect(h.scheduled.length).toBe(0);
  });

  it('is a no-op while a push is already in flight', async () => {
    const h = harness();

    h.runPush();
    h.runPush();
    h.runPush();
    expect(h.pushes.length).toBe(1);

    h.pushes[0].resolve({ pushed: 1, hasMore: false });
    await settle();
    h.runPush();
    expect(h.pushes.length).toBe(2);
  });

  it('a failed push blocks the loop until the backoff elapses, without chaining', async () => {
    const h = harness();

    h.runPush();
    h.pushes[0].resolve({ pushed: 0, hasMore: false, error: 'HTTP 503' });
    await settle();
    expect(h.scheduled.length).toBe(0);

    // Inside the backoff window: refused.
    h.clock.now += 29_999;
    h.runPush();
    expect(h.pushes.length).toBe(1);

    // Past it: allowed again.
    h.clock.now += 2;
    h.runPush();
    expect(h.pushes.length).toBe(2);
  });

  it('the failure streak feeds the backoff and resets on success', async () => {
    const h = harness();

    h.runPush();
    h.pushes[0].resolve({ pushed: 0, hasMore: false, error: 'boom' });
    await settle();
    h.clock.now += 60_000;

    h.runPush();
    h.pushes[1].resolve({ pushed: 0, hasMore: false, error: 'boom' });
    await settle();
    h.clock.now += 60_000;

    h.runPush();
    h.pushes[2].resolve({ pushed: 5, hasMore: false });
    await settle();

    h.runPush();
    h.pushes[3].resolve({ pushed: 0, hasMore: false, error: 'boom' });
    await settle();

    expect(h.backoffCalls).toEqual([1, 2, 1]);
  });

  it('a rejected push reports the error and leaves the loop runnable', async () => {
    const errors: unknown[] = [];
    const pushes: Deferred[] = [];
    const runPush = createPushLoop({
      push: () => {
        const d = deferred();
        pushes.push(d);
        return d.promise;
      },
      chainDelayMs: 1000,
      backoff: () => 30_000,
      schedule: () => {},
      now: () => 0,
      onError: (e) => errors.push(e),
    });

    runPush();
    pushes[0].reject(new Error('network down'));
    await settle();
    expect(errors.length).toBe(1);

    runPush();
    expect(pushes.length).toBe(2);
  });
});
