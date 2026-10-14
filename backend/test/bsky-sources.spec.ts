import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { BSKY_BOOKMARKS_SCOPES, GRANULAR_SCOPES } from '../src/config/scopes';
import type { Session } from '../src/types';
import {
  BSKY_BOOKMARKS_SOURCE_TYPE,
  BSKY_LIKES_SOURCE_TYPE,
  BSKY_SOURCE_GATE_MS,
  REFRESH_MAX_PAGES,
  WALK_MAX_PAGES,
  bskyPostItem,
  bskySourceFeedUrl,
  disableBskySource,
  refreshBskySource,
  resetBskySourceCache,
  type BskyPostView,
} from '../src/services/bsky-sources';
import {
  LOCAL_ONLY_FEED_URL_PREFIXES,
  LOCAL_ONLY_SOURCE_TYPES,
  localOnlySql,
  notLocalOnlySql,
} from '../src/services/local-only-sources';
import { NEWSLETTER_SOURCE_TYPE } from '../src/services/newsletters';
import { handleCrawlSet } from '../src/routes/ingest';
import { upsertSubscriptionFromFirehose } from '../src/services/firehose-subscription';

// Bluesky likes and bookmarks as sources (services/bsky-sources.ts).
//
// What matters here:
//  - Only posts that carry a link become items, and the item IS the link.
//  - A refresh stops at the high-water mark and the gate holds.
//  - Likes need no extra permission; bookmarks need getBookmarks, proxied.
//  - The source is private and local-only: never crawled, never created through
//    the generic subscription routes or a PDS record, readable only by its owner.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const DID = 'did:plc:bskysourcestest';
const OTHER = 'did:plc:bskysourcesother';
const SESSION_ID = 'test-session-bsky-sources';
const OTHER_SESSION_ID = 'test-session-bsky-sources-other';
const PDS = 'https://test.pds.example';
const PROXY_SECRET = 'bsky-sources-proxy-secret';

function session(scopes: string): Session {
  return {
    did: DID,
    handle: 'reader.test',
    pdsUrl: PDS,
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
    expiresAt: Date.now() + 3600000,
    grantedScopes: scopes,
  };
}

const BASE_SCOPES = GRANULAR_SCOPES;
const BOOKMARK_SCOPES = [GRANULAR_SCOPES, ...BSKY_BOOKMARKS_SCOPES].join(' ');

function linkPost(n: number, opts: { url?: string; title?: string; text?: string } = {}) {
  const url = opts.url ?? `https://site${n}.example/article-${n}`;
  return {
    uri: `at://did:plc:author${n}/app.bsky.feed.post/p${n}`,
    author: { did: `did:plc:author${n}`, handle: `author${n}.test`, displayName: `Author ${n}` },
    record: { text: opts.text ?? `worth reading ${n}` },
    embed: {
      $type: 'app.bsky.embed.external#view',
      external: { uri: url, title: opts.title ?? `Article ${n}`, description: `About ${n}` },
    },
    indexedAt: new Date().toISOString(),
  };
}

function textPost(n: number) {
  return {
    uri: `at://did:plc:author${n}/app.bsky.feed.post/p${n}`,
    author: { did: `did:plc:author${n}`, handle: `author${n}.test` },
    record: { text: 'just words' },
    indexedAt: new Date().toISOString(),
  };
}

/** A like record for post n; rkeys are TID-shaped and sort by n. */
function like(n: number) {
  return {
    uri: `at://${DID}/app.bsky.feed.like/3kaaaaaaaa${String(n).padStart(3, '0')}`,
    cid: 'bafy',
    value: {
      subject: { uri: `at://did:plc:author${n}/app.bsky.feed.post/p${n}`, cid: 'bafy' },
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    },
  };
}

interface Stub {
  likes?: ReturnType<typeof like>[];
  posts?: ReturnType<typeof linkPost | typeof textPost>[];
  bookmarks?: unknown[];
  bookmarksStatus?: number;
  /** getPosts answers this status for every batch. */
  postsStatus?: number;
  /** getPosts answers 400 for any batch naming this uri. */
  rejectUri?: string;
  /** Runs inside getPosts, before it answers: something happening mid-walk. */
  duringPosts?: () => Promise<void>;
}

let calls: { path: string; proxy: string | null; params: URLSearchParams }[] = [];

function stub(data: Stub) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      path: url.pathname,
      proxy: headers.get('atproto-proxy'),
      params: url.searchParams,
    });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname.endsWith('/xrpc/com.atproto.repo.listRecords')) {
      // Newest first, paged by rkey, like a PDS.
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const after = url.searchParams.get('cursor');
      const rkeyOf = (r: { uri: string }) => r.uri.split('/').pop()!;
      const below = [...(data.likes ?? [])].reverse().filter((r) => !after || rkeyOf(r) < after);
      const records = below.slice(0, limit);
      const cursor = below.length > limit ? rkeyOf(records[records.length - 1]) : undefined;
      return ok({ records, cursor });
    }
    if (url.pathname.endsWith('/xrpc/app.bsky.feed.getPosts')) {
      const uris = new Set(url.searchParams.getAll('uris'));
      if (data.duringPosts) await data.duringPosts();
      if (data.postsStatus) return new Response('{}', { status: data.postsStatus });
      if (data.rejectUri && uris.has(data.rejectUri)) {
        return new Response(JSON.stringify({ error: 'InvalidRequest' }), { status: 400 });
      }
      return ok({ posts: (data.posts ?? []).filter((p) => uris.has(p.uri)) });
    }
    if (url.pathname.endsWith('/xrpc/app.bsky.bookmark.getBookmarks')) {
      if (data.bookmarksStatus) {
        return new Response(JSON.stringify({ error: 'InsufficientScope', message: 'scope' }), {
          status: data.bookmarksStatus,
        });
      }
      return ok({ bookmarks: data.bookmarks ?? [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function seedSession(did: string, sessionId: string, scopes: string) {
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sessionId,
      did,
      `${did}.test`,
      PDS,
      'test-access-token',
      'test-refresh-token',
      JSON.stringify(TEST_DPOP_KEY),
      Date.now() + 3600000,
      scopes
    )
    .run();
}

async function send(
  path: string,
  opts: { method?: string; body?: unknown; sessionId?: string } = {}
) {
  const request = new IncomingRequest(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Cookie: `session_id=${opts.sessionId ?? SESSION_ID}`,
      'Content-Type': 'application/json',
      Origin: env.FRONTEND_URL,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request as never, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function items(kind: 'likes' | 'bookmarks', did = DID) {
  const rows = await env.DB.prepare(
    'SELECT guid, item_json FROM feed_items WHERE feed_url = ? ORDER BY seq'
  )
    .bind(bskySourceFeedUrl(kind, did))
    .all<{ guid: string; item_json: string }>();
  return rows.results.map((r) => JSON.parse(r.item_json) as Record<string, unknown>);
}

async function subscription(kind: 'likes' | 'bookmarks') {
  return env.DB.prepare(
    'SELECT source_type, active, title FROM subscriptions_cache WHERE user_did = ? AND feed_url = ?'
  )
    .bind(DID, bskySourceFeedUrl(kind, DID))
    .first<{ source_type: string; active: number; title: string }>();
}

describe('Bluesky likes and bookmarks as sources', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    resetBskySourceCache();
    for (const did of [DID, OTHER]) {
      for (const [table, column] of [
        ['subscriptions_cache', 'user_did'],
        ['bsky_source_sync', 'user_did'],
        ['rate_limits', 'user_did'],
        ['sessions', 'did'],
        ['users', 'did'],
      ]) {
        await env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?`)
          .bind(did)
          .run()
          .catch(() => {});
      }
      for (const kind of ['likes', 'bookmarks'] as const) {
        await env.DB.prepare('DELETE FROM feed_items WHERE feed_url = ?')
          .bind(bskySourceFeedUrl(kind, did))
          .run();
      }
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, created_at, last_active_at)
         VALUES (?, ?, ?, unixepoch(), unixepoch())`
      )
        .bind(did, `${did}.test`, PDS)
        .run();
    }
    await seedSession(DID, SESSION_ID, BASE_SCOPES);
    await seedSession(OTHER, OTHER_SESSION_ID, BASE_SCOPES);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('bskyPostItem', () => {
    it('makes the linked article the item, with the post as its preview', () => {
      const item = bskyPostItem(
        linkPost(1, { text: 'Read <this>' }) as BskyPostView,
        '2026-10-01T00:00:00.000Z'
      );
      expect(item).toMatchObject({
        guid: 'at://did:plc:author1/app.bsky.feed.post/p1',
        url: 'https://site1.example/article-1',
        title: 'Article 1',
        author: 'Author 1',
        summary: 'About 1',
        publishedAt: '2026-10-01T00:00:00.000Z',
        contentTruncated: true,
      });
      expect(item?.contentLead).toContain('Read &lt;this&gt;');
      expect(item?.contentLead).toContain('https://bsky.app/profile/did:plc:author1/post/p1');
    });

    it('takes a bare link from the text, titled by the post', () => {
      const post = {
        uri: 'at://did:plc:a/app.bsky.feed.post/x',
        author: { did: 'did:plc:a', handle: 'a.test' },
        record: {
          text: 'Great piece\nmore',
          facets: [
            { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.example/p' }] },
          ],
        },
      };
      expect(bskyPostItem(post as BskyPostView, '2026-10-01T00:00:00Z')).toMatchObject({
        url: 'https://x.example/p',
        title: 'Great piece',
        author: 'a.test',
      });
    });

    it('skips posts with no link, and links back into Bluesky', () => {
      expect(bskyPostItem(textPost(1) as BskyPostView, '2026-10-01T00:00:00Z')).toBeNull();
      const bsky = linkPost(2, { url: 'https://bsky.app/profile/someone' });
      expect(bskyPostItem(bsky as BskyPostView, '2026-10-01T00:00:00Z')).toBeNull();
    });
  });

  describe('likes', () => {
    it('turns on without a new permission and gathers the liked link posts', async () => {
      stub({
        likes: [like(1), like(2), like(3)],
        posts: [linkPost(1), textPost(2), linkPost(3)],
      });
      const res = await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      expect(res.status).toBe(200);
      const status = (await res.json()) as Record<string, { enabled: boolean }>;
      expect(status.likes.enabled).toBe(true);
      expect(status.bookmarks.enabled).toBe(false);

      expect(await subscription('likes')).toEqual({
        source_type: BSKY_LIKES_SOURCE_TYPE,
        active: 1,
        title: 'Bluesky likes',
      });
      // Oldest first into the archive; the text-only post is left out.
      expect((await items('likes')).map((i) => i.url)).toEqual([
        'https://site1.example/article-1',
        'https://site3.example/article-3',
      ]);
      // Likes come from the reader's own repo; posts from the public appview.
      const list = calls.find((c) => c.path.endsWith('listRecords'));
      expect(list?.params.get('collection')).toBe('app.bsky.feed.like');
      expect(list?.params.get('repo')).toBe(DID);
    });

    it('holds the gate, then walks only down to the newest like it has seen', async () => {
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      const s = session(BASE_SCOPES);
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      expect(await items('likes')).toHaveLength(1);

      stub({ likes: [like(1), like(2)], posts: [linkPost(1), linkPost(2)] });
      expect(await refreshBskySource(env, s, 'likes')).toEqual({
        refreshed: false,
        reason: 'gated',
      });
      expect(calls).toHaveLength(0);

      const later = Date.now() + BSKY_SOURCE_GATE_MS + 1000;
      expect(await refreshBskySource(env, s, 'likes', { now: later })).toEqual({
        refreshed: true,
        ingested: 1,
      });
      // Only the new like's post was looked up.
      const lookup = calls.find((c) => c.path.endsWith('getPosts'));
      expect(lookup?.params.getAll('uris')).toEqual(['at://did:plc:author2/app.bsky.feed.post/p2']);
      expect(await items('likes')).toHaveLength(2);
    });

    it('finishes a burst bigger than one refresh can read, on the next ones', async () => {
      const s = session(BASE_SCOPES);
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });

      // 250 new likes: more than the WALK_MAX_PAGES (2) pages the top gets.
      expect(WALK_MAX_PAGES * 100).toBeLessThan(250);
      const n = Array.from({ length: 251 }, (_, i) => i + 1);
      stub({ likes: n.map(like), posts: n.map((i) => linkPost(i)) });
      let later = Date.now() + BSKY_SOURCE_GATE_MS + 1000;
      await refreshBskySource(env, s, 'likes', { now: later });
      expect(await items('likes')).toHaveLength(1 + WALK_MAX_PAGES * 100);
      const gap = await env.DB.prepare(
        'SELECT gap_cursor, gap_stop FROM bsky_source_sync WHERE user_did = ?'
      )
        .bind(DID)
        .first<{ gap_cursor: string | null; gap_stop: string | null }>();
      expect(gap?.gap_cursor).toBeTruthy();
      expect(gap?.gap_stop).toBe(like(1).uri.split('/').pop());

      // Nothing new at the top, so the next refresh spends its pages on the gap.
      later += BSKY_SOURCE_GATE_MS + 1000;
      await refreshBskySource(env, s, 'likes', { now: later });
      const urls = new Set((await items('likes')).map((i) => i.url));
      expect(urls.size).toBe(251);
      const done = await env.DB.prepare(
        'SELECT gap_cursor FROM bsky_source_sync WHERE user_did = ?'
      )
        .bind(DID)
        .first<{ gap_cursor: string | null }>();
      expect(done?.gap_cursor).toBeNull();
    });

    it('folds a second burst into the first gap, and still loses nothing', async () => {
      const s = session(BASE_SCOPES);
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });

      let later = Date.now();
      const refreshWith = async (count: number) => {
        const n = Array.from({ length: count }, (_, i) => i + 1);
        stub({ likes: n.map(like), posts: n.map((i) => linkPost(i)) });
        later += BSKY_SOURCE_GATE_MS + 1000;
        return refreshBskySource(env, s, 'likes', { now: later });
      };
      await refreshWith(301); // leaves a gap
      await refreshWith(601); // another burst before the gap is finished
      // Drain: each refresh with nothing new spends REFRESH_MAX_PAGES on the gap.
      for (let i = 0; i < Math.ceil(600 / (REFRESH_MAX_PAGES * 100)) + 1; i++) {
        await refreshWith(601);
      }
      const urls = new Set((await items('likes')).map((i) => i.url));
      expect(urls.size).toBe(601);
    });

    it('skips a like the appview rejects, and keeps the rest', async () => {
      const bad = linkPost(2).uri;
      stub({
        likes: [like(1), like(2), like(3)],
        posts: [linkPost(1), linkPost(2), linkPost(3)],
        rejectUri: bad,
      });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      expect((await items('likes')).map((i) => i.url)).toEqual([
        'https://site1.example/article-1',
        'https://site3.example/article-3',
      ]);
      const sync = await env.DB.prepare(
        'SELECT newest_seen, last_error FROM bsky_source_sync WHERE user_did = ?'
      )
        .bind(DID)
        .first<{ newest_seen: string; last_error: string | null }>();
      expect(sync).toEqual({ newest_seen: like(3).uri.split('/').pop(), last_error: null });
    });

    it('holds the mark when the appview is down, so nothing is skipped', async () => {
      stub({ likes: [like(1)], posts: [linkPost(1)], postsStatus: 503 });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      expect(await items('likes')).toHaveLength(0);
      const sync = await env.DB.prepare(
        'SELECT newest_seen, last_error FROM bsky_source_sync WHERE user_did = ?'
      )
        .bind(DID)
        .first<{ newest_seen: string | null; last_error: string | null }>();
      expect(sync?.newest_seen).toBeNull();
      expect(sync?.last_error).toBeTruthy();
    });

    it('moves the mark past likes of things that are not posts', async () => {
      const s = session(BASE_SCOPES);
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      // 250 liked feed generators: more than the top walk's pages, none a post.
      const feedLikes = Array.from({ length: 250 }, (_, i) => {
        const l = like(i + 2);
        return {
          ...l,
          value: { ...l.value, subject: { uri: `at://did:plc:gen/app.bsky.feed.generator/g${i}` } },
        };
      });
      stub({ likes: [like(1), ...feedLikes] });
      await refreshBskySource(env, s, 'likes', { now: Date.now() + BSKY_SOURCE_GATE_MS + 1000 });
      const sync = await env.DB.prepare(
        'SELECT newest_seen FROM bsky_source_sync WHERE user_did = ?'
      )
        .bind(DID)
        .first<{ newest_seen: string }>();
      expect(sync?.newest_seen).toBe(like(251).uri.split('/').pop());
    });

    it('a refresh that finishes after the source was removed leaves nothing behind', async () => {
      const s = session(BASE_SCOPES);
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      stub({
        likes: [like(1), like(2)],
        posts: [linkPost(1), linkPost(2)],
        duringPosts: () => disableBskySource(env, s, 'likes'),
      });
      const outcome = await refreshBskySource(env, s, 'likes', {
        now: Date.now() + BSKY_SOURCE_GATE_MS + 1000,
      });
      expect(outcome).toEqual({ refreshed: false, reason: 'locked' });
      expect(await items('likes')).toHaveLength(0);
      const feed = await env.DB.prepare('SELECT 1 FROM feeds WHERE feed_url = ?')
        .bind(bskySourceFeedUrl('likes', DID))
        .first();
      expect(feed).toBeNull();
    });

    it('a second "turn on" keeps what the first gathered', async () => {
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      const turnOn = () =>
        send('/api/v2/bluesky-sources', { method: 'POST', body: { kind: 'likes', enabled: true } });
      await turnOn();
      stub({ likes: [like(1)], posts: [linkPost(1)], postsStatus: 503 });
      await turnOn();
      expect(await items('likes')).toHaveLength(1);
    });

    it('says so when the plan has no active slot, and parks it', async () => {
      const stmts = Array.from({ length: 100 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, active)
           VALUES (?, ?, ?, 'Feed', unixepoch(), 1)`
        ).bind(
          DID,
          `at://${DID}/app.skyreader.feed.subscription/3kfill${String(i).padStart(7, '0')}`,
          `https://fill${i}.example/feed.xml`
        )
      );
      await env.DB.batch(stmts);
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      const res = await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      const status = (await res.json()) as Record<string, { enabled: boolean; parked: boolean }>;
      expect(status.likes).toMatchObject({ enabled: true, parked: true });
      expect(await items('likes')).toHaveLength(0);
    });

    it('is refreshed after a timeline read once past the gate', async () => {
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      await env.DB.prepare('UPDATE bsky_source_sync SET last_poll_at = 0 WHERE user_did = ?')
        .bind(DID)
        .run();

      stub({ likes: [like(1), like(2)], posts: [linkPost(1), linkPost(2)] });
      await send('/api/v2/timeline');
      expect(await items('likes')).toHaveLength(2);
    });

    it('turning it off removes the subscription and what it gathered', async () => {
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      const res = await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: false },
      });
      expect(res.status).toBe(200);
      expect(await subscription('likes')).toBeNull();
      expect(await items('likes')).toHaveLength(0);
    });

    it('a generic unsubscribe forgets the walk too', async () => {
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      const row = await env.DB.prepare(
        'SELECT record_uri FROM subscriptions_cache WHERE user_did = ? AND feed_url = ?'
      )
        .bind(DID, bskySourceFeedUrl('likes', DID))
        .first<{ record_uri: string }>();
      const rkey = row!.record_uri.split('/').pop();
      const res = await send(`/api/subscriptions/${rkey}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      // No PDS delete for a record that never existed.
      expect(calls.some((c) => c.path.endsWith('deleteRecord'))).toBe(false);
      expect(await items('likes')).toHaveLength(0);
      const sync = await env.DB.prepare('SELECT 1 FROM bsky_source_sync WHERE user_did = ?')
        .bind(DID)
        .first();
      expect(sync).toBeNull();
    });
  });

  describe('bookmarks', () => {
    it('asks for the getBookmarks permission before turning on', async () => {
      stub({});
      const res = await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'bookmarks', enabled: true },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'scope_upgrade_required',
        feature: 'bskyBookmarks',
      });
      expect(await subscription('bookmarks')).toBeNull();
      const status = (await (await send('/api/v2/bluesky-sources')).json()) as Record<
        string,
        { scopeRequired: boolean }
      >;
      expect(status.bookmarks.scopeRequired).toBe(true);
      expect(status.likes.scopeRequired).toBe(false);
    });

    it('reads bookmarks through the appview proxy and keeps the link posts', async () => {
      await env.DB.prepare('UPDATE sessions SET granted_scopes = ? WHERE session_id = ?')
        .bind(BOOKMARK_SCOPES, SESSION_ID)
        .run();
      stub({
        bookmarks: [
          {
            subject: { uri: linkPost(2).uri },
            createdAt: '2026-10-02T00:00:00.000Z',
            item: { $type: 'app.bsky.feed.defs#postView', ...linkPost(2) },
          },
          {
            subject: { uri: 'at://did:plc:gone/app.bsky.feed.post/x' },
            createdAt: '2026-10-01T12:00:00.000Z',
            item: { $type: 'app.bsky.feed.defs#notFoundPost', uri: 'at://gone', notFound: true },
          },
          {
            subject: { uri: textPost(1).uri },
            createdAt: '2026-10-01T00:00:00.000Z',
            item: { $type: 'app.bsky.feed.defs#postView', ...textPost(1) },
          },
        ],
      });
      const res = await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'bookmarks', enabled: true },
      });
      expect(res.status).toBe(200);
      expect((await subscription('bookmarks'))?.source_type).toBe(BSKY_BOOKMARKS_SOURCE_TYPE);
      const gathered = await items('bookmarks');
      expect(gathered.map((i) => i.url)).toEqual(['https://site2.example/article-2']);
      expect(gathered[0].publishedAt).toBe('2026-10-02T00:00:00.000Z');
      const call = calls.find((c) => c.path.endsWith('getBookmarks'));
      expect(call?.proxy).toBe('did:web:api.bsky.app#bsky_appview');
    });

    it('remembers a PDS that refused the permission, and asks again', async () => {
      await env.DB.prepare('UPDATE sessions SET granted_scopes = ? WHERE session_id = ?')
        .bind(BOOKMARK_SCOPES, SESSION_ID)
        .run();
      stub({ bookmarksStatus: 403 });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'bookmarks', enabled: true },
      });
      const status = (await (await send('/api/v2/bluesky-sources')).json()) as Record<
        string,
        { scopeRequired: boolean; error: string | null }
      >;
      expect(status.bookmarks).toMatchObject({ scopeRequired: true, error: 'scope_denied' });

      // Granted again: turning it on again walks now and clears the refusal.
      stub({ bookmarks: [] });
      const again = await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'bookmarks', enabled: true },
      });
      const after = (await again.json()) as Record<
        string,
        { scopeRequired: boolean; error: string | null }
      >;
      expect(after.bookmarks).toMatchObject({ scopeRequired: false, error: null });
    });
  });

  describe('privacy', () => {
    it('lists every local-only source type', () => {
      expect([...LOCAL_ONLY_SOURCE_TYPES].sort()).toEqual(
        [NEWSLETTER_SOURCE_TYPE, BSKY_LIKES_SOURCE_TYPE, BSKY_BOOKMARKS_SOURCE_TYPE].sort()
      );
      expect(notLocalOnlySql('sc')).toContain(`'${BSKY_BOOKMARKS_SOURCE_TYPE}'`);
      const prefixes = [
        bskySourceFeedUrl('likes', DID),
        bskySourceFeedUrl('bookmarks', DID),
        'newsletter:abc/a@b.test',
      ].map((u) => LOCAL_ONLY_FEED_URL_PREFIXES.find((p) => u.startsWith(p)));
      expect(prefixes.every(Boolean)).toBe(true);
      expect(localOnlySql()).toContain("feed_url LIKE 'bsky-likes:%'");
    });

    it('refuses to create one through the generic subscription route', async () => {
      stub({});
      const res = await send('/api/subscriptions', {
        method: 'POST',
        body: {
          rkey: '3kaaaaaaaaaaa',
          feedUrl: bskySourceFeedUrl('bookmarks', OTHER),
          title: 'Not mine',
        },
      });
      expect(res.status).toBe(400);
    });

    it('ignores a PDS record that names one', async () => {
      await upsertSubscriptionFromFirehose(env.DB, DID, '3kaaaaaaaaaab', {
        feedUrl: bskySourceFeedUrl('bookmarks', OTHER),
        createdAt: new Date().toISOString(),
      });
      const row = await env.DB.prepare('SELECT 1 FROM subscriptions_cache WHERE user_did = ?')
        .bind(DID)
        .first();
      expect(row).toBeNull();
    });

    it('serves its items only to its owner, and keeps it out of the crawl set', async () => {
      stub({ likes: [like(1)], posts: [linkPost(1)] });
      await send('/api/v2/bluesky-sources', {
        method: 'POST',
        body: { kind: 'likes', enabled: true },
      });
      const feedUrl = encodeURIComponent(bskySourceFeedUrl('likes', DID));

      const mine = await send(`/api/v2/feeds/fetch?url=${feedUrl}`);
      expect(mine.status).toBe(200);
      const body = (await mine.json()) as { items: { url: string }[] };
      expect(body.items.map((i) => i.url)).toEqual(['https://site1.example/article-1']);

      const theirs = await send(`/api/v2/feeds/fetch?url=${feedUrl}`, {
        sessionId: OTHER_SESSION_ID,
      });
      expect(theirs.status).toBe(404);

      const saved = env.FEED_PROXY_SECRET;
      env.FEED_PROXY_SECRET = PROXY_SECRET;
      try {
        const res = await handleCrawlSet(
          new Request('https://api.example/api/internal/crawl-set', {
            headers: { 'X-Proxy-Secret': PROXY_SECRET },
          }),
          env
        );
        const crawl = (await res.json()) as { feeds: Array<{ feedUrl: string }> };
        expect(crawl.feeds.map((f) => f.feedUrl)).not.toContain(bskySourceFeedUrl('likes', DID));
      } finally {
        env.FEED_PROXY_SECRET = saved;
      }
    });
  });
});
