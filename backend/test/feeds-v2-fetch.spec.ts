import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleV2FeedFetch } from '../src/routes/feeds-v2';
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

async function subscribe(feedUrl: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'fetch.test', 'https://test.pds.example', 'free', unixepoch())`
  )
    .bind(TEST_DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, active)
     VALUES (?, ?, ?, 'Feed', 1)`
  )
    .bind(TEST_DID, `at://${TEST_DID}/app.skyreader.feed.subscription/${Date.now()}`, feedUrl)
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
});
