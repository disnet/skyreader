import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleV2FeedFetch } from '../src/routes/feeds-v2';
import { ingestProxyFeed } from '../src/routes/ingest';
import { clearExpiredBacklogSkips, SKIP_BACKLOG_WINDOW_MS } from '../src/services/backlog-skip';
import type { Env, Session } from '../src/types';

/**
 * `GET /api/v2/feeds/fetch` reads the D1 archive, and pulls a feed through the
 * crawler when the archive holds nothing for it. That pull-through is the one
 * user-triggered write into a shared, never-pruned archive, so it is gated on the
 * caller's own subscription.
 */

const TEST_DID = 'did:plc:fetchtester';
const FEED_URL = 'https://example.com/fetch-feed.xml';

const SESSION: Session = {
  did: TEST_DID,
  handle: 'fetch.bsky.social',
  pdsUrl: 'https://test.pds.example',
  accessToken: 'token',
  refreshToken: 'refresh',
  dpopPrivateKey: '{}',
  expiresAt: Date.now() + 3600000,
};

function fetchRequest(params: Record<string, string>): Request {
  const search = new URLSearchParams(params).toString();
  return new Request(`https://api.example/api/v2/feeds/fetch?${search}`);
}

function proxyFeed(guids: string[]): Response {
  return new Response(
    JSON.stringify({
      feed: {
        title: 'Pulled Feed',
        siteUrl: 'https://example.com',
        // The proxy serves newest-first.
        items: guids.map((guid) => ({
          guid,
          url: `https://example.com/${guid}`,
          title: `Title ${guid}`,
          publishedAt: '2026-01-01T00:00:00.000Z',
        })),
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function subscribe(feedUrl: string, opts: { skipBacklogAt?: number | null } = {}) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'fetch.test', 'https://test.pds.example', 'free', unixepoch())`
  )
    .bind(TEST_DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, active, skip_backlog_at)
     VALUES (?, ?, ?, 'Feed', 1, ?)`
  )
    .bind(
      TEST_DID,
      `at://${TEST_DID}/app.skyreader.feed.subscription/${Date.now()}`,
      feedUrl,
      opts.skipBacklogAt ?? null
    )
    .run();
}

describe('handleV2FeedFetch (archive + gated pull-through)', () => {
  let originalFetch: typeof fetch;
  let proxyCalls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    proxyCalls = [];
    (env as Env).FEED_PROXY_URL = 'https://proxy.example';
    (env as Env).FEED_PROXY_SECRET = 'test-secret';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      proxyCalls.push(typeof input === 'string' ? input : input.toString());
      return proxyFeed(['newest', 'middle', 'oldest']);
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await env.DB.prepare('DELETE FROM feed_items').run();
    await env.DB.prepare('DELETE FROM feeds').run();
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
  });

  it('pulls a subscribed feed through the crawler and serves it newest-first', async () => {
    await subscribe(FEED_URL);

    const res = await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; items: Array<{ guid: string }> };

    expect(proxyCalls.length).toBe(1);
    expect(body.title).toBe('Pulled Feed');
    expect(body.items.map((i) => i.guid)).toEqual(['newest', 'middle', 'oldest']);

    // Ingested oldest→newest, so the archive's seq order matches feed order.
    const rows = await env.DB.prepare(
      'SELECT guid FROM feed_items WHERE feed_url = ? ORDER BY seq ASC'
    )
      .bind(FEED_URL)
      .all<{ guid: string }>();
    expect(rows.results.map((r) => r.guid)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('does not write the shared archive for a feed the caller does not subscribe to', async () => {
    const res = await handleV2FeedFetch(
      fetchRequest({ url: FEED_URL, refresh: '1' }),
      env,
      SESSION
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };

    expect(proxyCalls).toEqual([]);
    expect(body.items).toEqual([]);
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM feed_items').first<{
      c: number;
    }>();
    expect(count?.c).toBe(0);
  });

  it('serves the archive without a crawl once the feed is ingested', async () => {
    await subscribe(FEED_URL);
    await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    expect(proxyCalls.length).toBe(1);

    const res = await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    const body = (await res.json()) as { items: Array<{ guid: string }> };
    expect(proxyCalls.length).toBe(1);
    expect(body.items.map((i) => i.guid)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('re-crawls a subscribed feed on refresh=1', async () => {
    await subscribe(FEED_URL);
    await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    await handleV2FeedFetch(fetchRequest({ url: FEED_URL, refresh: '1' }), env, SESSION);
    expect(proxyCalls.length).toBe(2);
  });

  it('starts a feed new to the archive with only its newest 10 unread', async () => {
    const guids = Array.from({ length: 12 }, (_, i) => `item-${String(12 - i).padStart(2, '0')}`);
    globalThis.fetch = vi.fn(async () => proxyFeed(guids)) as unknown as typeof fetch;
    await subscribe(FEED_URL, { skipBacklogAt: Date.now() });

    const res = await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    const body = (await res.json()) as { items: Array<{ guid: string; read?: boolean }> };

    // The response already carries it: newest 10 unread, the 2 oldest read.
    expect(body.items.filter((i) => !i.read).map((i) => i.guid)).toEqual(guids.slice(0, 10));
    expect(body.items.filter((i) => i.read).map((i) => i.guid)).toEqual(guids.slice(10));

    const rows = await env.DB.prepare(
      `SELECT item_key, props FROM item_labels_cache WHERE user_did = ? AND label = 'read'`
    )
      .bind(TEST_DID)
      .all<{ item_key: string; props: string }>();
    expect(rows.results.map((r) => r.item_key).sort()).toEqual(guids.slice(10).sort());
    for (const row of rows.results) expect(JSON.parse(row.props).skipped).toBe(true);
  });

  it('leaves read state alone when re-crawling a feed the archive already held', async () => {
    const guids = Array.from({ length: 12 }, (_, i) => `again-${String(12 - i).padStart(2, '0')}`);
    globalThis.fetch = vi.fn(async () => proxyFeed(guids)) as unknown as typeof fetch;
    await subscribe(FEED_URL, { skipBacklogAt: Date.now() });
    await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    // The reader marks a skipped item unread again; a refresh must not undo that.
    await env.DB.prepare(
      `UPDATE item_labels_cache SET deleted_at = unixepoch() WHERE user_did = ? AND item_key = ?`
    )
      .bind(TEST_DID, guids[11])
      .run();

    await handleV2FeedFetch(fetchRequest({ url: FEED_URL, refresh: '1' }), env, SESSION);
    const live = await env.DB.prepare(
      `SELECT item_key FROM item_labels_cache
        WHERE user_did = ? AND label = 'read' AND deleted_at IS NULL`
    )
      .bind(TEST_DID)
      .all<{ item_key: string }>();
    expect(live.results.map((r) => r.item_key)).toEqual([guids[10]]);
  });

  async function readGuids(): Promise<string[]> {
    const rows = await env.DB.prepare(
      `SELECT item_key FROM item_labels_cache
        WHERE user_did = ? AND label = 'read' AND deleted_at IS NULL`
    )
      .bind(TEST_DID)
      .all<{ item_key: string }>();
    return rows.results.map((r) => r.item_key).sort();
  }

  it('skips a feed the archive already held on the first read after subscribing', async () => {
    const guids = Array.from({ length: 12 }, (_, i) => `held-${String(12 - i).padStart(2, '0')}`);
    // Someone else's subscription put the feed in the archive first.
    await ingestProxyFeed(env, FEED_URL, {
      title: 'Held',
      items: guids.map((guid) => ({
        guid,
        url: `https://example.com/${guid}`,
        title: guid,
        publishedAt: '2026-01-01T00:00:00.000Z',
      })),
    } as never);
    await subscribe(FEED_URL, { skipBacklogAt: Date.now() });

    const res = await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    const body = (await res.json()) as { items: Array<{ guid: string; read?: boolean }> };
    expect(proxyCalls.length).toBe(0);
    expect(body.items.filter((i) => i.read).map((i) => i.guid)).toEqual(guids.slice(10));
  });

  it('skips nothing for a subscription that is not new', async () => {
    const guids = Array.from({ length: 12 }, (_, i) => `old-${String(12 - i).padStart(2, '0')}`);
    globalThis.fetch = vi.fn(async () => proxyFeed(guids)) as unknown as typeof fetch;
    // Restored from another device, or re-added: no skip owed.
    await subscribe(FEED_URL);
    await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    expect(await readGuids()).toEqual([]);
  });

  it('skips nothing once the window has passed', async () => {
    const guids = Array.from({ length: 12 }, (_, i) => `late-${String(12 - i).padStart(2, '0')}`);
    globalThis.fetch = vi.fn(async () => proxyFeed(guids)) as unknown as typeof fetch;
    await subscribe(FEED_URL, { skipBacklogAt: Date.now() - SKIP_BACKLOG_WINDOW_MS - 1000 });
    await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    expect(await readGuids()).toEqual([]);
  });

  it('never skips what was published after subscribing', async () => {
    const guids = Array.from({ length: 12 }, (_, i) => `new-${String(12 - i).padStart(2, '0')}`);
    globalThis.fetch = vi.fn(async () => proxyFeed(guids)) as unknown as typeof fetch;
    // Subscribed before these items' date (2026-01-01).
    await subscribe(FEED_URL, { skipBacklogAt: Date.parse('2025-12-31T23:00:00.000Z') });
    // Inside the window as far as the clock is concerned.
    vi.useFakeTimers({ now: Date.parse('2026-01-01T12:00:00.000Z'), toFake: ['Date'] });
    try {
      await handleV2FeedFetch(fetchRequest({ url: FEED_URL }), env, SESSION);
    } finally {
      vi.useRealTimers();
    }
    expect(await readGuids()).toEqual([]);
  });

  it('skips items the crawler pushes after the subscription, and clears the owed skip after a day', async () => {
    const guids = Array.from({ length: 12 }, (_, i) => `push-${String(12 - i).padStart(2, '0')}`);
    await subscribe(FEED_URL, { skipBacklogAt: Date.now() });
    await ingestProxyFeed(env, FEED_URL, {
      title: 'Pushed',
      items: guids.map((guid) => ({
        guid,
        url: `https://example.com/${guid}`,
        title: guid,
        publishedAt: '2026-01-01T00:00:00.000Z',
      })),
    } as never);
    expect(await readGuids()).toEqual(guids.slice(10).sort());

    expect(await clearExpiredBacklogSkips(env, Date.now())).toBe(0);
    expect(await clearExpiredBacklogSkips(env, Date.now() + SKIP_BACKLOG_WINDOW_MS + 1)).toBe(1);
  });
});
