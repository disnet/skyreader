import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES, FOLLOWS_LINKS_SCOPES } from '../src/config/scopes';
import {
  FOLLOW_LINKS_ACTIVE_MS,
  FOLLOW_LINKS_BACKGROUND_INTERVAL_MS,
  FOLLOW_LINKS_BACKGROUND_KEY,
  dispatchBackgroundFollowLinks,
  selectDueReaders,
} from '../src/services/follow-links-background';
import { FOLLOW_LINKS_SCOPE_DENIED } from '../src/services/follow-links-store';
import { getBackgroundSession } from '../src/services/oauth';
import { SAVED_SEARCH_ENABLED_KEY } from '../src/services/saved-search';

// From your follows, refreshed in the background (docs/plans/FOLLOWS_LINKS_PLAN.md).
//
// What matters here:
//  - Only readers who use follows links are polled: opened them this week, or
//    a Supporter's saved search takes them in. Nobody else costs anything.
//  - A reader is due once neither a refresh nor a hand-off happened in the
//    last interval, so a reader whose session can't refresh isn't retried
//    every minute.
//  - The background session refreshes its token with the client_id it was
//    issued under, which only the stored column can give it.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const PDS = 'https://test.pds.example';
const AUTH = 'https://auth.test.example';
const CLIENT_ID = 'https://api.test.example/.well-known/client-metadata';
const SCOPES = [GRANULAR_SCOPES, ...FOLLOWS_LINKS_SCOPES].join(' ');
const DIDS = ['did:plc:bgreader1', 'did:plc:bgreader2', 'did:plc:bgreader3', 'did:plc:bgreader4'];
const [A, B, C, D] = DIDS;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function seedUser(did: string, tier = 'free') {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(did, `${did.slice(8)}.test`, PDS, tier)
    .run();
}

async function seedSync(
  did: string,
  row: {
    lastPollAt?: number;
    lastSeenAt?: number | null;
    bgAttemptAt?: number | null;
    lastError?: string | null;
    inEverything?: number | null;
  }
) {
  await env.DB.prepare(
    `INSERT INTO follow_link_sync (user_did, last_poll_at, last_seen_at, bg_attempt_at, last_error, in_everything, complete)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(
      did,
      row.lastPollAt ?? 0,
      row.lastSeenAt ?? null,
      row.bgAttemptAt ?? null,
      row.lastError ?? null,
      row.inEverything ?? null
    )
    .run();
}

async function seedQuery(did: string, sourceMode: string, sourceKeys: string[]) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO saved_queries (user_did, channel_uuid, query, fts_query, source_mode, source_keys, created_at, updated_at)
     VALUES (?, ?, 'otters', '"otters"', ?, ?, ?, ?)`
  )
    .bind(did, `chan-${did}`, sourceMode, JSON.stringify(sourceKeys), now, now)
    .run();
}

async function setSwitch(key: string, value: string) {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(key, value)
    .run();
}

async function seedSession(
  did: string,
  opts: { clientId?: string | null; expiresAt?: number; sessionId?: string } = {}
) {
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes, client_id)
     VALUES (?, ?, ?, ?, 'old-access', 'old-refresh', ?, ?, ?, ?)`
  )
    .bind(
      opts.sessionId ?? `session-${did}`,
      did,
      `${did.slice(8)}.test`,
      PDS,
      JSON.stringify(TEST_DPOP_KEY),
      opts.expiresAt ?? Date.now() + 3600000,
      SCOPES,
      opts.clientId === undefined ? CLIENT_ID : opts.clientId
    )
    .run();
}

/** Answers the auth server's metadata and token endpoint; records each token request's body. */
function stubAuthServer(tokenBodies: URLSearchParams[]) {
  return async (url: URL, init?: RequestInit): Promise<Response | null> => {
    if (url.href === `${PDS}/.well-known/oauth-protected-resource`) {
      return Response.json({ authorization_servers: [AUTH] });
    }
    if (url.href === `${AUTH}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/oauth/authorize`,
        token_endpoint: `${AUTH}/oauth/token`,
      });
    }
    if (url.href === `${AUTH}/oauth/token`) {
      tokenBodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: SCOPES,
      });
    }
    return null;
  };
}

describe('follow links background refresh', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    for (const table of ['follow_link_shares', 'follow_link_sync', 'saved_queries']) {
      await env.DB.prepare(
        `DELETE FROM ${table} WHERE user_did IN (${DIDS.map(() => '?').join(',')})`
      )
        .bind(...DIDS)
        .run();
    }
    await env.DB.prepare(`DELETE FROM sessions WHERE did IN (${DIDS.map(() => '?').join(',')})`)
      .bind(...DIDS)
      .run();
    await env.DB.prepare(`DELETE FROM users WHERE did IN (${DIDS.map(() => '?').join(',')})`)
      .bind(...DIDS)
      .run();
    await env.DB.prepare(`DELETE FROM sync_state WHERE key IN (?, ?)`)
      .bind(FOLLOW_LINKS_BACKGROUND_KEY, SAVED_SEARCH_ENABLED_KEY)
      .run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('selectDueReaders', () => {
    it('picks readers who opened follows links this week and are due, most overdue first', async () => {
      const now = Date.now();
      for (const did of DIDS) await seedUser(did);
      await seedSync(A, { lastSeenAt: now - DAY, lastPollAt: now - 2 * 60 * MINUTE });
      await seedSync(B, { lastSeenAt: now - DAY, lastPollAt: now - 5 * 60 * MINUTE });
      // Opened too long ago.
      await seedSync(C, { lastSeenAt: now - FOLLOW_LINKS_ACTIVE_MS - MINUTE });
      expect(await selectDueReaders(env, now)).toEqual([B, A]);
    });

    it('skips a reader refreshed or handed off within the interval', async () => {
      const now = Date.now();
      for (const did of DIDS) await seedUser(did);
      const recent = now - FOLLOW_LINKS_BACKGROUND_INTERVAL_MS + MINUTE;
      await seedSync(A, { lastSeenAt: now, lastPollAt: recent });
      await seedSync(B, { lastSeenAt: now, bgAttemptAt: recent });
      await seedSync(C, { lastSeenAt: now });
      expect(await selectDueReaders(env, now)).toEqual([C]);
    });

    it('leaves a scope-denied reader to the read path', async () => {
      const now = Date.now();
      await seedUser(A);
      await seedSync(A, { lastSeenAt: now, lastError: FOLLOW_LINKS_SCOPE_DENIED });
      expect(await selectDueReaders(env, now)).toEqual([]);
    });

    it('stops for everyone when the operator switch is 0', async () => {
      const now = Date.now();
      await seedUser(A);
      await seedSync(A, { lastSeenAt: now });
      await setSwitch(FOLLOW_LINKS_BACKGROUND_KEY, '0');
      expect(await selectDueReaders(env, now)).toEqual([]);
    });

    it("takes in a Supporter's saved search that covers follows links, without a visit", async () => {
      const now = Date.now();
      await setSwitch(SAVED_SEARCH_ENABLED_KEY, '1');
      await seedUser(A, 'supporter');
      await seedUser(B, 'free');
      await seedUser(C, 'supporter');
      await seedUser(D, 'supporter');
      // Turned follows links on once, not opened them since.
      for (const did of [A, B, C]) await seedSync(did, {});
      await seedQuery(A, 'include', ['bsky~follows']);
      // Free plan: its queries don't match.
      await seedQuery(B, 'include', ['bsky~follows']);
      // Excludes follows.
      await seedQuery(C, 'exclude', ['bsky~follows']);
      // Never turned follows links on: no sync row, nothing to refresh.
      await seedQuery(D, 'exclude', []);
      expect(await selectDueReaders(env, now)).toEqual([A]);

      await setSwitch(SAVED_SEARCH_ENABLED_KEY, '0');
      expect(await selectDueReaders(env, now)).toEqual([]);
    });

    it("counts an 'all' query only when follows links are in Everything", async () => {
      const now = Date.now();
      await setSwitch(SAVED_SEARCH_ENABLED_KEY, '1');
      await seedUser(A, 'supporter');
      await seedUser(B, 'supporter');
      await seedQuery(A, 'all', []);
      await seedQuery(B, 'all', []);
      await seedSync(A, { inEverything: 1 });
      await seedSync(B, { inEverything: 0 });
      expect(await selectDueReaders(env, now)).toEqual([A]);
    });
  });

  describe('getBackgroundSession', () => {
    it('uses a live token as it is', async () => {
      await seedUser(A);
      await seedSession(A);
      globalThis.fetch = vi.fn(async () => {
        throw new Error('no fetch expected');
      }) as unknown as typeof fetch;
      const session = await getBackgroundSession(env, A, () => true);
      expect(session?.accessToken).toBe('old-access');
    });

    it('refreshes an expiring token under the client it was issued to', async () => {
      await seedUser(A);
      await seedSession(A, { expiresAt: Date.now() + MINUTE });
      const tokenBodies: URLSearchParams[] = [];
      const auth = stubAuthServer(tokenBodies);
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await auth(new URL(String(input)), init);
        if (!res) throw new Error(`Unexpected fetch: ${input}`);
        return res;
      }) as unknown as typeof fetch;

      const session = await getBackgroundSession(env, A, () => true);
      expect(session?.accessToken).toBe('new-access');
      expect(tokenBodies).toHaveLength(1);
      expect(tokenBodies[0].get('client_id')).toBe(CLIENT_ID);
      expect(tokenBodies[0].get('client_assertion')).toBeTruthy();

      const row = await env.DB.prepare(
        'SELECT access_token, refresh_token, client_id FROM sessions WHERE did = ?'
      )
        .bind(A)
        .first<{ access_token: string; refresh_token: string; client_id: string }>();
      expect(row).toEqual({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        client_id: CLIENT_ID,
      });
    });

    it('passes over a session that fails the check, without refreshing it', async () => {
      await seedUser(A);
      // The freshest session lacks the permission; an older one has it.
      await seedSession(A, { sessionId: 'bg-narrow', expiresAt: Date.now() + 2 * 3600000 });
      await env.DB.prepare(`UPDATE sessions SET granted_scopes = 'atproto' WHERE session_id = ?`)
        .bind('bg-narrow')
        .run();
      await seedSession(A, { sessionId: 'bg-wide', expiresAt: Date.now() + 3600000 });
      globalThis.fetch = vi.fn(async () => {
        throw new Error('no fetch expected');
      }) as unknown as typeof fetch;
      const session = await getBackgroundSession(env, A, (scopes) => scopes === SCOPES);
      expect(session?.grantedScopes).toBe(SCOPES);
      expect(await getBackgroundSession(env, A, () => false)).toBeNull();
    });

    it('has nothing for a session that predates the stored client', async () => {
      await seedUser(A);
      await seedSession(A, { clientId: null });
      expect(await getBackgroundSession(env, A, () => true)).toBeNull();
    });

    it('waits out a session in refresh backoff', async () => {
      await seedUser(A);
      await seedSession(A, { expiresAt: Date.now() - MINUTE });
      await env.DB.prepare('UPDATE sessions SET refresh_locked_until = ? WHERE did = ?')
        .bind(Date.now() + 10 * MINUTE, A)
        .run();
      globalThis.fetch = vi.fn(async () => {
        throw new Error('no fetch expected');
      }) as unknown as typeof fetch;
      expect(await getBackgroundSession(env, A, () => true)).toBeNull();
    });
  });

  describe('dispatchBackgroundFollowLinks', () => {
    it("refreshes each due reader's shares and stamps the hand-off", async () => {
      const now = Date.now();
      await seedUser(A);
      await seedSession(A);
      await seedSync(A, { lastSeenAt: now - DAY });
      const url = 'https://example.com/otters';
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith('/xrpc/app.bsky.feed.getTimeline')) {
          return Response.json({
            feed: [
              {
                post: {
                  uri: 'at://did:plc:sharer/app.bsky.feed.post/1',
                  author: { did: 'did:plc:sharer', handle: 'sharer.test' },
                  record: { text: 'otters!' },
                  embed: {
                    $type: 'app.bsky.embed.external#view',
                    external: { uri: url, title: 'Otters' },
                  },
                  indexedAt: new Date(now - MINUTE).toISOString(),
                },
              },
            ],
          });
        }
        if (u.pathname.endsWith('/xrpc/app.bsky.feed.getPosts')) {
          return Response.json({ posts: [] });
        }
        throw new Error(`Unexpected fetch: ${u}`);
      }) as unknown as typeof fetch;

      await dispatchBackgroundFollowLinks(env, now);

      const shares = await env.DB.prepare('SELECT url FROM follow_link_shares WHERE user_did = ?')
        .bind(A)
        .all<{ url: string }>();
      expect(shares.results.map((r) => r.url)).toEqual([url]);
      const sync = await env.DB.prepare(
        'SELECT bg_attempt_at, last_poll_at FROM follow_link_sync WHERE user_did = ?'
      )
        .bind(A)
        .first<{ bg_attempt_at: number; last_poll_at: number }>();
      expect(sync?.bg_attempt_at).toBe(now);
      expect(sync?.last_poll_at).toBeGreaterThan(0);
      // Not due again until the interval passes.
      expect(await selectDueReaders(env, now + MINUTE)).toEqual([]);
    });

    it('stamps a reader with no usable session so the next minute skips them', async () => {
      const now = Date.now();
      await seedUser(A);
      await seedSync(A, { lastSeenAt: now });
      globalThis.fetch = vi.fn(async () => {
        throw new Error('no fetch expected');
      }) as unknown as typeof fetch;
      await dispatchBackgroundFollowLinks(env, now);
      expect(await selectDueReaders(env, now + MINUTE)).toEqual([]);
      expect(await selectDueReaders(env, now + FOLLOW_LINKS_BACKGROUND_INTERVAL_MS + 1)).toEqual([
        A,
      ]);
    });
  });

  describe('GET /api/v2/following-links', () => {
    it('stamps when the reader last opened follows links', async () => {
      const now = Date.now();
      await seedUser(A);
      await seedSession(A, { sessionId: 'bg-route-session' });
      await seedSync(A, { lastPollAt: now, lastSeenAt: now - 2 * DAY });
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new IncomingRequest('http://localhost/api/v2/following-links?window=24h', {
          headers: { Cookie: 'session_id=bg-route-session', Origin: env.FRONTEND_URL },
        }) as never,
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      const row = await env.DB.prepare(
        'SELECT last_seen_at FROM follow_link_sync WHERE user_did = ?'
      )
        .bind(A)
        .first<{ last_seen_at: number }>();
      expect(row!.last_seen_at).toBeGreaterThanOrEqual(now);
    });
  });
});
