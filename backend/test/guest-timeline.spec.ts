import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleGuestStarterFeeds, handleGuestTimeline } from '../src/routes/guest';
import { CRAWLER_HEARTBEAT_KEY, TIMELINE_ENABLED_KEY } from '../src/routes/ingest';
import { STARTER_CHANNELS, STARTER_FEED_URLS } from '../src/config/starter-feeds';

/**
 * The unauthenticated half of guest reading mode: the starter channels and a
 * timeline over a caller-supplied feed list. Both are read-only — nothing here
 * ever fetches, and no unauthenticated path writes to the archive.
 */

const FEED_A = 'https://example.com/guest-a.xml';
const FEED_B = 'https://example.com/guest-b.xml';
const FEED_C = 'https://example.com/guest-c.xml';

interface GuestPage {
  items: Array<{ guid: string; seq: number; feedUrl: string; read: boolean }>;
  cursor: number;
  generation: string;
  ingestActive: boolean;
  hasMore: boolean;
  nextColdOffset?: number;
  readCursor: number;
  coldStart: boolean;
  healthRev?: string;
}

function timelineRequest(body: unknown, ip = '203.0.113.1'): Request {
  return new Request('https://api.example/api/guest/timeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function timeline(body: unknown): Promise<GuestPage> {
  const res = await handleGuestTimeline(timelineRequest(body), env);
  expect(res.status).toBe(200);
  return (await res.json()) as GuestPage;
}

async function generation(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT value FROM sync_state WHERE key = 'items_generation'"
  ).first<{ value: string }>();
  return row?.value ?? '';
}

/** Insert items directly so seq order (the cursor's meaning) is explicit. */
async function seed(feedUrl: string, guids: string[]): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO feeds (feed_url, title, last_ingest_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(feed_url) DO UPDATE SET last_ingest_at = unixepoch()`
  )
    .bind(feedUrl, `Feed ${feedUrl}`)
    .run();
  for (const guid of guids) {
    await env.DB.prepare(
      `INSERT INTO feed_items (feed_url, guid, item_json, published_at, first_seen_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        feedUrl,
        guid,
        JSON.stringify({
          guid,
          url: `${feedUrl}#${guid}`,
          title: `Title ${guid}`,
          publishedAt: '2026-01-01T00:00:00.000Z',
        }),
        Date.parse('2026-01-01T00:00:00.000Z'),
        Date.now(),
        `hash-${guid}`
      )
      .run();
  }
}

async function stampHeartbeat(secondsAgo = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(CRAWLER_HEARTBEAT_KEY, String(Math.floor(Date.now() / 1000) - secondsAgo))
    .run();
}

describe('guest reading mode (unauthenticated archive reads)', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // The guest surface is read-only over the archive. Anything that reaches
    // the network from here would be an unauthenticated caller steering a
    // fetch, so make that impossible to do quietly.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`guest surface must not fetch: ${input.toString()}`);
    }) as unknown as typeof fetch;
    await stampHeartbeat();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await env.DB.prepare('DELETE FROM feed_items').run();
    await env.DB.prepare('DELETE FROM feeds').run();
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM rate_limits').run();
    await env.DB.prepare('DELETE FROM sync_state WHERE key = ?').bind(CRAWLER_HEARTBEAT_KEY).run();
    await env.DB.prepare('DELETE FROM sync_state WHERE key = ?').bind(TIMELINE_ENABLED_KEY).run();
  });

  describe('starter feeds', () => {
    it('serves the curated channels with a public cache header', async () => {
      const res = handleGuestStarterFeeds(
        new Request('https://api.example/api/guest/starter-feeds')
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
      const body = (await res.json()) as { channels: typeof STARTER_CHANNELS };
      expect(body.channels.map((c) => c.key)).toEqual(['essays', 'tech', 'science']);
      expect(body.channels.flatMap((c) => c.feeds.map((f) => f.feedUrl))).toEqual(
        STARTER_FEED_URLS
      );
    });

    it('rejects a non-GET', async () => {
      const res = handleGuestStarterFeeds(
        new Request('https://api.example/api/guest/starter-feeds', { method: 'POST' })
      );
      expect(res.status).toBe(405);
    });
  });

  describe('request validation', () => {
    it('rejects a non-POST', async () => {
      const res = await handleGuestTimeline(
        new Request('https://api.example/api/guest/timeline'),
        env
      );
      expect(res.status).toBe(405);
    });

    it('rejects a malformed body', async () => {
      const res = await handleGuestTimeline(timelineRequest('{not json'), env);
      expect(res.status).toBe(400);
    });

    it('rejects feedUrls that is not an array of strings', async () => {
      for (const feedUrls of [undefined, 'https://example.com/a.xml', [42], [null]]) {
        const res = await handleGuestTimeline(timelineRequest({ feedUrls }), env);
        expect(res.status).toBe(400);
      }
    });

    it('rejects more than 50 feeds', async () => {
      const feedUrls = Array.from({ length: 51 }, (_, i) => `https://example.com/${i}.xml`);
      const res = await handleGuestTimeline(timelineRequest({ feedUrls }), env);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('50');
    });

    it('rejects a non-http(s) scheme', async () => {
      for (const url of ['ftp://example.com/a.xml', 'javascript:alert(1)', 'file:///etc/passwd']) {
        const res = await handleGuestTimeline(timelineRequest({ feedUrls: [url] }), env);
        expect(res.status).toBe(400);
      }
    });

    it('dedupes repeated feed URLs rather than serving them twice', async () => {
      await seed(FEED_A, ['a1', 'a2']);
      const page = await timeline({ feedUrls: [FEED_A, FEED_A, FEED_A] });
      expect(page.items.map((i) => i.guid).sort()).toEqual(['a1', 'a2']);
    });

    it('accepts an empty feed list', async () => {
      const page = await timeline({ feedUrls: [] });
      expect(page.items).toEqual([]);
      expect(page.hasMore).toBe(false);
    });
  });

  describe('ingest gate', () => {
    it('short-circuits when the crawler heartbeat is stale', async () => {
      await env.DB.prepare('DELETE FROM sync_state WHERE key = ?')
        .bind(CRAWLER_HEARTBEAT_KEY)
        .run();
      await seed(FEED_A, ['a1']);

      const page = await timeline({ feedUrls: [FEED_A] });
      expect(page.ingestActive).toBe(false);
      expect(page.items).toEqual([]);
      expect(page.coldStart).toBe(true);
      expect(page.hasMore).toBe(false);
      expect(page.cursor).toBe(0);
      expect(page.generation).toBe(await generation());
    });

    it('short-circuits when the rollout gate is closed', async () => {
      await env.DB.prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, '0', unixepoch())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
        .bind(TIMELINE_ENABLED_KEY)
        .run();
      await seed(FEED_A, ['a1']);

      const page = await timeline({ feedUrls: [FEED_A] });
      expect(page.ingestActive).toBe(false);
      expect(page.items).toEqual([]);
    });
  });

  describe('cold start', () => {
    it('serves a slice per feed with the archive head as its cursor', async () => {
      await seed(FEED_A, ['a1', 'a2']);
      await seed(FEED_B, ['b1']);

      const page = await timeline({ feedUrls: [FEED_A, FEED_B] });
      expect(page.coldStart).toBe(true);
      expect(page.ingestActive).toBe(true);
      expect(page.items.map((i) => i.guid).sort()).toEqual(['a1', 'a2', 'b1']);
      expect(page.cursor).toBe(Math.max(...page.items.map((i) => i.seq)));
      expect(page.hasMore).toBe(false);
      expect(page.nextColdOffset).toBeUndefined();
    });

    it('never leaks items from a feed the caller did not ask for', async () => {
      await seed(FEED_A, ['a1']);
      await seed(FEED_B, ['b1']);

      const page = await timeline({ feedUrls: [FEED_A] });
      expect(page.items.map((i) => i.guid)).toEqual(['a1']);
    });

    it('returns no rows (and no error) for an unknown feed', async () => {
      const page = await timeline({ feedUrls: ['https://example.com/never-crawled.xml'] });
      expect(page.items).toEqual([]);
      expect(page.cursor).toBe(0);
    });

    it('pages the feed list and hands back a continuation offset', async () => {
      const feedUrls = Array.from(
        { length: 30 },
        (_, i) => `https://example.com/p${String(i).padStart(2, '0')}.xml`
      );
      await seed(feedUrls[0], ['first']);
      await seed(feedUrls[29], ['last']);

      const first = await timeline({ feedUrls });
      expect(first.hasMore).toBe(true);
      expect(first.nextColdOffset).toBe(25);
      // The handler sorts the list, so p00 lands on the first page and p29 on the second.
      expect(first.items.map((i) => i.guid)).toContain('first');

      const second = await timeline({ feedUrls, cold_offset: first.nextColdOffset });
      expect(second.coldStart).toBe(true);
      expect(second.hasMore).toBe(false);
      expect(second.items.map((i) => i.guid)).toContain('last');
    });

    it('caps the per-feed slice', async () => {
      await seed(
        FEED_A,
        Array.from({ length: 35 }, (_, i) => `a${i}`)
      );
      const page = await timeline({ feedUrls: [FEED_A] });
      expect(page.items).toHaveLength(30);
    });

    it('stamps every item unread and reports no read cursor', async () => {
      await seed(FEED_A, ['a1']);
      const page = await timeline({ feedUrls: [FEED_A] });
      expect(page.items[0].read).toBe(false);
      expect(page.readCursor).toBe(0);
    });
  });

  describe('incremental', () => {
    it('returns only items above the cursor, oldest first', async () => {
      await seed(FEED_A, ['a1', 'a2']);
      const cold = await timeline({ feedUrls: [FEED_A] });
      await seed(FEED_A, ['a3', 'a4']);

      const page = await timeline({
        feedUrls: [FEED_A],
        since_seq: cold.cursor,
        generation: cold.generation,
      });
      expect(page.coldStart).toBe(false);
      expect(page.items.map((i) => i.guid)).toEqual(['a3', 'a4']);
      expect(page.cursor).toBe(page.items.at(-1)!.seq);
    });

    it('cold-starts when the generation does not match', async () => {
      await seed(FEED_A, ['a1']);
      const page = await timeline({
        feedUrls: [FEED_A],
        since_seq: 999999,
        generation: 'a-restored-database',
      });
      expect(page.coldStart).toBe(true);
      expect(page.items.map((i) => i.guid)).toEqual(['a1']);
    });

    it('reports hasMore when the page is full', async () => {
      await seed(FEED_A, ['a1', 'a2', 'a3']);
      const page = await timeline({
        feedUrls: [FEED_A],
        since_seq: 0,
        generation: await generation(),
        limit: 2,
      });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);

      const next = await timeline({
        feedUrls: [FEED_A],
        since_seq: page.cursor,
        generation: page.generation,
        limit: 2,
      });
      expect(next.items.map((i) => i.guid)).toEqual(['a3']);
      expect(next.hasMore).toBe(false);
    });

    // A D1 Time Travel restore rewinds feed_items.seq while items_generation
    // comes back unchanged, so a stored cursor ends up above the head and
    // `seq > ?` returns nothing forever. A guest has no other sync path to heal
    // from, so the empty page has to fall back to a cold start.
    it('cold-starts when the cursor is above a rewound archive head', async () => {
      await seed(FEED_A, ['a1', 'a2']);
      const head = await env.DB.prepare('SELECT MAX(seq) AS seq FROM feed_items').first<{
        seq: number;
      }>();

      const page = await timeline({
        feedUrls: [FEED_A],
        since_seq: head!.seq + 5000,
        generation: await generation(),
      });

      expect(page.coldStart).toBe(true);
      expect(page.items.map((i) => i.guid).sort()).toEqual(['a1', 'a2']);
      expect(page.cursor).toBe(head!.seq);
    });

    // The guard costs a MAX(seq) only on an empty page, and must never fire on
    // the ordinary "nothing new since last poll" case.
    it('stays incremental on an empty page below the head', async () => {
      await seed(FEED_A, ['a1']);
      const cold = await timeline({ feedUrls: [FEED_A] });

      const page = await timeline({
        feedUrls: [FEED_A],
        since_seq: cold.cursor,
        generation: cold.generation,
      });

      expect(page.coldStart).toBe(false);
      expect(page.items).toEqual([]);
      expect(page.cursor).toBe(cold.cursor);
    });

    it('excludes items from feeds outside the supplied list', async () => {
      await seed(FEED_A, ['a1']);
      await seed(FEED_B, ['b1']);
      const page = await timeline({
        feedUrls: [FEED_B],
        since_seq: 0,
        generation: await generation(),
      });
      expect(page.items.map((i) => i.guid)).toEqual(['b1']);
    });
  });
});
