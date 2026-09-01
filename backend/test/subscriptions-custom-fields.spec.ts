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

const TEST_DID = 'did:plc:customfields123';
const TEST_SESSION_ID = 'test-session-custom-fields';
const COLLECTION = 'app.skyreader.feed.subscription';
const TEST_RKEY = 'abcdefghijklm'; // 13 lowercase alphanumeric chars

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

async function setupTestUser(opts?: { pdsSyncEnabled?: boolean }) {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
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

  if (opts?.pdsSyncEnabled) {
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, pds_sync_enabled, created_at, updated_at)
			 VALUES (?, 1, unixepoch(), unixepoch())`
    )
      .bind(TEST_DID)
      .run();
  }
}

async function insertSubscription(opts?: {
  rkey?: string;
  feedUrl?: string;
  title?: string;
  siteUrl?: string | null;
  customTitle?: string | null;
  customIconUrl?: string | null;
  pdsDirty?: 0 | 1;
}) {
  const rkey = opts?.rkey ?? TEST_RKEY;
  const feedUrl = opts?.feedUrl ?? 'https://example.com/feed.xml';
  const recordUri = `at://${TEST_DID}/${COLLECTION}/${rkey}`;

  await env.DB.prepare(
    `INSERT INTO subscriptions_cache
		 (user_did, record_uri, feed_url, title, site_url, created_at, custom_title, custom_icon_url, pds_dirty)
		 VALUES (?, ?, ?, ?, ?, unixepoch(), ?, ?, ?)`
  )
    .bind(
      TEST_DID,
      recordUri,
      feedUrl,
      opts?.title ?? 'Test Feed',
      opts?.siteUrl ?? null,
      opts?.customTitle ?? null,
      opts?.customIconUrl ?? null,
      opts?.pdsDirty ?? 0
    )
    .run();
}

async function getDirtyFlag(rkey: string): Promise<number | undefined> {
  const row = await env.DB.prepare(
    'SELECT pds_dirty FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
  )
    .bind(TEST_DID, `%/${rkey}`)
    .first<{ pds_dirty: number }>();
  return row?.pds_dirty;
}

async function getSubscriptionFromDb(rkey: string) {
  return env.DB.prepare(
    `SELECT feed_url, title, custom_title, custom_icon_url
		 FROM subscriptions_cache
		 WHERE user_did = ? AND record_uri LIKE ?`
  )
    .bind(TEST_DID, `%/${rkey}`)
    .first<{
      feed_url: string;
      title: string | null;
      custom_title: string | null;
      custom_icon_url: string | null;
    }>();
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

describe('Subscription Custom Fields', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM user_settings').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('PATCH /api/subscriptions/:rkey', () => {
    it('updates customTitle and customIconUrl', async () => {
      await setupTestUser();
      await insertSubscription();

      // Mock PDS fetch (maybePushToPds will be called but sync disabled by default)
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({}),
      });

      const ctx = createExecutionContext();
      const request = makeAuthRequest(`/api/subscriptions/${TEST_RKEY}`, {
        method: 'PATCH',
        body: {
          customTitle: 'My Custom Title',
          customIconUrl: 'https://example.com/icon.png',
        },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const row = await getSubscriptionFromDb(TEST_RKEY);
      expect(row?.custom_title).toBe('My Custom Title');
      expect(row?.custom_icon_url).toBe('https://example.com/icon.png');
    });

    it('returns 401 without auth', async () => {
      const request = new IncomingRequest(`http://localhost/api/subscriptions/${TEST_RKEY}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: env.FRONTEND_URL,
        },
        body: JSON.stringify({ customTitle: 'test' }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    });

    it('returns 404 for non-existent rkey', async () => {
      await setupTestUser();

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({}),
      });

      const ctx = createExecutionContext();
      const request = makeAuthRequest('/api/subscriptions/nonexistentkey1', {
        method: 'PATCH',
        body: { customTitle: 'test' },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it('accepts null to clear custom fields', async () => {
      await setupTestUser();
      await insertSubscription({
        customTitle: 'Old Title',
        customIconUrl: 'https://example.com/old.png',
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({}),
      });

      const ctx = createExecutionContext();
      const request = makeAuthRequest(`/api/subscriptions/${TEST_RKEY}`, {
        method: 'PATCH',
        body: { customTitle: null, customIconUrl: null },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const row = await getSubscriptionFromDb(TEST_RKEY);
      expect(row?.custom_title).toBeNull();
      expect(row?.custom_icon_url).toBeNull();
    });

    it('partial update only changes specified field', async () => {
      await setupTestUser();
      await insertSubscription({
        customTitle: 'Keep This',
        customIconUrl: 'https://example.com/keep.png',
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({}),
      });

      const ctx = createExecutionContext();
      const request = makeAuthRequest(`/api/subscriptions/${TEST_RKEY}`, {
        method: 'PATCH',
        body: { customTitle: 'New Title' },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const row = await getSubscriptionFromDb(TEST_RKEY);
      expect(row?.custom_title).toBe('New Title');
      expect(row?.custom_icon_url).toBe('https://example.com/keep.png');
    });

    it('fires PDS push when pdsSyncEnabled', async () => {
      await setupTestUser({ pdsSyncEnabled: true });
      await insertSubscription();

      let putRecordCalled = false;
      let putRecordBody: unknown = null;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (typeof url === 'string' && url.includes('putRecord')) {
          putRecordCalled = true;
          putRecordBody = JSON.parse(options?.body as string);
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              uri: `at://${TEST_DID}/${COLLECTION}/${TEST_RKEY}`,
              cid: 'bafyreipushed',
            }),
          };
        }
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({}),
        };
      });

      const ctx = createExecutionContext();
      const request = makeAuthRequest(`/api/subscriptions/${TEST_RKEY}`, {
        method: 'PATCH',
        body: {
          customTitle: 'PDS Title',
          customIconUrl: 'https://example.com/pds.png',
        },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(putRecordCalled).toBe(true);

      const body = putRecordBody as {
        record?: { customTitle?: string; customIconUrl?: string };
      };
      expect(body?.record?.customTitle).toBe('PDS Title');
      expect(body?.record?.customIconUrl).toBe('https://example.com/pds.png');
    });

    it('does not fire PDS push when pdsSyncEnabled=false', async () => {
      await setupTestUser({ pdsSyncEnabled: false });
      await insertSubscription();

      let putRecordCalled = false;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('putRecord')) {
          putRecordCalled = true;
        }
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({}),
        };
      });

      const ctx = createExecutionContext();
      const request = makeAuthRequest(`/api/subscriptions/${TEST_RKEY}`, {
        method: 'PATCH',
        body: { customTitle: 'No Push' },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(putRecordCalled).toBe(false);
    });

    it('pushes siteUrl, so a rename does not strip it from the PDS record', async () => {
      // The push is a putRecord — a full replace — so any field left out of it is
      // deleted from the record. site_url was omitted, and for a linkblog follow
      // it is the only durable "this is a linkblog" tell. Worse, the push then
      // settled the row's flag, so no later sync saw anything to repair.
      await setupTestUser({ pdsSyncEnabled: true });
      await insertSubscription({ siteUrl: 'https://author.example/links' });

      let putRecordBody: unknown = null;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (typeof url === 'string' && url.includes('putRecord')) {
          putRecordBody = JSON.parse(options?.body as string);
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              uri: `at://${TEST_DID}/${COLLECTION}/${TEST_RKEY}`,
              cid: 'bafyreipushed',
            }),
          };
        }
        return { ok: true, headers: new Headers(), json: async () => ({}) };
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(
        makeAuthRequest(`/api/subscriptions/${TEST_RKEY}`, {
          method: 'PATCH',
          body: { customTitle: 'Renamed' },
        }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = putRecordBody as { record?: { siteUrl?: string; customTitle?: string } };
      expect(body?.record?.siteUrl).toBe('https://author.example/links');
      expect(body?.record?.customTitle).toBe('Renamed');
    });

    it('keeps a standing pending-write flag when sync is off', async () => {
      // A debt already on the row is owed whatever the current setting says: it
      // came from an earlier edit whose push failed, or from the linkblog route,
      // which flags regardless. Writing a flat 0 here discarded it, so turning
      // sync off and back on could strand a record stale forever.
      await setupTestUser({ pdsSyncEnabled: false });
      await insertSubscription({ pdsDirty: 1 });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({}),
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(
        makeAuthRequest(`/api/subscriptions/${TEST_RKEY}`, {
          method: 'PATCH',
          body: { customTitle: 'Edited While Off' },
        }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await getDirtyFlag(TEST_RKEY)).toBe(1);
    });

    it('leaves the flag set when the push fails, so the next sync repairs it', async () => {
      await setupTestUser({ pdsSyncEnabled: true });
      await insertSubscription();

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('putRecord')) {
          return {
            ok: false,
            status: 500,
            headers: new Headers(),
            text: async () => JSON.stringify({ error: 'InternalServerError' }),
          };
        }
        return { ok: true, headers: new Headers(), json: async () => ({}) };
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(
        makeAuthRequest(`/api/subscriptions/${TEST_RKEY}`, {
          method: 'PATCH',
          body: { customTitle: 'Push Will Fail' },
        }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await getDirtyFlag(TEST_RKEY)).toBe(1);
    });
  });

  describe('POST /api/subscriptions', () => {
    it('stores custom fields in D1 on create', async () => {
      await setupTestUser();

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({}),
      });

      const rkey = 'newsubscript01';
      const ctx = createExecutionContext();
      const request = makeAuthRequest('/api/subscriptions', {
        method: 'POST',
        body: {
          rkey,
          feedUrl: 'https://example.com/new-feed.xml',
          title: 'New Feed',
          customTitle: 'My Custom Name',
          customIconUrl: 'https://example.com/custom-icon.png',
        },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const row = await getSubscriptionFromDb(rkey);
      expect(row?.custom_title).toBe('My Custom Name');
      expect(row?.custom_icon_url).toBe('https://example.com/custom-icon.png');
    });

    it('custom fields included in PDS push on create', async () => {
      await setupTestUser({ pdsSyncEnabled: true });

      let putRecordBody: unknown = null;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (typeof url === 'string' && url.includes('putRecord')) {
          putRecordBody = JSON.parse(options?.body as string);
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              uri: `at://${TEST_DID}/${COLLECTION}/newsubscript02`,
              cid: 'bafyreicreated',
            }),
          };
        }
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({}),
        };
      });

      const ctx = createExecutionContext();
      const request = makeAuthRequest('/api/subscriptions', {
        method: 'POST',
        body: {
          rkey: 'newsubscript02',
          feedUrl: 'https://example.com/pds-feed.xml',
          title: 'PDS Feed',
          customTitle: 'Custom PDS',
          customIconUrl: 'https://example.com/pds-icon.png',
        },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const body = putRecordBody as {
        record?: { customTitle?: string; customIconUrl?: string };
      };
      expect(body?.record?.customTitle).toBe('Custom PDS');
      expect(body?.record?.customIconUrl).toBe('https://example.com/pds-icon.png');
    });

    it('works without custom fields (backward compat)', async () => {
      await setupTestUser();

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({}),
      });

      const rkey = 'newsubscript03';
      const ctx = createExecutionContext();
      const request = makeAuthRequest('/api/subscriptions', {
        method: 'POST',
        body: {
          rkey,
          feedUrl: 'https://example.com/plain-feed.xml',
          title: 'Plain Feed',
        },
      });
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const row = await getSubscriptionFromDb(rkey);
      expect(row?.custom_title).toBeNull();
      expect(row?.custom_icon_url).toBeNull();
    });
  });

  describe('syncSubscriptions() with custom fields', () => {
    it('pull: PDS custom fields stored in D1', async () => {
      await setupTestUser();
      const session = createTestSession();

      const pdsRecords = [
        {
          uri: `at://${TEST_DID}/${COLLECTION}/pdsrkey0000001`,
          cid: 'bafyreipds1',
          value: {
            $type: COLLECTION,
            feedUrl: 'https://example.com/pds-custom.xml',
            title: 'PDS Custom Feed',
            customTitle: 'My Renamed Feed',
            customIconUrl: 'https://example.com/my-icon.png',
            createdAt: new Date().toISOString(),
          },
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: pdsRecords }),
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.pulledFromPds).toBe(1);

      const row = await getSubscriptionFromDb('pdsrkey0000001');
      expect(row?.custom_title).toBe('My Renamed Feed');
      expect(row?.custom_icon_url).toBe('https://example.com/my-icon.png');
    });

    it('push: D1 custom fields sent to PDS', async () => {
      await setupTestUser();
      const session = createTestSession();

      await insertSubscription({
        rkey: 'localcustom001',
        feedUrl: 'https://example.com/local-custom.xml',
        title: 'Local Custom',
        customTitle: 'Pushed Title',
        customIconUrl: 'https://example.com/pushed.png',
      });

      let applyWritesBody: unknown = null;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (typeof url === 'string' && url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ records: [] }),
          };
        }
        if (typeof url === 'string' && url.includes('applyWrites')) {
          applyWritesBody = JSON.parse(options?.body as string);
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'bafycommit', rev: 'rev1' },
              results: [
                {
                  uri: `at://${TEST_DID}/${COLLECTION}/localcustom001`,
                  cid: 'bafyreipushed',
                },
              ],
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.pushedToPds).toBe(1);

      const body = applyWritesBody as {
        writes?: Array<{
          value?: { customTitle?: string; customIconUrl?: string };
        }>;
      };
      expect(body?.writes?.[0]?.value?.customTitle).toBe('Pushed Title');
      expect(body?.writes?.[0]?.value?.customIconUrl).toBe('https://example.com/pushed.png');
    });

    it('pull: missing custom fields stored as null (backward compat)', async () => {
      await setupTestUser();
      const session = createTestSession();

      const pdsRecords = [
        {
          uri: `at://${TEST_DID}/${COLLECTION}/oldrkey0000001`,
          cid: 'bafyreiold1',
          value: {
            $type: COLLECTION,
            feedUrl: 'https://example.com/old-feed.xml',
            title: 'Old Feed',
            createdAt: new Date().toISOString(),
            // no customTitle or customIconUrl
          },
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: pdsRecords }),
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.pulledFromPds).toBe(1);

      const row = await getSubscriptionFromDb('oldrkey0000001');
      expect(row?.custom_title).toBeNull();
      expect(row?.custom_icon_url).toBeNull();
    });
  });
});
