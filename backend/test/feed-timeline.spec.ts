import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleIngest, handleCrawlSet, trimFeedsToSanityCap } from '../src/routes/ingest';
import { handleTimeline } from '../src/routes/timeline';
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
    readCursor: number;
    coldStart: boolean;
    feeds?: Record<string, { title?: string }>;
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
  });
});
