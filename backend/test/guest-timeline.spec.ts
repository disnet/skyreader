import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleGuestStarterFeeds,
  handleGuestTimeline,
  handleGuestFeedWarm,
  reapOrphanGuestFeeds,
} from '../src/routes/guest';
import { CRAWLER_HEARTBEAT_KEY, TIMELINE_ENABLED_KEY } from '../src/routes/ingest';
import { STARTER_CHANNELS, STARTER_FEED_URLS } from '../src/config/starter-feeds';
import type { Env } from '../src/types';

/**
 * The unauthenticated half of guest reading mode: a timeline over a
 * caller-supplied feed list (read-only, never fetches) and the warm endpoint
 * that is the one way a guest's own feed reaches the shared archive.
 */

const FEED_A = 'https://example.com/guest-a.xml';
const FEED_B = 'https://example.com/guest-b.xml';
const FEED_C = 'https://example.com/guest-c.xml';
const STARTER = STARTER_FEED_URLS[0];

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

function warmRequest(body: unknown, ip = '203.0.113.2'): Request {
  return new Request('https://api.example/api/guest/feeds/warm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function timeline(body: unknown, ctx?: ExecutionContext): Promise<GuestPage> {
  const res = await handleGuestTimeline(timelineRequest(body), env, ctx);
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

async function setGuestWarmedAt(feedUrl: string, secondsAgo: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO feeds (feed_url, guest_warmed_at) VALUES (?, unixepoch() - ?)
     ON CONFLICT(feed_url) DO UPDATE SET guest_warmed_at = unixepoch() - ?`
  )
    .bind(feedUrl, secondsAgo, secondsAgo)
    .run();
}

async function warmedAt(feedUrl: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT guest_warmed_at FROM feeds WHERE feed_url = ?')
    .bind(feedUrl)
    .first<{ guest_warmed_at: number | null }>();
  return row?.guest_warmed_at ?? null;
}

describe('guest reading mode (unauthenticated archive reads)', () => {
  let originalFetch: typeof fetch;
  let proxyCalls: string[];

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    proxyCalls = [];
    (env as Env).FEED_PROXY_URL = 'https://proxy.example';
    (env as Env).FEED_PROXY_SECRET = 'test-secret';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      proxyCalls.push(typeof input === 'string' ? input : input.toString());
      return new Response(
        JSON.stringify({
          feed: {
            title: 'Warmed Feed',
            siteUrl: 'https://example.com',
            items: [
              {
                guid: 'warmed-1',
                url: 'https://example.com/warmed-1',
                title: 'Warmed',
                publishedAt: '2026-01-02T00:00:00.000Z',
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
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

  describe('lazy re-warm', () => {
    it('re-warms a stale guest-added feed after the response', async () => {
      await seed(FEED_A, ['a1']);
      await setGuestWarmedAt(FEED_A, 60 * 60);
      const before = await warmedAt(FEED_A);

      const ctx = createExecutionContext();
      await timeline({ feedUrls: [FEED_A] }, ctx);
      await waitOnExecutionContext(ctx);

      expect(proxyCalls).toHaveLength(1);
      expect(await warmedAt(FEED_A)).toBeGreaterThan(before!);
    });

    it('leaves a freshly warmed feed alone', async () => {
      await seed(FEED_A, ['a1']);
      await setGuestWarmedAt(FEED_A, 60);

      const ctx = createExecutionContext();
      await timeline({ feedUrls: [FEED_A] }, ctx);
      await waitOnExecutionContext(ctx);

      expect(proxyCalls).toEqual([]);
    });

    it('never touches crawler-owned or starter feeds', async () => {
      await seed(FEED_A, ['a1']);
      await seed(STARTER, ['s1']);
      await setGuestWarmedAt(STARTER, 60 * 60);

      const ctx = createExecutionContext();
      await timeline({ feedUrls: [FEED_A, STARTER] }, ctx);
      await waitOnExecutionContext(ctx);

      expect(proxyCalls).toEqual([]);
    });

    it('re-warms at most two feeds per request', async () => {
      for (const url of [FEED_A, FEED_B, FEED_C]) {
        await seed(url, ['x']);
        await setGuestWarmedAt(url, 60 * 60);
      }

      const ctx = createExecutionContext();
      await timeline({ feedUrls: [FEED_A, FEED_B, FEED_C] }, ctx);
      await waitOnExecutionContext(ctx);

      expect(proxyCalls).toHaveLength(2);
    });

    it('never creates a feed row from the read path', async () => {
      const ctx = createExecutionContext();
      await timeline({ feedUrls: ['https://example.com/unknown.xml'] }, ctx);
      await waitOnExecutionContext(ctx);

      expect(proxyCalls).toEqual([]);
      const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM feeds').first<{ c: number }>();
      expect(count?.c).toBe(0);
    });
  });

  describe('warm', () => {
    it('rejects a non-POST, a malformed body and a non-http(s) URL', async () => {
      expect(
        (await handleGuestFeedWarm(new Request('https://api.example/api/guest/feeds/warm'), env))
          .status
      ).toBe(405);
      expect((await handleGuestFeedWarm(warmRequest('{nope'), env)).status).toBe(400);
      expect(
        (await handleGuestFeedWarm(warmRequest({ feedUrl: 'ftp://example.com/a.xml' }), env)).status
      ).toBe(400);
      expect((await handleGuestFeedWarm(warmRequest({}), env)).status).toBe(400);
    });

    it('warms an unknown feed into the archive and claims its slot', async () => {
      const res = await handleGuestFeedWarm(warmRequest({ feedUrl: FEED_A }), env);
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true, itemCount: 1 });
      expect(proxyCalls).toHaveLength(1);
      expect(await warmedAt(FEED_A)).toBeGreaterThan(0);

      const rows = await env.DB.prepare('SELECT guid FROM feed_items WHERE feed_url = ?')
        .bind(FEED_A)
        .all<{ guid: string }>();
      expect(rows.results.map((r) => r.guid)).toEqual(['warmed-1']);
    });

    it('is a no-op for a feed warmed inside the freshness window', async () => {
      await setGuestWarmedAt(FEED_A, 60);
      const res = await handleGuestFeedWarm(warmRequest({ feedUrl: FEED_A }), env);
      expect((await res.json()) as { fresh: boolean }).toMatchObject({ ok: true, fresh: true });
      expect(proxyCalls).toEqual([]);
    });

    it('is a no-op for a feed the crawler just ingested', async () => {
      await seed(FEED_A, ['a1']);
      const res = await handleGuestFeedWarm(warmRequest({ feedUrl: FEED_A }), env);
      expect((await res.json()) as { fresh: boolean }).toMatchObject({ fresh: true });
      expect(proxyCalls).toEqual([]);
    });

    it('is a no-op for a starter feed, which the crawl set already covers', async () => {
      const res = await handleGuestFeedWarm(warmRequest({ feedUrl: STARTER }), env);
      expect((await res.json()) as { fresh: boolean }).toMatchObject({ ok: true, fresh: true });
      expect(proxyCalls).toEqual([]);
      const row = await env.DB.prepare('SELECT feed_url FROM feeds WHERE feed_url = ?')
        .bind(STARTER)
        .first();
      expect(row).toBeNull();
    });

    it('burns the slot even when the crawl fails, so a broken URL is not retried', async () => {
      globalThis.fetch = vi.fn(async () => {
        proxyCalls.push('fail');
        return new Response('nope', { status: 500 });
      }) as unknown as typeof fetch;

      const first = await handleGuestFeedWarm(warmRequest({ feedUrl: FEED_A }), env);
      expect((await first.json()) as { ok: boolean }).toMatchObject({ ok: false });
      expect(await warmedAt(FEED_A)).toBeGreaterThan(0);

      const second = await handleGuestFeedWarm(warmRequest({ feedUrl: FEED_A }), env);
      expect((await second.json()) as { fresh: boolean }).toMatchObject({ fresh: true });
      expect(proxyCalls).toHaveLength(1);
    });

    it('refuses a NEW feed once the global daily ceiling is reached', async () => {
      for (let i = 0; i < 200; i++) {
        await setGuestWarmedAt(`https://example.com/cap${i}.xml`, 60 * 60);
      }

      const res = await handleGuestFeedWarm(warmRequest({ feedUrl: FEED_A }), env);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      expect(proxyCalls).toEqual([]);

      // A feed the archive already holds is not new capacity, so it still warms.
      const existing = await handleGuestFeedWarm(
        warmRequest({ feedUrl: 'https://example.com/cap0.xml' }),
        env
      );
      expect(existing.status).toBe(200);
      expect(proxyCalls).toHaveLength(1);
    });

    it('rate limits a single caller', async () => {
      // The starter short-circuit answers before any D1 or proxy work, so this
      // exercises the limiter itself.
      for (let i = 0; i < 10; i++) {
        const res = await handleGuestFeedWarm(
          warmRequest({ feedUrl: STARTER }, '198.51.100.7'),
          env
        );
        expect(res.status).toBe(200);
      }
      const limited = await handleGuestFeedWarm(
        warmRequest({ feedUrl: STARTER }, '198.51.100.7'),
        env
      );
      expect(limited.status).toBe(429);
      expect(limited.headers.get('Retry-After')).toBeTruthy();

      // Another caller is unaffected.
      const other = await handleGuestFeedWarm(
        warmRequest({ feedUrl: STARTER }, '198.51.100.8'),
        env
      );
      expect(other.status).toBe(200);
    });
  });

  describe('orphan reaper', () => {
    it('deletes a stale guest-warmed feed nobody subscribes to, items and all', async () => {
      await seed(FEED_A, ['a1', 'a2']);
      await setGuestWarmedAt(FEED_A, 31 * 24 * 60 * 60);

      expect(await reapOrphanGuestFeeds(env)).toBe(1);
      const feeds = await env.DB.prepare('SELECT COUNT(*) AS c FROM feeds').first<{ c: number }>();
      const items = await env.DB.prepare('SELECT COUNT(*) AS c FROM feed_items').first<{
        c: number;
      }>();
      expect(feeds?.c).toBe(0);
      expect(items?.c).toBe(0);
    });

    it('keeps a guest-warmed feed that has since gained a subscriber', async () => {
      await seed(FEED_A, ['a1']);
      await setGuestWarmedAt(FEED_A, 31 * 24 * 60 * 60);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO users (did, handle, pds_url, tier, created_at)
         VALUES ('did:plc:guestreaper', 'reaper.test', 'https://test.pds.example', 'free', unixepoch())`
      ).run();
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, active)
         VALUES ('did:plc:guestreaper', 'at://did:plc:guestreaper/x/1', ?, 'Feed', 1)`
      )
        .bind(FEED_A)
        .run();

      expect(await reapOrphanGuestFeeds(env)).toBe(0);
    });

    it('keeps recently touched guest feeds and crawler-owned feeds', async () => {
      await seed(FEED_A, ['a1']);
      await setGuestWarmedAt(FEED_A, 24 * 60 * 60);
      await seed(FEED_B, ['b1']);

      expect(await reapOrphanGuestFeeds(env)).toBe(0);
      const feeds = await env.DB.prepare('SELECT COUNT(*) AS c FROM feeds').first<{ c: number }>();
      expect(feeds?.c).toBe(2);
    });
  });
});
