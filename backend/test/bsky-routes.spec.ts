import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import {
  BLUESKY_READ_SCOPES,
  BLUESKY_WRITE_SCOPES,
  FOLLOWS_LINKS_SCOPES,
  GRANULAR_SCOPES,
} from '../src/config/scopes';

// Bluesky feeds as sources (docs/plans/BLUESKY_FEEDS_PLAN.md): the routes.
//
// What matters here:
//  - Reads answer 200 { scopeRequired } without the permission (a 403 would raise
//    the app-wide banner); the timeline needs only the follows scope.
//  - A feed page is read live through the PDS with the appview proxy header, and
//    comes back normalized.
//  - Writes 403 with the blueskyWrite feature, create records in the reader's own
//    repo, and only ever delete the reader's own like/repost records.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const DID = 'did:plc:bskyroutestest';
const SESSION_ID = 'test-session-bsky-routes';
const PDS = 'https://test.pds.example';
const GEN = 'at://did:plc:creator/app.bsky.feed.generator/cats';
const POST = { uri: 'at://did:plc:alice/app.bsky.feed.post/3abc', cid: 'bafyreiaaaaaaaa' };

const READ = [GRANULAR_SCOPES, ...BLUESKY_READ_SCOPES].join(' ');
const WRITE = [READ, ...BLUESKY_WRITE_SCOPES].join(' ');

async function seedSession(scopes: string) {
  await env.DB.prepare('DELETE FROM sessions WHERE session_id = ?').bind(SESSION_ID).run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      SESSION_ID,
      DID,
      'reader.test',
      PDS,
      'test-access-token',
      'test-refresh-token',
      JSON.stringify(TEST_DPOP_KEY),
      Date.now() + 3600000,
      scopes
    )
    .run();
}

async function send(path: string, opts: { method?: string; body?: unknown } = {}) {
  const request = new IncomingRequest(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Cookie: `session_id=${SESSION_ID}`,
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

interface Call {
  path: string;
  params: URLSearchParams;
  proxy: string | null;
  body: unknown;
}

let calls: Call[] = [];

/** Stub the PDS and the public appview. Unexpected calls throw. */
function stubNetwork(overrides: Record<string, (call: Call) => unknown> = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      path: url.pathname.replace('/xrpc/', ''),
      params: url.searchParams,
      proxy: headers.get('atproto-proxy'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const handler = overrides[call.path];
    if (handler) return new Response(JSON.stringify(handler(call)), { status: 200 });
    switch (call.path) {
      case 'app.bsky.feed.getTimeline':
      case 'app.bsky.feed.getFeed':
        return new Response(
          JSON.stringify({
            feed: [
              {
                post: {
                  ...POST,
                  author: { did: 'did:plc:alice', handle: 'alice.test' },
                  record: { text: 'hello' },
                  indexedAt: '2026-09-01T00:00:00Z',
                },
              },
              { post: { uri: 'broken' } },
            ],
            cursor: 'next',
          }),
          { status: 200 }
        );
      case 'app.bsky.feed.getFeedGenerators':
        return new Response(
          JSON.stringify({
            feeds: call.params.getAll('feeds').map((uri) => ({ uri, displayName: 'Cats' })),
          }),
          { status: 200 }
        );
      case 'com.atproto.repo.createRecord': {
        const b = call.body as { collection: string };
        return new Response(
          JSON.stringify({ uri: `at://${DID}/${b.collection}/3new`, cid: 'bafyreinew00000' }),
          { status: 200 }
        );
      }
      case 'com.atproto.repo.deleteRecord':
        return new Response('{}', { status: 200 });
      case 'com.atproto.identity.resolveHandle':
        return new Response(JSON.stringify({ did: 'did:plc:bob' }), { status: 200 });
      default:
        throw new Error(`Unexpected fetch: ${url}`);
    }
  }) as typeof fetch;
}

describe('bsky routes', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    for (const [table, column] of [
      ['bsky_feeds', 'user_did'],
      ['rate_limits', 'did'],
      ['sessions', 'did'],
      ['users', 'did'],
    ]) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?`)
        .bind(DID)
        .run()
        .catch(() => {});
    }
    await env.DB.prepare(
      'INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
    )
      .bind(DID, 'reader.test', PDS)
      .run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('reading a feed', () => {
    it('asks quietly without the permission', async () => {
      await seedSession(GRANULAR_SCOPES);
      stubNetwork();
      const res = await send(`/api/v2/bsky/feed?uri=${encodeURIComponent(GEN)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ scopeRequired: true, posts: [] });
      expect(calls).toHaveLength(0);
    });

    it('reads the timeline with only the follows scope', async () => {
      await seedSession([GRANULAR_SCOPES, ...FOLLOWS_LINKS_SCOPES].join(' '));
      stubNetwork();
      const res = await send('/api/v2/bsky/feed?uri=following&cursor=abc');
      const body = (await res.json()) as { posts: { text: string }[]; cursor: string };
      expect(body.posts.map((p) => p.text)).toEqual(['hello']);
      expect(body.cursor).toBe('next');
      expect(calls[0].path).toBe('app.bsky.feed.getTimeline');
      expect(calls[0].params.get('cursor')).toBe('abc');
      expect(calls[0].proxy).toBe('did:web:api.bsky.app#bsky_appview');

      // A custom feed needs the wider read scope.
      const custom = await send(`/api/v2/bsky/feed?uri=${encodeURIComponent(GEN)}`);
      expect(await custom.json()).toMatchObject({ scopeRequired: true });
    });

    it('reads a custom feed through the appview proxy', async () => {
      await seedSession(READ);
      stubNetwork();
      const res = await send(`/api/v2/bsky/feed?uri=${encodeURIComponent(GEN)}&limit=500`);
      expect(res.status).toBe(200);
      expect(calls[0].path).toBe('app.bsky.feed.getFeed');
      expect(calls[0].params.get('feed')).toBe(GEN);
      expect(calls[0].params.get('limit')).toBe('100');
      expect(calls[0].proxy).toBe('did:web:api.bsky.app#bsky_appview');
    });

    it('rejects a uri that is not a feed', async () => {
      await seedSession(READ);
      stubNetwork();
      const res = await send('/api/v2/bsky/feed?uri=https://evil.example');
      expect(res.status).toBe(400);
    });
  });

  describe('feed sources', () => {
    it('adds, lists and removes feeds, with metadata from the appview', async () => {
      await seedSession(READ);
      stubNetwork();
      expect(
        (await send('/api/v2/bsky/feeds', { method: 'POST', body: { uri: GEN } })).status
      ).toBe(200);
      await send('/api/v2/bsky/feeds', { method: 'POST', body: { uri: 'following' } });
      // Adding again is a no-op.
      await send('/api/v2/bsky/feeds', { method: 'POST', body: { uri: GEN } });

      const list = (await (await send('/api/v2/bsky/feeds')).json()) as {
        access: Record<string, boolean>;
        feeds: { uri: string; displayName: string }[];
      };
      expect(list.access).toEqual({ timeline: true, feeds: true, write: false });
      expect(list.feeds.map((f) => [f.uri, f.displayName])).toEqual([
        [GEN, 'Cats'],
        ['following', 'Following on Bluesky'],
      ]);

      await send('/api/v2/bsky/feeds', { method: 'DELETE', body: { uri: GEN } });
      const after = (await (await send('/api/v2/bsky/feeds')).json()) as {
        feeds: { uri: string }[];
      };
      expect(after.feeds.map((f) => f.uri)).toEqual(['following']);
    });

    it('lists the feeds saved in Bluesky, Following first, marked when added', async () => {
      await seedSession(READ);
      const other = 'at://did:plc:creator/app.bsky.feed.generator/dogs';
      stubNetwork({
        'app.bsky.actor.getPreferences': () => ({
          preferences: [
            {
              $type: 'app.bsky.actor.defs#savedFeedsPrefV2',
              items: [
                { type: 'feed', value: GEN, pinned: true },
                { type: 'feed', value: other, pinned: false },
              ],
            },
          ],
        }),
      });
      await send('/api/v2/bsky/feeds', { method: 'POST', body: { uri: GEN } });
      const res = (await (await send('/api/v2/bsky/feeds?saved=1')).json()) as {
        saved: { uri: string; added: boolean }[];
      };
      expect(res.saved.map((f) => [f.uri, f.added])).toEqual([
        ['following', false],
        [GEN, true],
        [other, false],
      ]);
      // The PDS answers preferences itself: no proxy header.
      const prefCall = calls.find((c) => c.path === 'app.bsky.actor.getPreferences');
      expect(prefCall?.proxy).toBeNull();
    });
  });

  describe('writing', () => {
    it('403s with the blueskyWrite feature without the permission', async () => {
      await seedSession(READ);
      stubNetwork();
      const res = await send('/api/v2/bsky/like', { method: 'POST', body: POST });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'scope_upgrade_required',
        feature: 'blueskyWrite',
      });
    });

    it('likes and unlikes in the reader’s own repo', async () => {
      await seedSession(WRITE);
      stubNetwork();
      const res = await send('/api/v2/bsky/like', { method: 'POST', body: POST });
      expect(await res.json()).toEqual({ uri: `at://${DID}/app.bsky.feed.like/3new` });
      expect(calls[0].body).toMatchObject({
        repo: DID,
        collection: 'app.bsky.feed.like',
        record: { $type: 'app.bsky.feed.like', subject: POST },
      });

      const undo = await send('/api/v2/bsky/like', {
        method: 'DELETE',
        body: { uri: `at://${DID}/app.bsky.feed.like/3new` },
      });
      expect(undo.status).toBe(200);
      expect(calls[1].body).toEqual({ repo: DID, collection: 'app.bsky.feed.like', rkey: '3new' });
    });

    it('refuses to delete a record that is not the reader’s own like', async () => {
      await seedSession(WRITE);
      stubNetwork();
      for (const uri of [
        'at://did:plc:someoneelse/app.bsky.feed.like/3new',
        `at://${DID}/app.bsky.feed.post/3new`,
      ]) {
        const res = await send('/api/v2/bsky/like', { method: 'DELETE', body: { uri } });
        expect(res.status).toBe(400);
      }
      expect(calls).toHaveLength(0);
    });

    it('reposts', async () => {
      await seedSession(WRITE);
      stubNetwork();
      const res = await send('/api/v2/bsky/repost', { method: 'POST', body: POST });
      expect(await res.json()).toEqual({ uri: `at://${DID}/app.bsky.feed.repost/3new` });
      expect(calls[0].body).toMatchObject({ collection: 'app.bsky.feed.repost' });
    });

    it('replies with facets, threaded under the root', async () => {
      await seedSession(WRITE);
      stubNetwork();
      const root = { uri: 'at://did:plc:root/app.bsky.feed.post/r', cid: 'bafyreiroot0000' };
      const res = await send('/api/v2/bsky/post', {
        method: 'POST',
        body: { text: 'yes @bob.test https://example.com', reply: { root, parent: POST } },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        uri: `at://${DID}/app.bsky.feed.post/3new`,
        url: `https://bsky.app/profile/${DID}/post/3new`,
      });
      const create = calls.find((c) => c.path === 'com.atproto.repo.createRecord');
      expect(create?.body).toMatchObject({
        collection: 'app.bsky.feed.post',
        record: {
          text: 'yes @bob.test https://example.com',
          reply: { root, parent: POST },
          facets: [
            { features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:bob' }] },
            { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] },
          ],
        },
      });
    });

    it('rejects an empty or overlong reply', async () => {
      await seedSession(WRITE);
      stubNetwork();
      expect(
        (await send('/api/v2/bsky/post', { method: 'POST', body: { text: '  ' } })).status
      ).toBe(400);
      expect(
        (await send('/api/v2/bsky/post', { method: 'POST', body: { text: 'x'.repeat(301) } }))
          .status
      ).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });
});
