import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleIngest, CRAWLER_HEARTBEAT_KEY } from '../src/routes/ingest';
import { handleTimeline, readFeedSlice } from '../src/routes/timeline';
import { handleMarkFeedRead } from '../src/routes/reading';
import { ARTICLE_WINDOW_PER_FEED } from '../src/config/window';
import type { Env, FeedItem, Session } from '../src/types';

/**
 * The canonical per-feed window (K) and everything that depends on it agreeing:
 * server-computed unread counts, and a mark-all-read that covers the window
 * rather than the acting device's slice.
 *
 * This is the headline bug from the report — "the same feed will show different
 * unread numbers on different devices". Cold start served 30 per feed while the
 * client kept 100, so the two devices were counting over different sets and no
 * amount of read-state sync could reconcile them.
 */

const TEST_DID = 'did:plc:unreadwindow';
const SECRET = 'test-proxy-secret';
const FEED = 'https://example.com/window.xml';
const OTHER_FEED = 'https://example.com/other.xml';

const SESSION: Session = {
  did: TEST_DID,
  handle: 'window.bsky.social',
  pdsUrl: 'https://test.pds.example',
  accessToken: 'token',
  refreshToken: 'refresh',
  dpopPrivateKey: '{}',
  expiresAt: Date.now() + 3600000,
};

function item(guid: string, publishedAt: string): FeedItem {
  return {
    guid,
    url: `https://example.com/${guid}`,
    title: `Title ${guid}`,
    publishedAt,
  };
}

/** `count` items for `feedUrl`, newest first by publish date. */
async function seedFeed(feedUrl: string, count: number, prefix = 'i') {
  const items = Array.from({ length: count }, (_, i) => {
    // Descending publish time so index 0 is the newest.
    const published = new Date(Date.UTC(2026, 0, 1) - i * 3600_000).toISOString();
    return item(`${prefix}-${String(i).padStart(4, '0')}`, published);
  });

  const res = await handleIngest(
    new Request('https://api.example/api/internal/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': SECRET },
      body: JSON.stringify({
        feeds: [{ feedUrl, title: 'Window Feed' }],
        items: items.map((it) => ({
          feedUrl,
          guid: it.guid,
          item: it,
          publishedAt: Date.parse(it.publishedAt),
          firstSeenAt: Date.now(),
          contentHash: it.guid,
        })),
      }),
    }),
    env
  );
  expect(res.status).toBe(200);
  return items;
}

async function subscribe(feedUrl: string) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, source_type, active)
     VALUES (?, ?, ?, 'Feed', NULL, 1)`
  )
    .bind(TEST_DID, `at://${TEST_DID}/app.skyreader.feed.subscription/${feedUrl.length}`, feedUrl)
    .run();
}

async function markRead(guid: string) {
  await env.DB.prepare(
    `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
     VALUES (?, ?, 'article', 'read', '{}', ?, unixepoch(), unixepoch(), ?)`
  )
    .bind(TEST_DID, guid, `rk-${guid}`, Date.now())
    .run();
}

type TimelineBody = {
  items: Array<{ guid: string; feedUrl: string; read: boolean }>;
  hasMore: boolean;
  nextColdOffset?: number;
  coldStart: boolean;
  unreadCounts?: Record<string, number>;
  head?: number;
};

async function timeline(params: Record<string, string> = {}): Promise<TimelineBody> {
  const search = new URLSearchParams(params).toString();
  const res = await handleTimeline(
    new Request(`https://api.example/api/v2/timeline${search ? `?${search}` : ''}`),
    env,
    SESSION
  );
  expect(res.status).toBe(200);
  return (await res.json()) as TimelineBody;
}

async function markFeedRead(body: unknown) {
  return handleMarkFeedRead(
    new Request('https://api.example/api/reading/mark-feed-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    SESSION
  );
}

async function unreadRowCount(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM item_labels_cache
      WHERE user_did = ? AND label = 'read' AND deleted_at IS NULL`
  )
    .bind(TEST_DID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('canonical per-feed window', () => {
  let savedSecret: string | undefined;

  beforeEach(async () => {
    savedSecret = (env as Env).FEED_PROXY_SECRET;
    (env as Env).FEED_PROXY_SECRET = SECRET;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (did, handle, pds_url, tier, created_at)
       VALUES (?, 'window.test', 'https://test.pds.example', 'free', unixepoch())`
    )
      .bind(TEST_DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
      .bind(CRAWLER_HEARTBEAT_KEY, String(Math.floor(Date.now() / 1000)))
      .run();
  });

  afterEach(async () => {
    (env as Env).FEED_PROXY_SECRET = savedSecret as string;
    await env.DB.prepare('DELETE FROM feed_items').run();
    await env.DB.prepare('DELETE FROM feeds').run();
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sync_state WHERE key = ?').bind(CRAWLER_HEARTBEAT_KEY).run();
  });

  it('cold-starts a device with K per feed, not 30', async () => {
    await seedFeed(FEED, 150);
    await subscribe(FEED);

    // Drain every cold-start page — the budget bounds a page, not the bootstrap.
    const guids = new Set<string>();
    let coldOffset: string | undefined;
    for (let page = 0; page < 20; page++) {
      const body = await timeline(coldOffset ? { cold_offset: coldOffset } : {});
      for (const it of body.items) guids.add(it.guid);
      if (!body.hasMore || body.nextColdOffset == null) break;
      coldOffset = String(body.nextColdOffset);
    }

    expect(guids.size).toBe(ARTICLE_WINDOW_PER_FEED);
  });

  it('computes unread counts over the window, ignoring everything below it', async () => {
    const items = await seedFeed(FEED, 150);
    await subscribe(FEED);

    // Read one item inside the window and one below it. Only the first can move
    // the number: the one below the window was never counted to begin with.
    await markRead(items[0].guid);
    await markRead(items[ARTICLE_WINDOW_PER_FEED + 10].guid);

    const body = await timeline({ include_counts: '1' });
    expect(body.unreadCounts?.[FEED]).toBe(ARTICLE_WINDOW_PER_FEED - 1);
    expect(typeof body.head).toBe('number');
  });

  it('omits counts unless asked, so drain pages pay nothing for them', async () => {
    await seedFeed(FEED, 5);
    await subscribe(FEED);

    const body = await timeline();
    expect(body.unreadCounts).toBeUndefined();
  });

  it('counts every subscribed feed, including one with nothing archived', async () => {
    await seedFeed(FEED, 3);
    await subscribe(FEED);
    await subscribe(OTHER_FEED);

    const body = await timeline({ include_counts: '1' });
    expect(body.unreadCounts?.[FEED]).toBe(3);
    expect(body.unreadCounts?.[OTHER_FEED]).toBe(0);
  });
});

describe('POST /api/reading/mark-feed-read', () => {
  let savedSecret: string | undefined;

  beforeEach(async () => {
    savedSecret = (env as Env).FEED_PROXY_SECRET;
    (env as Env).FEED_PROXY_SECRET = SECRET;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (did, handle, pds_url, tier, created_at)
       VALUES (?, 'window.test', 'https://test.pds.example', 'free', unixepoch())`
    )
      .bind(TEST_DID)
      .run();
  });

  afterEach(async () => {
    (env as Env).FEED_PROXY_SECRET = savedSecret as string;
    await env.DB.prepare('DELETE FROM feed_items').run();
    await env.DB.prepare('DELETE FROM feeds').run();
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
  });

  it('marks the whole window, including items the acting device never held', async () => {
    await seedFeed(FEED, 150);
    await subscribe(FEED);

    const res = await markFeedRead({ feedUrl: FEED });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, marked: ARTICLE_WINDOW_PER_FEED });
    expect(await unreadRowCount()).toBe(ARTICLE_WINDOW_PER_FEED);
  });

  it('respects beforeSeq so items ingested after the press stay unread', async () => {
    await seedFeed(FEED, 10, 'old');
    await subscribe(FEED);
    const head = (await env.DB.prepare('SELECT MAX(seq) AS s FROM feed_items').first<{
      s: number;
    }>())!.s;
    await seedFeed(FEED, 5, 'new');

    const res = await markFeedRead({ feedUrl: FEED, beforeSeq: head });
    expect(await res.json()).toEqual({ success: true, marked: 10 });
  });

  it('reasserts read intent for the whole window on a second call', async () => {
    await seedFeed(FEED, 8);
    await subscribe(FEED);

    await markFeedRead({ feedUrl: FEED });
    const before = await env.DB.prepare(
      "SELECT item_key, rkey FROM item_labels_cache WHERE user_did = ? AND label = 'read' ORDER BY item_key"
    )
      .bind(TEST_DID)
      .all<{ item_key: string; rkey: string }>();
    const second = await markFeedRead({ feedUrl: FEED });
    expect(await second.json()).toEqual({ success: true, marked: 8 });
    const after = await env.DB.prepare(
      "SELECT item_key, rkey FROM item_labels_cache WHERE user_did = ? AND label = 'read' ORDER BY item_key"
    )
      .bind(TEST_DID)
      .all<{ item_key: string; rkey: string }>();
    expect(after.results).toEqual(before.results);
  });

  it('covers every subscribed feed when no feedUrl is given', async () => {
    await seedFeed(FEED, 4, 'a');
    await seedFeed(OTHER_FEED, 6, 'b');
    await subscribe(FEED);
    await subscribe(OTHER_FEED);

    const res = await markFeedRead({});
    expect(await res.json()).toEqual({ success: true, marked: 10 });
  });

  // The endpoint WRITES read state, so it must not be usable to learn anything
  // about a feed the caller doesn't follow.
  it('refuses a feed the caller is not subscribed to', async () => {
    await seedFeed(FEED, 3);
    const res = await markFeedRead({ feedUrl: FEED });
    expect(res.status).toBe(404);
    expect(await unreadRowCount()).toBe(0);
  });
});

describe('archive paging (readFeedSlice offset)', () => {
  let savedSecret: string | undefined;

  beforeEach(async () => {
    savedSecret = (env as Env).FEED_PROXY_SECRET;
    (env as Env).FEED_PROXY_SECRET = SECRET;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (did, handle, pds_url, tier, created_at)
       VALUES (?, 'window.test', 'https://test.pds.example', 'free', unixepoch())`
    )
      .bind(TEST_DID)
      .run();
  });

  afterEach(async () => {
    (env as Env).FEED_PROXY_SECRET = savedSecret as string;
    await env.DB.prepare('DELETE FROM feed_items').run();
    await env.DB.prepare('DELETE FROM feeds').run();
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
  });

  it('pages below the local window without repeating it', async () => {
    const items = await seedFeed(FEED, 130);

    const windowSlice = await readFeedSlice(env, TEST_DID, FEED, ARTICLE_WINDOW_PER_FEED);
    const older = await readFeedSlice(env, TEST_DID, FEED, 30, ARTICLE_WINDOW_PER_FEED);

    expect(windowSlice[0].guid).toBe(items[0].guid);
    expect(older).toHaveLength(30);
    expect(older[0].guid).toBe(items[ARTICLE_WINDOW_PER_FEED].guid);
    const overlap = new Set(windowSlice.map((i) => i.guid));
    expect(older.some((i) => overlap.has(i.guid))).toBe(false);
  });

  it('returns an empty page at the bottom of the archive', async () => {
    await seedFeed(FEED, 10);
    const older = await readFeedSlice(env, TEST_DID, FEED, 30, 50);
    expect(older).toHaveLength(0);
  });
});
