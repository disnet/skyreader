import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncSubscriptions } from '../src/services/subscription-sync';
import type { Session } from '../src/types';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const TEST_DID = 'did:plc:parking123';
const TEST_SESSION_ID = 'test-session-parking';
const COLLECTION = 'app.skyreader.feed.subscription';

function createTestSession(overrides?: Partial<Session>): Session {
  return {
    did: TEST_DID,
    handle: 'test.bsky.social',
    pdsUrl: 'https://test.pds.example',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
    expiresAt: Date.now() + 3600000,
    ...overrides,
  };
}

async function setupTestUser(tier: 'free' | 'supporter' = 'free') {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example', tier)
    .run();

  const session = createTestSession();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_SESSION_ID,
      session.did,
      session.handle,
      session.pdsUrl,
      session.accessToken,
      session.refreshToken,
      session.dpopPrivateKey,
      session.expiresAt
    )
    .run();
}

async function insertSub(rkey: string, active: number, feedUrl?: string) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, active)
     VALUES (?, ?, ?, ?, unixepoch(), ?)`
  )
    .bind(
      TEST_DID,
      `at://${TEST_DID}/${COLLECTION}/${rkey}`,
      feedUrl ?? `https://example.com/${rkey}.xml`,
      `Feed ${rkey}`,
      active
    )
    .run();
}

// Bulk-seed N active RSS rows in a single statement (recursive CTE) so cap tests
// don't pay for N round-trips. Rows are distinct by record_uri and feed_url.
async function seedActiveRows(count: number) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, active)
     WITH RECURSIVE seq(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?2
     )
     SELECT ?1,
            'at://${TEST_DID}/${COLLECTION}/seedrkey' || printf('%07d', n),
            'https://seed.example/feed-' || n || '.xml',
            'Seed ' || n,
            unixepoch(),
            1
     FROM seq`
  )
    .bind(TEST_DID, count)
    .run();
}

async function countWhere(clause: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ?${clause ? ' AND ' + clause : ''}`
  )
    .bind(TEST_DID)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function getActive(rkey: string): Promise<number | undefined> {
  const row = await env.DB.prepare(
    'SELECT active FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
  )
    .bind(TEST_DID, `%/${rkey}`)
    .first<{ active: number }>();
  return row?.active;
}

function makeAuthRequest(path: string, opts?: { method?: string; body?: unknown }) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      Cookie: `session_id=${TEST_SESSION_ID}`,
      'Content-Type': 'application/json',
      Origin: env.FRONTEND_URL,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

// 13+ lowercase-alphanumeric rkeys (valid TIDs).
const RKEY_A = 'aaaaaaaaaaaa1';
const RKEY_B = 'bbbbbbbbbbbb2';

describe('Subscription parking', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM user_settings').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    // Any feed-warming / PDS push goes through fetch — stub it so tests stay offline.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('POST /api/subscriptions/:rkey/park', () => {
    it('flips an active sub to parked', async () => {
      await setupTestUser();
      await insertSub(RKEY_A, 1);

      const ctx = createExecutionContext();
      const res = await worker.fetch(
        makeAuthRequest(`/api/subscriptions/${RKEY_A}/park`, { method: 'POST' }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(await getActive(RKEY_A)).toBe(0);
    });

    it('excludes a parked sub from /api/records/list but lists it under /parked', async () => {
      await setupTestUser();
      await insertSub(RKEY_A, 1, 'https://example.com/active.xml');
      await insertSub(RKEY_B, 0, 'https://example.com/parked.xml');

      // records/list returns active only
      const ctx1 = createExecutionContext();
      const listRes = await worker.fetch(
        makeAuthRequest(`/api/records/list?collection=${COLLECTION}`),
        env,
        ctx1
      );
      await waitOnExecutionContext(ctx1);
      const listBody = (await listRes.json()) as { records: Array<{ value: { feedUrl: string } }> };
      const activeUrls = listBody.records.map((r) => r.value.feedUrl);
      expect(activeUrls).toContain('https://example.com/active.xml');
      expect(activeUrls).not.toContain('https://example.com/parked.xml');

      // /parked returns parked only
      const ctx2 = createExecutionContext();
      const parkedRes = await worker.fetch(makeAuthRequest('/api/subscriptions/parked'), env, ctx2);
      await waitOnExecutionContext(ctx2);
      const parkedBody = (await parkedRes.json()) as {
        records: Array<{ value: { feedUrl: string } }>;
      };
      const parkedUrls = parkedBody.records.map((r) => r.value.feedUrl);
      expect(parkedUrls).toEqual(['https://example.com/parked.xml']);
    });

    it('is idempotent — parking an already-parked sub succeeds', async () => {
      await setupTestUser();
      await insertSub(RKEY_A, 0);

      const ctx = createExecutionContext();
      const res = await worker.fetch(
        makeAuthRequest(`/api/subscriptions/${RKEY_A}/park`, { method: 'POST' }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(await getActive(RKEY_A)).toBe(0);
    });

    it('404s for an unknown rkey', async () => {
      await setupTestUser();

      const ctx = createExecutionContext();
      const res = await worker.fetch(
        makeAuthRequest(`/api/subscriptions/${RKEY_A}/park`, { method: 'POST' }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/subscriptions/:rkey/activate', () => {
    it('flips a parked sub back to active when there is room', async () => {
      await setupTestUser();
      await insertSub(RKEY_A, 0);

      const ctx = createExecutionContext();
      const res = await worker.fetch(
        makeAuthRequest(`/api/subscriptions/${RKEY_A}/activate`, { method: 'POST' }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(await getActive(RKEY_A)).toBe(1);
    });

    it('is blocked with 403 when already at the active limit', async () => {
      await setupTestUser(); // free → 100 active limit
      await seedActiveRows(100); // exactly at the cap
      await insertSub(RKEY_A, 0); // one parked feed wanting in

      const ctx = createExecutionContext();
      const res = await worker.fetch(
        makeAuthRequest(`/api/subscriptions/${RKEY_A}/activate`, { method: 'POST' }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('subscription_limit_reached');
      // Still parked — the failed activate didn't push us over the cap.
      expect(await getActive(RKEY_A)).toBe(0);
    });
  });

  describe('POST /api/subscriptions/bulk', () => {
    it('parks the overflow past the active limit and reports parked rkeys', async () => {
      await setupTestUser(); // free → 100 active limit
      await seedActiveRows(98); // 2 active slots left

      const subscriptions = Array.from({ length: 5 }, (_, i) => ({
        rkey: `importfeed00${i}xx`,
        feedUrl: `https://import.example/feed-${i}.xml`,
        title: `Import ${i}`,
      }));

      const ctx = createExecutionContext();
      const res = await worker.fetch(
        makeAuthRequest('/api/subscriptions/bulk', { method: 'POST', body: { subscriptions } }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: unknown[];
        parked: string[];
        dropped: string[];
      };
      // 2 fill the remaining active slots, 3 are parked. None dropped (mirror cap far off).
      expect(body.parked).toHaveLength(3);
      expect(body.dropped).toHaveLength(0);
      expect(await countWhere('active = 1')).toBe(100);
      expect(await countWhere('active = 0')).toBe(3);
    });

    it('drops imports past the mirror ceiling and reports dropped rkeys', async () => {
      await setupTestUser(); // free → 1000 mirror ceiling
      await seedActiveRows(999); // one row below the mirror cap

      const subscriptions = Array.from({ length: 4 }, (_, i) => ({
        rkey: `capfeed0000${i}xx`,
        feedUrl: `https://cap.example/feed-${i}.xml`,
        title: `Cap ${i}`,
      }));

      const ctx = createExecutionContext();
      const res = await worker.fetch(
        makeAuthRequest('/api/subscriptions/bulk', { method: 'POST', body: { subscriptions } }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { parked: string[]; dropped: string[] };
      // Only 1 row fits under the 1000 mirror cap (and it's parked, since active is
      // long full); the other 3 are dropped entirely.
      expect(body.dropped).toHaveLength(3);
      expect(await countWhere('')).toBe(1000);
    });
  });

  describe('syncSubscriptions mirror cap', () => {
    it('stops materializing rows at the plan mirror ceiling', async () => {
      await setupTestUser(); // free → 1000 mirror ceiling
      await seedActiveRows(998); // 2 rows below the cap

      // PDS offers 5 brand-new records. Only 2 can be stored before the cap; the
      // other 3 are dropped (still on the PDS).
      const pdsRecords = Array.from({ length: 5 }, (_, i) => ({
        uri: `at://${TEST_DID}/${COLLECTION}/pdsnew0000${i}xx`,
        cid: `bafyreipdsnew${i}`,
        value: {
          $type: COLLECTION,
          feedUrl: `https://pdsnew.example/feed-${i}.xml`,
          title: `PDS New ${i}`,
          createdAt: new Date().toISOString(),
        },
      }));

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return { ok: true, headers: new Headers(), json: async () => ({ records: pdsRecords }) };
        }
        // applyWrites (pushing the 998 seeded rows) — accept everything.
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({ commit: { cid: 'c', rev: 'r' }, results: [] }),
        };
      });

      const result = await syncSubscriptions(createTestSession(), env);

      expect(result.success).toBe(true);
      expect(await countWhere('')).toBe(1000); // hard ceiling, not 1003
      const capWarning = result.warnings.find((w) => w.includes('mirror limit'));
      expect(capWarning).toBeDefined();
      expect(capWarning).toContain('3 feeds');
    });
  });

  describe('syncSubscriptions auto-fill', () => {
    it('promotes the oldest parked rows into freed active slots', async () => {
      await setupTestUser(); // free → 100 active limit

      // 99 active + 2 parked: one active slot is free. The parked rows are older
      // (created_at 1) than the seeded active rows (created_at = now).
      await seedActiveRows(99);
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, active)
         VALUES (?, ?, ?, 'Old parked A', 1, 0), (?, ?, ?, 'Old parked B', 2, 0)`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/oldparkedaaaa1`,
          'https://parked.example/a.xml',
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/oldparkedbbbb2`,
          'https://parked.example/b.xml'
        )
        .run();

      // PDS returns nothing new; push of the local rows is accepted.
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return { ok: true, headers: new Headers(), json: async () => ({ records: [] }) };
        }
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({ commit: { cid: 'c', rev: 'r' }, results: [] }),
        };
      });

      const result = await syncSubscriptions(createTestSession(), env);

      expect(result.success).toBe(true);
      // Exactly one slot was free, so only the oldest parked row (A) is promoted.
      expect(result.reactivated).toBe(1);
      expect(await countWhere('active = 1')).toBe(100);
      expect(await getActive('oldparkedaaaa1')).toBe(1);
      expect(await getActive('oldparkedbbbb2')).toBe(0);
    });
  });
});
