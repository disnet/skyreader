import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES, FOLLOWS_LINKS_SCOPES } from '../src/config/scopes';
import type { Session } from '../src/types';
import {
  FIRST_REFRESH_MAX_PAGES,
  FOLLOW_LINKS_GATE_MS,
  FOLLOW_LINKS_RETENTION_MS,
  MAX_SHARES_PER_REFRESH,
  REFRESH_MAX_PAGES,
  groupFollowLinks,
  purgeFollowLinks,
  readFollowLinks,
  refreshFollowLinks,
  type FollowLink,
} from '../src/services/follow-links-store';

// From your follows (docs/plans/FOLLOWS_LINKS_PLAN.md): the D1 half.
//
// What matters here:
//  - A refresh walks the timeline newest-first and stops at the high-water mark,
//    so a steady-state refresh is a page, not the whole window.
//  - A page that fails mid-walk does NOT advance the high-water mark; the next
//    refresh re-walks that ground instead of leaving a hole.
//  - The gate holds: a second read inside 10 minutes serves from D1 only.
//  - Serving groups by article, ranks by distinct sharers, and borrows a card
//    from another sharer when the freshest share was a bare link.
//  - Dismissed links drop out (and come back on restore); opened ones are flagged.
//  - The route needs the getTimeline scope, and sends the appview proxy header.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const DID = 'did:plc:followlinkstest';
const SESSION_ID = 'test-session-follow-links';
const PDS = 'https://test.pds.example';
const SCOPES = [GRANULAR_SCOPES, ...FOLLOWS_LINKS_SCOPES].join(' ');

const SESSION: Session = {
  did: DID,
  handle: 'reader.test',
  pdsUrl: PDS,
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
  expiresAt: Date.now() + 3600000,
  grantedScopes: SCOPES,
};

const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function linkItem(opts: {
  n: number;
  at: number;
  url: string;
  author?: string;
  title?: string;
  repostBy?: string;
}) {
  const author = opts.author ?? `did:plc:author${opts.n}`;
  return {
    post: {
      uri: `at://${author}/app.bsky.feed.post/${opts.n}`,
      author: { did: author, handle: `${author.slice(8)}.test` },
      record: {
        text: `post ${opts.n}`,
        ...(opts.title
          ? {}
          : {
              facets: [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: opts.url }] }],
            }),
      },
      embed: opts.title
        ? {
            $type: 'app.bsky.embed.external#view',
            external: { uri: opts.url, title: opts.title },
          }
        : undefined,
      indexedAt: iso(opts.at),
    },
    ...(opts.repostBy
      ? {
          reason: {
            $type: 'app.bsky.feed.defs#reasonRepost',
            by: { did: opts.repostBy, handle: `${opts.repostBy.slice(8)}.test` },
            indexedAt: iso(opts.at),
          },
        }
      : {}),
  };
}

function textItem(n: number, at: number) {
  return {
    post: {
      uri: `at://did:plc:quiet/app.bsky.feed.post/t${n}`,
      author: { did: 'did:plc:quiet' },
      record: { text: 'no link' },
      indexedAt: iso(at),
    },
  };
}

/**
 * Serve timeline pages keyed by cursor ('' = first page). `fail` makes the page
 * with that cursor return a 500. Records every call so tests can count pages
 * and check headers.
 */
function stubTimeline(pages: Record<string, { feed: unknown[]; cursor?: string }>, fail?: string) {
  const calls: { cursor: string; proxy: string | null }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/xrpc/app.bsky.feed.getTimeline')) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    const cursor = url.searchParams.get('cursor') ?? '';
    const headers = new Headers(init?.headers);
    calls.push({ cursor, proxy: headers.get('atproto-proxy') });
    if (cursor === fail) {
      return new Response(JSON.stringify({ error: 'InternalServerError' }), { status: 500 });
    }
    const page = pages[cursor] ?? { feed: [] };
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

async function syncRow() {
  return env.DB.prepare(
    'SELECT last_poll_at, newest_seen_at, complete, last_error, gap_cursor, gap_stop_at FROM follow_link_sync WHERE user_did = ?'
  )
    .bind(DID)
    .first<{
      last_poll_at: number;
      newest_seen_at: number | null;
      complete: number;
      last_error: string | null;
      gap_cursor: string | null;
      gap_stop_at: number | null;
    }>();
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

async function seedSession(scopes: string) {
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

describe('follow links store', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    for (const [table, column] of [
      ['follow_link_shares', 'user_did'],
      ['follow_link_sync', 'user_did'],
      ['follow_link_state', 'user_did'],
      ['rate_limits', 'user_did'],
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

  describe('refreshFollowLinks', () => {
    it('walks back through the window on the first run and stores the shares', async () => {
      const now = Date.now();
      const calls = stubTimeline({
        '': {
          feed: [
            linkItem({ n: 1, at: now - 1 * HOUR, url: 'https://a.example/one', title: 'One' }),
            textItem(1, now - 2 * HOUR),
          ],
          cursor: 'p2',
        },
        p2: {
          feed: [linkItem({ n: 2, at: now - 30 * HOUR, url: 'https://b.example/two' })],
          cursor: 'p3',
        },
        // Past the retention window: the walk stops here, and nothing on it is kept.
        p3: {
          feed: [
            linkItem({
              n: 3,
              at: now - FOLLOW_LINKS_RETENTION_MS - HOUR,
              url: 'https://c.example',
            }),
          ],
          cursor: 'p4',
        },
      });

      const result = await refreshFollowLinks(env, SESSION, { now });
      expect(result).toMatchObject({ refreshed: true, pages: 3, shares: 2, reachedEnd: true });
      expect(calls.map((c) => c.cursor)).toEqual(['', 'p2', 'p3']);
      expect(calls.every((c) => c.proxy === 'did:web:api.bsky.app#bsky_appview')).toBe(true);

      const sync = await syncRow();
      expect(sync).toMatchObject({ complete: 1, newest_seen_at: now - HOUR, last_error: null });

      const links = await readFollowLinks(env, DID, '7d', now);
      expect(links.map((l) => l.urlNormalized)).toEqual([
        'https://a.example/one',
        'https://b.example/two',
      ]);
    });

    it('stops at the high-water mark on the next run', async () => {
      const t0 = Date.now() - 2 * HOUR;
      stubTimeline({
        '': { feed: [linkItem({ n: 1, at: t0, url: 'https://a.example' })], cursor: 'old' },
      });
      await refreshFollowLinks(env, SESSION, { now: t0 + 1000 });

      const t1 = t0 + FOLLOW_LINKS_GATE_MS + 1000;
      const calls = stubTimeline({
        '': {
          feed: [
            linkItem({ n: 2, at: t0 + 60_000, url: 'https://new.example' }),
            linkItem({ n: 1, at: t0, url: 'https://a.example' }),
            textItem(9, t0 - 1000),
          ],
          cursor: 'older',
        },
        older: { feed: [linkItem({ n: 0, at: t0 - HOUR, url: 'https://x.example' })] },
      });
      const result = await refreshFollowLinks(env, SESSION, { now: t1 });

      expect(result).toMatchObject({ refreshed: true, pages: 1, reachedEnd: true });
      expect(calls).toHaveLength(1);
      expect((await syncRow())?.newest_seen_at).toBe(t0 + 60_000);
    });

    it('does not advance the high-water mark when a page fails mid-walk', async () => {
      const now = Date.now();
      stubTimeline(
        {
          '': {
            feed: [linkItem({ n: 1, at: now - HOUR, url: 'https://a.example' })],
            cursor: 'p2',
          },
        },
        'p2'
      );
      const result = await refreshFollowLinks(env, SESSION, { now });

      expect(result).toMatchObject({ refreshed: true, pages: 1, reachedEnd: false });
      expect(result.refreshed && result.error).toBeTruthy();
      const sync = await syncRow();
      expect(sync?.newest_seen_at).toBeNull();
      expect(sync?.complete).toBe(0);
      expect(sync?.last_error).toBeTruthy();
      // What it did get is kept: the upserts make the re-walk harmless.
      expect(await readFollowLinks(env, DID, '24h', now)).toHaveLength(1);
    });

    it('saves a gap when the first run hits the page cap, and finishes it later', async () => {
      const now = Date.now();
      const total = FIRST_REFRESH_MAX_PAGES + 5;
      // One link per page, an hour apart, all inside the window.
      const pages: Record<string, { feed: unknown[]; cursor?: string }> = {};
      for (let i = 0; i < total; i++) {
        pages[i === 0 ? '' : `p${i}`] = {
          feed: [linkItem({ n: i, at: now - i * HOUR, url: `https://p${i}.example` })],
          ...(i < total - 1 ? { cursor: `p${i + 1}` } : {}),
        };
      }
      stubTimeline(pages);
      const first = await refreshFollowLinks(env, SESSION, { now });
      expect(first).toMatchObject({ pages: FIRST_REFRESH_MAX_PAGES, reachedEnd: false });
      expect(await syncRow()).toMatchObject({
        complete: 1,
        newest_seen_at: now,
        gap_cursor: `p${FIRST_REFRESH_MAX_PAGES}`,
        gap_stop_at: now - FOLLOW_LINKS_RETENTION_MS,
      });

      // Next time: catch up on the new post first, then carry on down the gap.
      const later = now + FOLLOW_LINKS_GATE_MS + 1;
      const calls = stubTimeline({
        ...pages,
        '': {
          feed: [
            linkItem({ n: 100, at: later - 1000, url: 'https://new.example' }),
            textItem(1, now - 1000),
          ],
          cursor: 'unused',
        },
      });
      const second = await refreshFollowLinks(env, SESSION, { now: later });
      expect(second).toMatchObject({ reachedEnd: true, shares: 1 + 5 });
      expect(calls.map((c) => c.cursor)).toEqual([
        '',
        ...Array.from({ length: 5 }, (_, i) => `p${FIRST_REFRESH_MAX_PAGES + i}`),
      ]);
      expect(await syncRow()).toMatchObject({ newest_seen_at: later - 1000, gap_cursor: null });
      expect(await readFollowLinks(env, DID, '7d', later)).toHaveLength(total + 1);
    });

    it('does not skip the posts past the page cap on an incremental run', async () => {
      // Seed a high-water mark two days back, then come back to a busy timeline.
      const t0 = Date.now() - 48 * HOUR;
      stubTimeline({ '': { feed: [linkItem({ n: 0, at: t0, url: 'https://old.example' })] } });
      await refreshFollowLinks(env, SESSION, { now: t0 + 1000 });

      const now = Date.now();
      const total = REFRESH_MAX_PAGES + 2;
      const pages: Record<string, { feed: unknown[]; cursor?: string }> = {};
      for (let i = 0; i < total; i++) {
        pages[i === 0 ? '' : `p${i}`] = {
          feed: [linkItem({ n: i + 1, at: now - (i + 1) * HOUR, url: `https://p${i}.example` })],
          cursor: `p${i + 1}`,
        };
      }
      pages[`p${total}`] = { feed: [textItem(1, t0 - HOUR)] };
      stubTimeline(pages);
      const first = await refreshFollowLinks(env, SESSION, { now });
      expect(first).toMatchObject({ pages: REFRESH_MAX_PAGES, reachedEnd: false });
      expect(await syncRow()).toMatchObject({
        newest_seen_at: now - HOUR,
        gap_cursor: `p${REFRESH_MAX_PAGES}`,
        gap_stop_at: t0,
      });

      const calls = stubTimeline({
        ...pages,
        '': { feed: [textItem(2, now - 2 * HOUR)], cursor: 'x' },
      });
      const second = await refreshFollowLinks(env, SESSION, {
        now: now + FOLLOW_LINKS_GATE_MS + 1,
      });
      expect(second).toMatchObject({ reachedEnd: true });
      expect(calls.map((c) => c.cursor)).toEqual(['', 'p10', 'p11', 'p12']);
      expect((await syncRow())?.gap_cursor).toBeNull();
      expect(await readFollowLinks(env, DID, '7d', now)).toHaveLength(total + 1);
    });

    it('stops before a page that would pass the share cap, and resumes there', async () => {
      const now = Date.now();
      const perPage = 100;
      const pageCount = MAX_SHARES_PER_REFRESH / perPage + 1;
      const pages: Record<string, { feed: unknown[]; cursor?: string }> = {};
      for (let p = 0; p < pageCount; p++) {
        pages[p === 0 ? '' : `p${p}`] = {
          feed: Array.from({ length: perPage }, (_, i) => {
            const n = p * perPage + i;
            return linkItem({ n, at: now - n * 60_000, url: `https://s${n}.example` });
          }),
          ...(p < pageCount - 1 ? { cursor: `p${p + 1}` } : {}),
        };
      }
      stubTimeline(pages);
      const first = await refreshFollowLinks(env, SESSION, { now });
      expect(first).toMatchObject({ shares: MAX_SHARES_PER_REFRESH, reachedEnd: false });
      expect((await syncRow())?.gap_cursor).toBe(`p${pageCount - 1}`);

      const later = now + FOLLOW_LINKS_GATE_MS + 1;
      stubTimeline({ ...pages, '': { feed: [textItem(1, now - 1000)], cursor: 'x' } });
      const second = await refreshFollowLinks(env, SESSION, { now: later });
      expect(second).toMatchObject({ shares: perPage, reachedEnd: true });
      expect(await readFollowLinks(env, DID, '7d', later)).toHaveLength(60);
      const count = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM follow_link_shares WHERE user_did = ?'
      )
        .bind(DID)
        .first<{ n: number }>();
      expect(count?.n).toBe(pageCount * perPage);
    });

    it('is gated, and a concurrent claim loses', async () => {
      const now = Date.now();
      stubTimeline({ '': { feed: [] } });
      await refreshFollowLinks(env, SESSION, { now });

      expect(await refreshFollowLinks(env, SESSION, { now: now + 1000 })).toEqual({
        refreshed: false,
        reason: 'gated',
      });

      // Two refreshes racing past the gate: only one wins the compare-and-set.
      const later = now + FOLLOW_LINKS_GATE_MS + 1;
      const results = await Promise.all([
        refreshFollowLinks(env, SESSION, { now: later }),
        refreshFollowLinks(env, SESSION, { now: later + 1 }),
      ]);
      expect(results.filter((r) => r.refreshed)).toHaveLength(1);
    });

    it('credits reposts to the reposter, so two reposts of one post are two sharers', async () => {
      const now = Date.now();
      stubTimeline({
        '': {
          feed: [
            linkItem({ n: 1, at: now - HOUR, url: 'https://a.example', repostBy: 'did:plc:ben' }),
            linkItem({
              n: 1,
              at: now - 2 * HOUR,
              url: 'https://a.example',
              repostBy: 'did:plc:cy',
            }),
          ],
        },
      });
      await refreshFollowLinks(env, SESSION, { now });
      const [link] = await readFollowLinks(env, DID, '24h', now);
      expect(link.sharerCount).toBe(2);
      expect(link.sharers.map((s) => s.did)).toEqual(['did:plc:ben', 'did:plc:cy']);
    });
  });

  describe('groupFollowLinks', () => {
    const row = (o: {
      url: string;
      sharer: string;
      at: number;
      title?: string;
      post?: string;
    }) => ({
      post_uri: o.post ?? `at://${o.sharer}/p/${o.at}`,
      sharer_did: o.sharer,
      kind: 'post' as const,
      url: `${o.url}?utm_source=bsky`,
      url_normalized: o.url,
      post_text: null,
      card_title: o.title ?? null,
      card_description: null,
      card_thumb: null,
      sharer_handle: null,
      sharer_name: null,
      sharer_avatar: null,
      shared_at: o.at,
    });

    it('ranks by distinct sharers, then by latest share', () => {
      const rows = [
        row({ url: 'https://solo.example/new', sharer: 'did:a', at: 900 }),
        row({ url: 'https://pair.example', sharer: 'did:a', at: 500 }),
        row({ url: 'https://pair.example', sharer: 'did:b', at: 400 }),
        // Same sharer twice is still one sharer.
        row({ url: 'https://twice.example', sharer: 'did:c', at: 300 }),
        row({ url: 'https://twice.example', sharer: 'did:c', at: 200 }),
        row({ url: 'https://solo.example/old', sharer: 'did:d', at: 100 }),
      ];
      const links = groupFollowLinks(rows, new Map());
      expect(links.map((l: FollowLink) => [l.urlNormalized, l.sharerCount])).toEqual([
        ['https://pair.example', 2],
        ['https://solo.example/new', 1],
        ['https://twice.example', 1],
        ['https://solo.example/old', 1],
      ]);
      expect(
        links.find((l) => l.urlNormalized === 'https://twice.example')?.sharers[0].sharedAt
      ).toBe(300);
    });

    it('borrows the card from another sharer when the freshest share was a bare link', () => {
      const [link] = groupFollowLinks(
        [
          row({ url: 'https://a.example', sharer: 'did:a', at: 900 }),
          row({ url: 'https://a.example', sharer: 'did:b', at: 100, title: 'The title' }),
        ],
        new Map()
      );
      expect(link).toMatchObject({
        title: 'The title',
        site: 'a.example',
        firstSharedAt: 100,
        lastSharedAt: 900,
      });
    });

    it('drops dismissed links and flags opened ones', () => {
      const links = groupFollowLinks(
        [
          row({ url: 'https://gone.example', sharer: 'did:a', at: 2 }),
          row({ url: 'https://seen.example', sharer: 'did:a', at: 1 }),
        ],
        new Map([
          ['https://gone.example', { opened: false, dismissed: true }],
          ['https://seen.example', { opened: true, dismissed: false }],
        ])
      );
      expect(links.map((l) => [l.urlNormalized, l.opened])).toEqual([
        ['https://seen.example', true],
      ]);
    });
  });

  describe('routes', () => {
    it('asks for the getTimeline scope without a 403', async () => {
      await seedSession(GRANULAR_SCOPES);
      const calls = stubTimeline({ '': { feed: [] } });
      const res = await send('/api/v2/following-links');
      // 200, not 403: a 403 would raise the app-wide re-login banner on every
      // visit; the page's own empty state is the prompt.
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ scopeRequired: true, links: [] });
      expect(calls).toHaveLength(0);

      const state = await send('/api/v2/following-links/state', {
        method: 'POST',
        body: { url: 'https://a.example/x', action: 'opened' },
      });
      expect(state.status).toBe(403);
    });

    it('serves what it has, refreshes behind, then holds the gate', async () => {
      await seedSession(SCOPES);
      const now = Date.now();
      const calls = stubTimeline({
        '': {
          feed: [linkItem({ n: 1, at: now - HOUR, url: 'https://a.example/x', title: 'X' })],
        },
      });

      const first = await send('/api/v2/following-links');
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        links: FollowLink[];
        sync: { complete: boolean; refreshing: boolean };
      };
      // Nothing stored yet: the refresh runs after the response.
      expect(firstBody.links).toEqual([]);
      expect(firstBody.sync).toMatchObject({ complete: false, refreshing: true });
      expect(calls).toHaveLength(1);

      const second = await send('/api/v2/following-links');
      const secondBody = (await second.json()) as typeof firstBody;
      expect(secondBody.links.map((l) => l.title)).toEqual(['X']);
      expect(secondBody.sync).toMatchObject({ complete: true, refreshing: false });
      expect(calls).toHaveLength(1);
    });

    it('rejects an unknown window', async () => {
      await seedSession(SCOPES);
      stubTimeline({ '': { feed: [] } });
      expect((await send('/api/v2/following-links?window=1y')).status).toBe(400);
      // Inherited object keys are not windows either.
      for (const key of ['toString', 'constructor', '__proto__']) {
        expect((await send(`/api/v2/following-links?window=${key}`)).status).toBe(400);
      }
    });

    it('dismisses, restores, and marks opened', async () => {
      await seedSession(SCOPES);
      const now = Date.now();
      stubTimeline({
        '': { feed: [linkItem({ n: 1, at: now - HOUR, url: 'https://a.example/x' })] },
      });
      await refreshFollowLinks(env, SESSION, { now });

      const state = (action: string) =>
        send('/api/v2/following-links/state', {
          method: 'POST',
          // Tracking params and case don't matter: state is keyed by the normalized URL.
          body: { url: 'https://A.example/x?utm_source=bsky', action },
        });

      expect((await state('opened')).status).toBe(200);
      expect((await readFollowLinks(env, DID, '24h'))[0].opened).toBe(true);

      await state('dismissed');
      expect(await readFollowLinks(env, DID, '24h')).toEqual([]);

      await state('restored');
      const [link] = await readFollowLinks(env, DID, '24h');
      expect(link).toMatchObject({ opened: true });

      expect((await state('bogus')).status).toBe(400);
    });
  });

  describe('purgeFollowLinks', () => {
    it('drops shares past retention and state untouched for a month', async () => {
      const now = Date.now();
      stubTimeline({
        '': {
          feed: [
            linkItem({ n: 1, at: now - HOUR, url: 'https://keep.example/a' }),
            linkItem({ n: 2, at: now - 2 * HOUR, url: 'https://old.example/b' }),
          ],
        },
      });
      await refreshFollowLinks(env, SESSION, { now });
      await env.DB.prepare(
        `UPDATE follow_link_shares SET shared_at = ? WHERE user_did = ? AND url_normalized = ?`
      )
        .bind(now - FOLLOW_LINKS_RETENTION_MS - 1, DID, 'https://old.example/b')
        .run();
      await env.DB.prepare(
        `INSERT INTO follow_link_state (user_did, url_normalized, opened_at, updated_at) VALUES (?, ?, ?, ?)`
      )
        .bind(DID, 'https://stale.example', 1, now - 31 * 24 * HOUR)
        .run();

      expect(await purgeFollowLinks(env, now)).toBe(2);
      const links = await readFollowLinks(env, DID, '7d', now);
      expect(links.map((l) => l.urlNormalized)).toEqual(['https://keep.example/a']);
    });
  });
});
