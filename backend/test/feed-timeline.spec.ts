import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleIngest,
  handleCrawlSet,
  handleFeedHealth,
  clearFeedHealth,
  trimFeedsToSanityCap,
  ingestProxyFeed,
  CRAWLER_HEARTBEAT_KEY,
  FEED_HEALTH_REV_KEY,
  TIMELINE_ENABLED_KEY,
  CRAWL_ACTIVE_USER_WINDOW_SECONDS,
} from '../src/routes/ingest';
import { handleTimeline, readFeedSlice } from '../src/routes/timeline';
import type { Env, FeedItem, Session } from '../src/types';

const TEST_DID = 'did:plc:timeline123';
const OTHER_DID = 'did:plc:timelineother';
const SECRET = 'test-proxy-secret';

const FEED_A = 'https://example.com/a.xml';
const FEED_B = 'https://example.com/b.xml';

const SESSION: Session = {
  did: TEST_DID,
  handle: 'timeline.bsky.social',
  pdsUrl: 'https://test.pds.example',
  accessToken: 'token',
  refreshToken: 'refresh',
  dpopPrivateKey: '{}',
  expiresAt: Date.now() + 3600000,
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

function ingestRequest(
  body: unknown,
  secret: string | null = SECRET,
  extraHeaders: Record<string, string> = {}
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (secret !== null) headers['X-Proxy-Secret'] = secret;
  return new Request('https://api.example/api/internal/ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function ingest(
  feedUrl: string,
  items: Array<{ item: FeedItem; contentHash: string }>
): Promise<{ inserted: number; updated: number }> {
  const res = await handleIngest(
    ingestRequest({
      feeds: [{ feedUrl, title: 'Feed A' }],
      items: items.map((entry) => ({
        feedUrl,
        guid: entry.item.guid,
        item: entry.item,
        publishedAt: Date.parse(entry.item.publishedAt),
        firstSeenAt: Date.now(),
        contentHash: entry.contentHash,
      })),
    }),
    env
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { inserted: number; updated: number };
}

async function addSubscription(
  did: string,
  feedUrl: string,
  opts: { active?: number; sourceType?: string | null } = {}
) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, source_type, active)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      did,
      `at://${did}/app.skyreader.feed.subscription/${Math.random().toString(36).slice(2)}`,
      feedUrl,
      'Feed',
      opts.sourceType ?? null,
      opts.active ?? 1
    )
    .run();
}

async function timeline(params: Record<string, string> = {}) {
  const search = new URLSearchParams(params).toString();
  const res = await handleTimeline(
    new Request(`https://api.example/api/v2/timeline${search ? `?${search}` : ''}`),
    env,
    SESSION
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    items: Array<{ seq: number; feedUrl: string; guid: string; read: boolean; content?: string }>;
    cursor: number;
    generation: string;
    hasMore: boolean;
    nextColdOffset?: number;
    ingestActive: boolean;
    readCursor: number;
    coldStart: boolean;
    feeds?: Record<string, { title?: string }>;
    healthRev?: string;
    feedHealth?: Record<
      string,
      {
        errorCount: number;
        error?: string;
        lastErrorAt?: number;
        nextRetryAt?: number;
        lastFetchedAt?: number;
      }
    >;
  };
}

async function clearCrawlerHeartbeat() {
  await env.DB.prepare('DELETE FROM sync_state WHERE key = ?').bind(CRAWLER_HEARTBEAT_KEY).run();
}

async function setTimelineGate(value: string) {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(TIMELINE_ENABLED_KEY, value)
    .run();
}

async function clearTimelineGate() {
  await env.DB.prepare('DELETE FROM sync_state WHERE key = ?').bind(TIMELINE_ENABLED_KEY).run();
}

async function reportHealth(feeds: unknown[], secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Proxy-Secret'] = secret;
  return handleFeedHealth(
    new Request('https://api.example/api/internal/feed-health', {
      method: 'POST',
      headers,
      body: JSON.stringify({ feeds }),
    }),
    env
  );
}

function brokenFeed(feedUrl: string, overrides: Record<string, unknown> = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    feedUrl,
    errorCount: 3,
    lastError: 'Failed to fetch (HTTP 404)',
    lastErrorAt: nowSeconds,
    nextRetryAt: nowSeconds + 600,
    lastFetchAt: nowSeconds - 7200,
    ...overrides,
  };
}

describe('feed timeline (D1 ingest + serve)', () => {
  let savedSecret: string | undefined;

  beforeEach(async () => {
    savedSecret = (env as Env).FEED_PROXY_SECRET;
    (env as Env).FEED_PROXY_SECRET = SECRET;
    for (const did of [TEST_DID, OTHER_DID]) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO users (did, handle, pds_url, tier, created_at)
         VALUES (?, ?, 'https://test.pds.example', 'free', unixepoch())`
      )
        .bind(did, `${did}.test`)
        .run();
    }
  });

  afterEach(async () => {
    (env as Env).FEED_PROXY_SECRET = savedSecret as string;
    await env.DB.prepare('DELETE FROM feed_items').run();
    await env.DB.prepare('DELETE FROM feeds').run();
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await clearCrawlerHeartbeat();
    await env.DB.prepare('DELETE FROM sync_state WHERE key = ?').bind(FEED_HEALTH_REV_KEY).run();
    // Absent is the open position, so this restores the default the rest of the
    // suite runs under.
    await clearTimelineGate();
  });

  describe('ingest auth', () => {
    it('rejects a request with no secret', async () => {
      const res = await handleIngest(ingestRequest({ feeds: [], items: [] }, null), env);
      expect(res.status).toBe(401);
    });

    it('rejects a mismatched secret', async () => {
      const res = await handleIngest(ingestRequest({ feeds: [], items: [] }, 'nope'), env);
      expect(res.status).toBe(401);
    });

    it('fails closed when the server secret is unset', async () => {
      (env as Env).FEED_PROXY_SECRET = '' as string;
      const res = await handleIngest(ingestRequest({ feeds: [], items: [] }, SECRET), env);
      expect(res.status).toBe(401);
    });

    it('rejects an oversized body by Content-Length', async () => {
      const res = await handleIngest(
        ingestRequest({ feeds: [], items: [] }, SECRET, {
          'Content-Length': String(64 * 1024 * 1024),
        }),
        env
      );
      expect(res.status).toBe(413);
    });
  });

  describe('ingest writes', () => {
    it('inserts items and upserts feed metadata', async () => {
      const result = await ingest(FEED_A, [
        { item: item('g1'), contentHash: 'h1' },
        { item: item('g2'), contentHash: 'h2' },
      ]);
      expect(result.inserted).toBe(2);
      expect(result.updated).toBe(0);

      const feed = await env.DB.prepare('SELECT * FROM feeds WHERE feed_url = ?')
        .bind(FEED_A)
        .first<{ title: string; last_ingest_at: number }>();
      expect(feed?.title).toBe('Feed A');
      expect(feed?.last_ingest_at).toBeGreaterThan(0);
    });

    it('is idempotent: re-pushing the same batch creates no duplicates', async () => {
      await ingest(FEED_A, [{ item: item('g1'), contentHash: 'h1' }]);
      const before = await env.DB.prepare('SELECT seq FROM feed_items WHERE guid = ?')
        .bind('g1')
        .first<{ seq: number }>();

      const second = await ingest(FEED_A, [{ item: item('g1'), contentHash: 'h1' }]);
      expect(second.inserted).toBe(0);
      expect(second.updated).toBe(0);

      const rows = await env.DB.prepare('SELECT seq FROM feed_items WHERE guid = ?')
        .bind('g1')
        .all<{ seq: number }>();
      expect(rows.results.length).toBe(1);
      expect(rows.results[0].seq).toBe(before?.seq);
    });

    it('edits in place: a changed hash rewrites the row without a new seq', async () => {
      await ingest(FEED_A, [{ item: item('g1', { title: 'Old' }), contentHash: 'h1' }]);
      const before = await env.DB.prepare('SELECT seq FROM feed_items WHERE guid = ?')
        .bind('g1')
        .first<{ seq: number }>();

      const result = await ingest(FEED_A, [
        { item: item('g1', { title: 'New' }), contentHash: 'h2' },
      ]);
      expect(result.updated).toBe(1);
      expect(result.inserted).toBe(0);

      const after = await env.DB.prepare('SELECT seq, item_json FROM feed_items WHERE guid = ?')
        .bind('g1')
        .first<{ seq: number; item_json: string }>();
      expect(after?.seq).toBe(before?.seq);
      expect(JSON.parse(after!.item_json).title).toBe('New');
    });

    it('never prunes: a feed accumulates past the proxy’s 200-item window', async () => {
      // Five pushes of 50 distinct items each — well past the proxy's K = 200
      // outbox window. D1 is the archive; ordinary ingest deletes nothing.
      for (let batch = 0; batch < 5; batch++) {
        await ingest(
          FEED_A,
          Array.from({ length: 50 }, (_, i) => ({
            item: item(`b${batch}-i${i}`),
            contentHash: `h${batch}-${i}`,
          }))
        );
      }
      const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM feed_items WHERE feed_url = ?')
        .bind(FEED_A)
        .first<{ c: number }>();
      expect(count?.c).toBe(250);
    });

    it('sanity cap trims oldest-first, and only above the cap', async () => {
      await ingest(
        FEED_A,
        Array.from({ length: 5 }, (_, i) => ({ item: item(`s${i}`), contentHash: `h${i}` }))
      );

      // Under the cap: a no-op.
      await trimFeedsToSanityCap(env, [FEED_A], 10);
      let rows = await env.DB.prepare('SELECT guid FROM feed_items WHERE feed_url = ? ORDER BY seq')
        .bind(FEED_A)
        .all<{ guid: string }>();
      expect(rows.results.length).toBe(5);

      // Above the cap: the oldest go, newest survive.
      await trimFeedsToSanityCap(env, [FEED_A], 3);
      rows = await env.DB.prepare('SELECT guid FROM feed_items WHERE feed_url = ? ORDER BY seq')
        .bind(FEED_A)
        .all<{ guid: string }>();
      expect(rows.results.map((r) => r.guid)).toEqual(['s2', 's3', 's4']);
    });

    it('caps stored content and marks it truncated, leaving small items alone', async () => {
      const big = 'x'.repeat(9000);
      await ingest(FEED_A, [
        { item: item('big', { content: big, summary: 'kept' }), contentHash: 'hbig' },
        { item: item('small', { content: 'tiny' }), contentHash: 'hsmall' },
      ]);

      const bigRow = await env.DB.prepare('SELECT item_json FROM feed_items WHERE guid = ?')
        .bind('big')
        .first<{ item_json: string }>();
      const parsedBig = JSON.parse(bigRow!.item_json);
      expect(parsedBig.content).toBeUndefined();
      expect(parsedBig.contentTruncated).toBe(true);
      expect(parsedBig.summary).toBe('kept');

      const smallRow = await env.DB.prepare('SELECT item_json FROM feed_items WHERE guid = ?')
        .bind('small')
        .first<{ item_json: string }>();
      const parsedSmall = JSON.parse(smallRow!.item_json);
      expect(parsedSmall.content).toBe('tiny');
      expect(parsedSmall.contentTruncated).toBeUndefined();
    });
  });

  describe('pull-through ingest (proxy feed → archive)', () => {
    it('assigns seq oldest→newest, so the newest entries are what a per-feed read serves', async () => {
      // A proxy feed is newest-first. Ingesting it forward would give the newest
      // item the lowest seq, and every later `ORDER BY seq DESC` read would then
      // serve the feed's OLDEST items.
      const newestFirst = Array.from({ length: 5 }, (_, i) => item(`p${5 - i}`));
      await ingestProxyFeed(env, FEED_A, { title: 'Pulled', items: newestFirst });

      const rows = await env.DB.prepare(
        'SELECT guid, seq FROM feed_items WHERE feed_url = ? ORDER BY seq ASC'
      )
        .bind(FEED_A)
        .all<{ guid: string; seq: number }>();
      expect(rows.results.map((r) => r.guid)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);

      const slice = await readFeedSlice(env, TEST_DID, FEED_A, 2);
      expect(slice.map((i) => i.guid)).toEqual(['p5', 'p4']);
    });

    it('hashes identically to a later crawler push, so the push is a no-op', async () => {
      await ingestProxyFeed(env, FEED_A, { title: 'Pulled', items: [item('same')] });
      const before = await env.DB.prepare('SELECT seq, content_hash FROM feed_items WHERE guid = ?')
        .bind('same')
        .first<{ seq: number; content_hash: string }>();

      await ingestProxyFeed(env, FEED_A, { title: 'Pulled', items: [item('same')] });
      const rows = await env.DB.prepare('SELECT seq, content_hash FROM feed_items WHERE guid = ?')
        .bind('same')
        .all<{ seq: number; content_hash: string }>();
      expect(rows.results.length).toBe(1);
      expect(rows.results[0].seq).toBe(before?.seq);
      expect(rows.results[0].content_hash).toBe(before?.content_hash);
    });

    it('serves newest publications when pull-through and crawler ingest interleave', async () => {
      // Subscribe-time pull-through can write the newest proxy window before
      // the crawler's initial backlog reaches this feed. The older backlog then
      // has higher seq values, so per-feed reads must not use seq as recency.
      await ingestProxyFeed(env, FEED_A, {
        title: 'Pulled',
        items: [
          item('newest', { publishedAt: '2026-03-01T00:00:00.000Z' }),
          item('newer', { publishedAt: '2026-02-01T00:00:00.000Z' }),
        ],
      });
      await ingest(FEED_A, [
        {
          item: item('oldest', { publishedAt: '2025-12-01T00:00:00.000Z' }),
          contentHash: 'oldest-hash',
        },
        {
          item: item('older', { publishedAt: '2026-01-01T00:00:00.000Z' }),
          contentHash: 'older-hash',
        },
      ]);

      const slice = await readFeedSlice(env, TEST_DID, FEED_A, 2);
      expect(slice.map((i) => i.guid)).toEqual(['newest', 'newer']);

      await addSubscription(TEST_DID, FEED_A);
      const page = await timeline();
      expect(page.items.map((i) => i.guid)).toEqual(['newest', 'newer', 'older', 'oldest']);
    });
  });

  describe('crawl set', () => {
    it('requires the shared secret', async () => {
      const res = await handleCrawlSet(
        new Request('https://api.example/api/internal/crawl-set'),
        env
      );
      expect(res.status).toBe(401);
    });

    it('returns active RSS feeds with subscriber counts', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await addSubscription(OTHER_DID, FEED_A);
      await addSubscription(TEST_DID, FEED_B, { active: 0 });
      await addSubscription(TEST_DID, 'at://did:plc:x/pub', { sourceType: 'atproto.documents' });

      const res = await handleCrawlSet(
        new Request('https://api.example/api/internal/crawl-set', {
          headers: { 'X-Proxy-Secret': SECRET },
        }),
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        feeds: Array<{ feedUrl: string; subscribers: number }>;
      };
      expect(body.feeds).toEqual([{ feedUrl: FEED_A, subscribers: 2 }]);
    });

    describe('activity scoping', () => {
      const DORMANT_DID = 'did:plc:timelinedormant';
      // Comfortably outside the window, so neither timestamp counts as demand.
      const STALE = Math.floor(Date.now() / 1000) - CRAWL_ACTIVE_USER_WINDOW_SECONDS - 86400;

      async function seedUser(did: string, createdAt: number, lastActiveAt: number) {
        await env.DB.prepare(
          `INSERT INTO users (did, handle, pds_url, tier, created_at, last_active_at)
           VALUES (?, ?, 'https://test.pds.example', 'free', ?, ?)`
        )
          .bind(did, `${did}.test`, createdAt, lastActiveAt)
          .run();
      }

      async function crawlSet(): Promise<Array<{ feedUrl: string; subscribers: number }>> {
        const res = await handleCrawlSet(
          new Request('https://api.example/api/internal/crawl-set', {
            headers: { 'X-Proxy-Secret': SECRET },
          }),
          env
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          feeds: Array<{ feedUrl: string; subscribers: number }>;
        };
        return body.feeds;
      }

      afterEach(async () => {
        await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DORMANT_DID).run();
      });

      it('drops a feed whose only subscribers are dormant', async () => {
        await seedUser(DORMANT_DID, STALE, STALE);
        await addSubscription(TEST_DID, FEED_A);
        await addSubscription(DORMANT_DID, FEED_B);

        expect(await crawlSet()).toEqual([{ feedUrl: FEED_A, subscribers: 1 }]);
      });

      it('counts only recently-active subscribers, keeping the feed for the active one', async () => {
        await seedUser(DORMANT_DID, STALE, STALE);
        await addSubscription(TEST_DID, FEED_A);
        await addSubscription(DORMANT_DID, FEED_A);

        expect(await crawlSet()).toEqual([{ feedUrl: FEED_A, subscribers: 1 }]);
      });

      it('a stamped last_active_at keeps an old account in, without recent created_at', async () => {
        await seedUser(DORMANT_DID, STALE, Math.floor(Date.now() / 1000) - 60);
        await addSubscription(DORMANT_DID, FEED_B);

        expect(await crawlSet()).toEqual([{ feedUrl: FEED_B, subscribers: 1 }]);
      });
    });
  });

  describe('timeline serving', () => {
    it('cold-starts with a per-feed newest slice and inline read flags', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await addSubscription(TEST_DID, FEED_B);
      await ingest(FEED_A, [
        { item: item('a1'), contentHash: 'h1' },
        { item: item('a2'), contentHash: 'h2' },
      ]);
      await ingest(FEED_B, [{ item: item('b1'), contentHash: 'h3' }]);

      await env.DB.prepare(
        `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, created_at, updated_at)
         VALUES (?, 'a1', 'article', 'read', unixepoch(), unixepoch())`
      )
        .bind(TEST_DID)
        .run();

      const body = await timeline();
      expect(body.coldStart).toBe(true);
      expect(body.items.map((i) => i.guid).sort()).toEqual(['a1', 'a2', 'b1']);
      const byGuid = Object.fromEntries(body.items.map((i) => [i.guid, i.read]));
      expect(byGuid['a1']).toBe(true);
      expect(byGuid['a2']).toBe(false);
      expect(body.cursor).toBeGreaterThan(0);
      expect(body.hasMore).toBe(false);
      expect(typeof body.readCursor).toBe('number');
      expect(body.feeds?.[FEED_A]?.title).toBe('Feed A');
    });

    it('excludes parked, unsubscribed and atproto sources', async () => {
      await addSubscription(TEST_DID, FEED_A, { active: 0 });
      await addSubscription(OTHER_DID, FEED_B);
      await ingest(FEED_A, [{ item: item('a1'), contentHash: 'h1' }]);
      await ingest(FEED_B, [{ item: item('b1'), contentHash: 'h2' }]);

      const cold = await timeline();
      expect(cold.items).toEqual([]);

      // ...and the incremental path applies the same filter.
      const incremental = await timeline({ since_seq: '0', generation: cold.generation });
      expect(incremental.items).toEqual([]);
    });

    it('drains incrementally from the cursor, paging with hasMore', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [
        { item: item('i1'), contentHash: 'h1' },
        { item: item('i2'), contentHash: 'h2' },
        { item: item('i3'), contentHash: 'h3' },
      ]);

      const generation = (await timeline()).generation;
      const first = await timeline({ since_seq: '0', generation, limit: '2' });
      expect(first.coldStart).toBe(false);
      expect(first.items.map((i) => i.guid)).toEqual(['i1', 'i2']);
      expect(first.hasMore).toBe(true);

      const second = await timeline({
        since_seq: String(first.cursor),
        generation,
        limit: '2',
      });
      expect(second.items.map((i) => i.guid)).toEqual(['i3']);
      expect(second.hasMore).toBe(false);

      // Steady state: nothing new, cursor held, one empty page.
      const third = await timeline({ since_seq: String(second.cursor), generation, limit: '2' });
      expect(third.items).toEqual([]);
      expect(third.cursor).toBe(second.cursor);
      expect(third.hasMore).toBe(false);
      expect(third.feeds).toBeUndefined();
    });

    it('does not re-deliver an edited item (seq unchanged)', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [{ item: item('e1', { title: 'Old' }), contentHash: 'h1' }]);
      const cold = await timeline();

      await ingest(FEED_A, [{ item: item('e1', { title: 'New' }), contentHash: 'h2' }]);
      const after = await timeline({
        since_seq: String(cold.cursor),
        generation: cold.generation,
      });
      expect(after.items).toEqual([]);
    });

    it('cold-starts again on a generation mismatch', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [{ item: item('g1'), contentHash: 'h1' }]);

      const body = await timeline({ since_seq: '999999', generation: 'stale-generation' });
      expect(body.coldStart).toBe(true);
      expect(body.items.map((i) => i.guid)).toEqual(['g1']);
    });

    it('starts an empty account at the archive head, not at zero', async () => {
      await addSubscription(TEST_DID, FEED_B);
      await ingest(FEED_A, [{ item: item('other'), contentHash: 'h1' }]);

      const body = await timeline();
      expect(body.items).toEqual([]);
      expect(body.cursor).toBeGreaterThan(0);
    });

    it('cold-starts a client whose cursor sits above the head (rewound archive)', async () => {
      // The generation survives a Time Travel restore while the seqs rewind, so a
      // cursor above the head is the only symptom — and `seq > cursor` would
      // otherwise return nothing on every poll, forever.
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [{ item: item('r1'), contentHash: 'h1' }]);
      const cold = await timeline();

      const stalled = await timeline({
        since_seq: String(cold.cursor + 5000),
        generation: cold.generation,
      });
      expect(stalled.coldStart).toBe(true);
      expect(stalled.items.map((i) => i.guid)).toEqual(['r1']);
      expect(stalled.cursor).toBeLessThan(cold.cursor + 5000);
    });

    it('pages a large cold start and continues from nextColdOffset', async () => {
      // 26 feeds × 30 items is past the per-page item budget, so the first page
      // stops early and hands back a continuation index.
      const feedUrls = Array.from({ length: 26 }, (_, i) => `https://example.com/paged${i}.xml`);
      for (const feedUrl of feedUrls) {
        await addSubscription(TEST_DID, feedUrl);
        await ingest(
          feedUrl,
          Array.from({ length: 30 }, (_, i) => ({
            item: item(`${feedUrl}#${i}`),
            contentHash: `${feedUrl}-${i}`,
          }))
        );
      }

      const first = await timeline();
      expect(first.coldStart).toBe(true);
      expect(first.hasMore).toBe(true);
      expect(first.nextColdOffset).toBeGreaterThan(0);
      expect(first.items.length).toBeLessThan(26 * 30);

      const second = await timeline({ cold_offset: String(first.nextColdOffset) });
      expect(second.coldStart).toBe(true);
      expect(second.hasMore).toBe(false);
      expect(second.items.length).toBeGreaterThan(0);

      // Every feed is covered across the two pages, each with its newest slice.
      const seen = new Set([...first.items, ...second.items].map((i) => i.feedUrl));
      expect(seen.size).toBe(26);
      expect(first.items.length + second.items.length).toBe(26 * 30);
    });
  });

  describe('crawler liveness (ingestActive)', () => {
    it('is false until the crawler checks in', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await clearCrawlerHeartbeat();
      const body = await timeline();
      expect(body.ingestActive).toBe(false);
    });

    it('is true after an ingest push', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [{ item: item('h1'), contentHash: 'h1' }]);
      expect((await timeline()).ingestActive).toBe(true);
    });

    it('is true after a crawl-set pull, even with nothing ingested', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await clearCrawlerHeartbeat();
      const res = await handleCrawlSet(
        new Request('https://api.example/api/internal/crawl-set', {
          headers: { 'X-Proxy-Secret': SECRET },
        }),
        env
      );
      expect(res.status).toBe(200);

      const body = await timeline();
      expect(body.ingestActive).toBe(true);
      expect(body.items).toEqual([]);
    });

    it('goes stale when the last heartbeat is old', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await env.DB.prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
        .bind(CRAWLER_HEARTBEAT_KEY, String(Math.floor(Date.now() / 1000) - 4 * 3600))
        .run();

      expect((await timeline()).ingestActive).toBe(false);
    });
  });

  describe('rollout gate (timeline_enabled)', () => {
    it('holds clients on the batch path while the gate is shut, however live the crawler', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [{ item: item('g1'), contentHash: 'g1' }]);
      expect((await timeline()).ingestActive).toBe(true);

      await setTimelineGate('0');
      const gated = await timeline();
      expect(gated.ingestActive).toBe(false);
      // The whole point of the short-circuit: a page the client is about to throw
      // away is never built, so the gated window costs one sync_state read.
      expect(gated.items).toEqual([]);
      // Both fallback signals agree, so a client reading either one stays put.
      expect(gated.coldStart).toBe(true);
      expect(gated.hasMore).toBe(false);
    });

    it('reopens without a deploy, serving the archive that filled while it was shut', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await setTimelineGate('0');
      // Ingest keeps running while the gate is shut — that is the sequencing the
      // gate exists to allow: fill the archive first, admit readers second.
      await ingest(FEED_A, [{ item: item('g2'), contentHash: 'g2' }]);
      expect((await timeline()).items).toEqual([]);

      await setTimelineGate('1');
      const open = await timeline();
      expect(open.ingestActive).toBe(true);
      expect(open.items.map((i) => i.guid)).toEqual(['g2']);
    });

    it('is open when the row is absent, so an environment that never set it is unaffected', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [{ item: item('g3'), contentHash: 'g3' }]);
      await clearTimelineGate();
      expect((await timeline()).ingestActive).toBe(true);
    });

    it('still requires a live crawler when open', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [{ item: item('g4'), contentHash: 'g4' }]);
      await setTimelineGate('1');
      await clearCrawlerHeartbeat();
      expect((await timeline()).ingestActive).toBe(false);
    });
  });

  describe('feed health', () => {
    it('requires the shared secret', async () => {
      expect((await reportHealth([brokenFeed(FEED_A)], null)).status).toBe(401);
      expect((await reportHealth([brokenFeed(FEED_A)], 'nope')).status).toBe(401);
    });

    it('stamps the crawler heartbeat like the other internal endpoints', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await clearCrawlerHeartbeat();
      expect((await reportHealth([])).status).toBe(200);
      expect((await timeline()).ingestActive).toBe(true);
    });

    it('serves a broken feed to its subscribers, in milliseconds', async () => {
      await addSubscription(TEST_DID, FEED_A);
      const report = brokenFeed(FEED_A);
      await reportHealth([report]);

      const body = await timeline();
      expect(body.feedHealth?.[FEED_A]).toEqual({
        errorCount: 3,
        error: 'Failed to fetch (HTTP 404)',
        lastErrorAt: report.lastErrorAt * 1000,
        nextRetryAt: report.nextRetryAt * 1000,
        lastFetchedAt: report.lastFetchAt * 1000,
      });
    });

    it('records a feed that has never ingested a single item', async () => {
      // Broken from its first crawl: no items were ever pushed, so there is no
      // `feeds` row for the health report to update.
      await addSubscription(TEST_DID, FEED_B);
      await reportHealth([brokenFeed(FEED_B)]);
      expect((await timeline()).feedHealth?.[FEED_B]?.errorCount).toBe(3);
    });

    it('does not leak another user’s broken feeds', async () => {
      await addSubscription(OTHER_DID, FEED_B);
      await addSubscription(TEST_DID, FEED_A);
      await reportHealth([brokenFeed(FEED_A), brokenFeed(FEED_B)]);

      const body = await timeline();
      expect(Object.keys(body.feedHealth ?? {})).toEqual([FEED_A]);
    });

    it('clears a feed that recovers, by absence from the next report', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await reportHealth([brokenFeed(FEED_A)]);
      expect((await timeline()).feedHealth?.[FEED_A]).toBeDefined();

      // The crawler no longer lists it — that is the whole recovery signal.
      await reportHealth([]);
      expect((await timeline()).feedHealth?.[FEED_A]).toBeUndefined();
    });

    it('recovers one feed without disturbing another that is still broken', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await addSubscription(TEST_DID, FEED_B);
      await reportHealth([brokenFeed(FEED_A), brokenFeed(FEED_B)]);
      await reportHealth([brokenFeed(FEED_B)]);

      const body = await timeline();
      expect(Object.keys(body.feedHealth ?? {})).toEqual([FEED_B]);
    });

    it('omits the payload when the client already holds the current revision', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await reportHealth([brokenFeed(FEED_A)]);

      const first = await timeline();
      expect(first.feedHealth).toBeDefined();
      expect(first.healthRev).toBeTruthy();

      // Steady state: the client echoes the revision back and pays nothing.
      const second = await timeline({
        since_seq: String(first.cursor),
        generation: first.generation,
        health_rev: first.healthRev!,
      });
      expect(second.feedHealth).toBeUndefined();
      expect(second.healthRev).toBe(first.healthRev);
    });

    it('re-sends the payload once the unhealthy set changes', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await addSubscription(TEST_DID, FEED_B);
      await reportHealth([brokenFeed(FEED_A)]);
      const first = await timeline();

      await reportHealth([brokenFeed(FEED_A), brokenFeed(FEED_B, { errorCount: 1 })]);
      const second = await timeline({
        since_seq: String(first.cursor),
        generation: first.generation,
        health_rev: first.healthRev!,
      });

      expect(second.healthRev).not.toBe(first.healthRev);
      expect(Object.keys(second.feedHealth ?? {}).sort()).toEqual([FEED_A, FEED_B].sort());
    });

    it('always sends health on a cold start, whatever revision the client claims', async () => {
      // A cold start replays already-archived items, including from a feed that
      // has broken since — so its blanket "these delivered, they're fine" pass
      // must be corrected in the same response.
      await addSubscription(TEST_DID, FEED_A);
      await ingest(FEED_A, [{ item: item('c1'), contentHash: 'c1' }]);
      await reportHealth([brokenFeed(FEED_A)]);

      const rev = (await timeline()).healthRev!;
      const cold = await timeline({ health_rev: rev });
      expect(cold.coldStart).toBe(true);
      expect(cold.items).toHaveLength(1);
      expect(cold.feedHealth?.[FEED_A]).toBeDefined();
    });

    it('clearFeedHealth clears one feed and moves the revision', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await addSubscription(TEST_DID, FEED_B);
      await reportHealth([brokenFeed(FEED_A), brokenFeed(FEED_B)]);
      const before = (await timeline()).healthRev;

      await clearFeedHealth(env as Env, FEED_A);

      const body = await timeline();
      expect(Object.keys(body.feedHealth ?? {})).toEqual([FEED_B]);
      expect(body.healthRev).not.toBe(before);
    });

    it('flags a starved feed without telling readers anything', async () => {
      // `crawl_stale` is an operator signal: the crawler isn't reaching the feed,
      // but nothing is erroring, so the reader has no error to show.
      await addSubscription(TEST_DID, FEED_A);
      await reportHealth([{ feedUrl: FEED_A, errorCount: 0, crawlStale: true }]);

      const body = await timeline();
      expect(body.feedHealth?.[FEED_A]).toBeUndefined();

      const row = await env.DB.prepare(
        'SELECT error_count, crawl_stale FROM feeds WHERE feed_url = ?'
      )
        .bind(FEED_A)
        .first<{ error_count: number; crawl_stale: number }>();
      expect(row).toMatchObject({ error_count: 0, crawl_stale: 1 });
    });

    it('clears a starved flag once the crawler catches up', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await reportHealth([{ feedUrl: FEED_A, errorCount: 0, crawlStale: true }]);
      await reportHealth([]);

      const row = await env.DB.prepare('SELECT crawl_stale FROM feeds WHERE feed_url = ?')
        .bind(FEED_A)
        .first<{ crawl_stale: number }>();
      expect(row?.crawl_stale).toBe(0);
    });

    it('carries both flags for a feed that is erroring and starved', async () => {
      await addSubscription(TEST_DID, FEED_A);
      await reportHealth([brokenFeed(FEED_A, { crawlStale: true })]);

      const row = await env.DB.prepare(
        'SELECT error_count, crawl_stale FROM feeds WHERE feed_url = ?'
      )
        .bind(FEED_A)
        .first<{ error_count: number; crawl_stale: number }>();
      expect(row).toMatchObject({ error_count: 3, crawl_stale: 1 });
      // Readers still see the error, which is the part they can act on.
      expect((await timeline()).feedHealth?.[FEED_A]?.errorCount).toBe(3);
    });

    it('ignores an entry that claims no fault at all', async () => {
      // Otherwise a healthy feed listed by mistake would stay flagged forever.
      await addSubscription(TEST_DID, FEED_A);
      await reportHealth([{ feedUrl: FEED_A, errorCount: 0, crawlStale: false }]);

      const row = await env.DB.prepare('SELECT feed_url FROM feeds WHERE feed_url = ?')
        .bind(FEED_A)
        .first();
      expect(row).toBeNull();
    });

    it('leaves the revision alone when only the starved flag moves', async () => {
      // The reader payload holds erroring feeds only, so a crawl-capacity change
      // must not make every client re-download it.
      await addSubscription(TEST_DID, FEED_A);
      await reportHealth([brokenFeed(FEED_A)]);
      const before = (await timeline()).healthRev;

      await addSubscription(TEST_DID, FEED_B);
      await reportHealth([
        brokenFeed(FEED_A),
        { feedUrl: FEED_B, errorCount: 0, crawlStale: true },
      ]);
      expect((await timeline()).healthRev).toBe(before);
    });

    it('leaves the revision alone when a report changes nothing', async () => {
      await addSubscription(TEST_DID, FEED_A);
      const report = brokenFeed(FEED_A);
      await reportHealth([report]);
      const first = (await timeline()).healthRev;

      await reportHealth([report]);
      expect((await timeline()).healthRev).toBe(first);
    });
  });
});
