import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { syncSubscriptions, countDirtySubscriptions } from '../src/services/subscription-sync';
import type { Session } from '../src/types';

// A feed the reader kept off their PDS though Atmospheric sync is on (asked
// when its URL looks private: a member-only podcast, a ?token= feed). It must
// never reach the PDS by any path: create, edit, delete, or the full sync.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const TEST_DID = 'did:plc:keepprivate';
const SID = 'sess-keepprivate';
const COLLECTION = 'app.skyreader.feed.subscription';
const PRIVATE_URL = 'https://www.patreon.com/rss/someone?auth=secret123';
const PRIVATE_RKEY = 'privaterkeyaa';

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const session: Session = {
  did: TEST_DID,
  handle: 'private.test',
  pdsUrl: 'https://pds.test',
  accessToken: 'tok',
  refreshToken: 'rtok',
  dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
  expiresAt: Date.now() + 3600000,
};

function req(path: string, opts?: { method?: string; body?: unknown }) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      Cookie: `session_id=${SID}`,
      'Content-Type': 'application/json',
      Origin: env.FRONTEND_URL,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function call(path: string, opts?: { method?: string; body?: unknown }) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req(path, opts), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function row(rkey: string) {
  return env.DB.prepare(
    'SELECT keep_private, pds_dirty FROM subscriptions_cache WHERE user_did = ? AND record_uri = ?'
  )
    .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/${rkey}`)
    .first<{ keep_private: number; pds_dirty: number }>();
}

describe('a subscription kept private', () => {
  let originalFetch: typeof fetch;
  // Every PDS write the worker attempted, as "<xrpc method> <body>".
  let pdsWrites: string[];

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    pdsWrites = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/com\.atproto\.repo\.(putRecord|applyWrites|deleteRecord|createRecord)/.test(url)) {
        pdsWrites.push(`${url.split('/xrpc/')[1]} ${String(init?.body ?? '')}`);
      }
      const body = url.includes('listRecords') ? { records: [] } : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    for (const t of ['subscriptions_cache', 'user_settings', 'sessions', 'users']) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?,?,?,?,unixepoch())`
    )
      .bind(TEST_DID, session.handle, session.pdsUrl, 'free')
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
      .bind(
        SID,
        TEST_DID,
        session.handle,
        session.pdsUrl,
        session.accessToken,
        session.refreshToken,
        session.dpopPrivateKey,
        session.expiresAt
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, pds_sync_enabled, created_at, updated_at)
       VALUES (?, 1, unixepoch(), unixepoch())`
    )
      .bind(TEST_DID)
      .run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function subscribePrivately() {
    const res = await call('/api/subscriptions', {
      method: 'POST',
      body: { rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, title: 'Members', keepPrivate: true },
    });
    expect(res.status).toBe(200);
  }

  it('is stored clean and never pushed on create', async () => {
    await subscribePrivately();

    expect(await row(PRIVATE_RKEY)).toEqual({ keep_private: 1, pds_dirty: 0 });
    expect(pdsWrites).toEqual([]);
  });

  it('still syncs an ordinary subscription made the same way', async () => {
    const res = await call('/api/subscriptions', {
      method: 'POST',
      body: { rkey: 'publicrkeyaaa', feedUrl: 'https://example.com/feed.xml', title: 'Public' },
    });
    expect(res.status).toBe(200);

    expect(await row('publicrkeyaaa')).toMatchObject({ keep_private: 0 });
    expect(pdsWrites.some((w) => w.includes('example.com/feed.xml'))).toBe(true);
  });

  it('is served to the client marked private', async () => {
    await subscribePrivately();

    const res = await call(`/api/records/list?collection=${COLLECTION}`);
    const { records } = (await res.json()) as {
      records: Array<{ uri: string; value: { keepPrivate?: boolean } }>;
    };
    expect(records).toHaveLength(1);
    expect(records[0].value.keepPrivate).toBe(true);
  });

  it('is not marked or pushed when edited', async () => {
    await subscribePrivately();

    const res = await call(`/api/subscriptions/${PRIVATE_RKEY}`, {
      method: 'PATCH',
      body: { customTitle: 'Renamed', category: 'Podcasts' },
    });
    expect(res.status).toBe(200);
    const bulk = await call('/api/subscriptions/bulk-update', {
      method: 'POST',
      body: { rkeys: [PRIVATE_RKEY], updates: { category: 'Members' } },
    });
    expect(bulk.status).toBe(200);

    expect(await row(PRIVATE_RKEY)).toEqual({ keep_private: 1, pds_dirty: 0 });
    expect(pdsWrites).toEqual([]);
    expect(await countDirtySubscriptions(env, TEST_DID)).toBe(0);
  });

  it('asks the PDS to delete nothing when unsubscribed, alone or in bulk', async () => {
    await subscribePrivately();
    const res = await call(`/api/subscriptions/${PRIVATE_RKEY}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await row(PRIVATE_RKEY)).toBeNull();

    await subscribePrivately();
    const bulk = await call('/api/subscriptions/bulk-delete', {
      method: 'POST',
      body: { rkeys: [PRIVATE_RKEY] },
    });
    expect(bulk.status).toBe(200);
    expect(await row(PRIVATE_RKEY)).toBeNull();

    expect(pdsWrites).toEqual([]);
  });

  it('is left out of the full sync, even if something marked it', async () => {
    await subscribePrivately();
    await env.DB.prepare(
      'UPDATE subscriptions_cache SET pds_dirty = 1 WHERE user_did = ? AND keep_private = 1'
    )
      .bind(TEST_DID)
      .run();

    const result = await syncSubscriptions(session, env);

    expect(result.success).toBe(true);
    expect(pdsWrites).toEqual([]);
    expect(await countDirtySubscriptions(env, TEST_DID)).toBe(0);
  });
});
