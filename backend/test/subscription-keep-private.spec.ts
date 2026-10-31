import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { syncSubscriptions, countDirtySubscriptions } from '../src/services/subscription-sync';
import {
  upsertSubscriptionFromFirehose,
  type FirehoseSubscriptionRecord,
} from '../src/services/firehose-subscription';
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
      const body = url.includes('listRecords')
        ? { records: [] }
        : url.includes('applyWrites')
          ? { results: [] }
          : {};
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

  it('takes a parked feed off the PDS when it is re-added privately', async () => {
    // Parked feeds are invisible to the client's duplicate check, so the prompt
    // can be answered for a feed the server already has, already published.
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, created_at, active, user_parked)
       VALUES (?,?,?,?,unixepoch(),0,1)`
    )
      .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/parkedrkeyaaa`, PRIVATE_URL, 'Members')
      .run();

    const res = await call('/api/subscriptions', {
      method: 'POST',
      body: { rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, title: 'Members', keepPrivate: true },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rkey: string }).rkey).toBe('parkedrkeyaaa');

    expect(await row('parkedrkeyaaa')).toEqual({ keep_private: 1, pds_dirty: 0 });
    expect(pdsWrites).toHaveLength(1);
    expect(pdsWrites[0]).toMatch(/^com\.atproto\.repo\.deleteRecord .*parkedrkeyaaa/);
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
  describe('choosing later, and callers that never ask', () => {
    async function subscribe(body: Record<string, unknown>) {
      const res = await call('/api/subscriptions', { method: 'POST', body });
      expect(res.status).toBe(200);
      return (await res.json()) as { rkey: string; keepPrivate?: boolean };
    }

    it('keeps a private-looking link private when the caller did not ask', async () => {
      const res = await subscribe({ rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, title: 'Members' });

      expect(res.keepPrivate).toBe(true);
      expect(await row(PRIVATE_RKEY)).toEqual({ keep_private: 1, pds_dirty: 0 });
      expect(pdsWrites).toEqual([]);
    });

    it('honours an explicit choice to sync it publicly', async () => {
      const res = await subscribe({
        rkey: PRIVATE_RKEY,
        feedUrl: PRIVATE_URL,
        title: 'Members',
        keepPrivate: false,
      });

      expect(res.keepPrivate).toBeUndefined();
      expect(await row(PRIVATE_RKEY)).toMatchObject({ keep_private: 0 });
      expect(pdsWrites.some((w) => w.includes('auth=secret123'))).toBe(true);
    });

    it('takes a published feed off the PDS when made private, and back on when not', async () => {
      await subscribe({ rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, keepPrivate: false });
      pdsWrites = [];

      const toPrivate = await call(`/api/subscriptions/${PRIVATE_RKEY}`, {
        method: 'PATCH',
        body: { keepPrivate: true },
      });
      expect(toPrivate.status).toBe(200);
      expect(await row(PRIVATE_RKEY)).toEqual({ keep_private: 1, pds_dirty: 0 });
      expect(pdsWrites).toHaveLength(1);
      expect(pdsWrites[0]).toMatch(/^com\.atproto\.repo\.deleteRecord .*privaterkeyaa/);

      pdsWrites = [];
      const toPublic = await call(`/api/subscriptions/${PRIVATE_RKEY}`, {
        method: 'PATCH',
        body: { keepPrivate: false },
      });
      expect(toPublic.status).toBe(200);
      expect(await row(PRIVATE_RKEY)).toMatchObject({ keep_private: 0 });
      expect(pdsWrites.some((w) => w.includes('auth=secret123'))).toBe(true);
    });

    it('clears a record left from an earlier spell of sync when made private with sync off', async () => {
      await subscribe({ rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, keepPrivate: false });
      await env.DB.prepare('UPDATE user_settings SET pds_sync_enabled = 0 WHERE user_did = ?')
        .bind(TEST_DID)
        .run();
      pdsWrites = [];

      const res = await call(`/api/subscriptions/${PRIVATE_RKEY}`, {
        method: 'PATCH',
        body: { keepPrivate: true },
      });

      expect(res.status).toBe(200);
      expect(await row(PRIVATE_RKEY)).toMatchObject({ keep_private: 1 });
      expect(pdsWrites).toHaveLength(1);
      expect(pdsWrites[0]).toMatch(/^com\.atproto\.repo\.deleteRecord /);
    });

    it('rejects a keepPrivate that is not a boolean, rather than publish', async () => {
      const res = await call('/api/subscriptions', {
        method: 'POST',
        body: { rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, keepPrivate: null },
      });

      expect(res.status).toBe(400);
      expect(pdsWrites).toEqual([]);
    });

    it('applies the safe default when a parked private-looking feed is re-added unasked', async () => {
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache
           (user_did, record_uri, feed_url, title, created_at, active, user_parked)
         VALUES (?,?,?,?,unixepoch(),0,1)`
      )
        .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/parkedrkeyaaa`, PRIVATE_URL, 'Members')
        .run();

      const res = await subscribe({
        rkey: PRIVATE_RKEY,
        feedUrl: PRIVATE_URL,
        siteUrl: 'https://x.test',
      });

      expect(res.keepPrivate).toBe(true);
      expect(await row('parkedrkeyaaa')).toEqual({ keep_private: 1, pds_dirty: 0 });
      expect(pdsWrites.some((w) => w.includes('auth=secret123'))).toBe(false);
    });

    it('takes down a kept-private record the sync finds published', async () => {
      await subscribePrivately();
      // A push that raced the choice left the record on the PDS.
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/com\.atproto\.repo\.applyWrites/.test(url)) {
          pdsWrites.push(`${url.split('/xrpc/')[1]} ${String(init?.body ?? '')}`);
          return Response.json({ results: [] });
        }
        if (url.includes('listRecords')) {
          return Response.json({
            records: [
              {
                uri: `at://${TEST_DID}/${COLLECTION}/${PRIVATE_RKEY}`,
                cid: 'bafy',
                value: {
                  $type: COLLECTION,
                  feedUrl: PRIVATE_URL,
                  createdAt: new Date().toISOString(),
                },
              },
            ],
          });
        }
        return Response.json({});
      }) as typeof fetch;

      await syncSubscriptions(session, env);

      expect(pdsWrites).toHaveLength(1);
      expect(pdsWrites[0]).toContain('applyWrites#delete');
      expect(pdsWrites[0]).toContain(PRIVATE_RKEY);
    });

    it('leaves a feed public if its record could not be taken down', async () => {
      await subscribe({ rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, keepPrivate: false });
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('deleteRecord')) {
          return Response.json({ error: 'InternalServerError' }, { status: 500 });
        }
        return Response.json({});
      }) as typeof fetch;

      const res = await call(`/api/subscriptions/${PRIVATE_RKEY}`, {
        method: 'PATCH',
        body: { keepPrivate: true },
      });

      expect(res.status).toBe(500);
      expect(await row(PRIVATE_RKEY)).toMatchObject({ keep_private: 0 });
    });

    it('refuses to keep an Atmosphere publication private', async () => {
      await subscribe({
        rkey: 'pubrkeyaaaaaa',
        feedUrl: 'at://did:plc:author/site.standard.publication/p',
        sourceType: 'atproto.documents',
        subjectDid: 'did:plc:author',
      });

      const res = await call('/api/subscriptions/pubrkeyaaaaaa', {
        method: 'PATCH',
        body: { keepPrivate: true },
      });
      expect(res.status).toBe(400);
    });

    it('keeps private-looking feeds in an import off the PDS', async () => {
      const res = await call('/api/subscriptions/bulk', {
        method: 'POST',
        body: {
          subscriptions: [
            { rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, title: 'Members' },
            { rkey: 'publicrkeyaaa', feedUrl: 'https://example.com/feed.xml', title: 'Public' },
          ],
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { keptPrivate: string[] };

      expect(body.keptPrivate).toEqual([PRIVATE_RKEY]);
      expect(await row(PRIVATE_RKEY)).toEqual({ keep_private: 1, pds_dirty: 0 });
      expect(pdsWrites.some((w) => w.includes('example.com/feed.xml'))).toBe(true);
      expect(pdsWrites.some((w) => w.includes('auth=secret123'))).toBe(false);
    });

    it("carries each imported feed's folder to the PDS", async () => {
      const res = await call('/api/subscriptions/bulk', {
        method: 'POST',
        body: {
          subscriptions: [
            {
              rkey: 'publicrkeyaaa',
              feedUrl: 'https://example.com/feed.xml',
              title: 'Public',
              category: 'Tech',
            },
            { rkey: 'publicrkeybbb', feedUrl: 'https://example.org/feed.xml', title: 'Loose' },
          ],
        },
      });
      expect(res.status).toBe(200);

      const write = pdsWrites.find((w) => w.startsWith('com.atproto.repo.applyWrites'));
      const { writes } = JSON.parse(write!.slice(write!.indexOf(' ') + 1)) as {
        writes: Array<{ rkey: string; value: { category?: string } }>;
      };
      const byRkey = Object.fromEntries(writes.map((w) => [w.rkey, w.value]));
      expect(byRkey.publicrkeyaaa.category).toBe('Tech');
      expect(byRkey.publicrkeybbb.category).toBeUndefined();

      // The Jetstream mirror of that write must leave the folder in place.
      await upsertSubscriptionFromFirehose(
        env.DB,
        TEST_DID,
        'publicrkeyaaa',
        byRkey.publicrkeyaaa as FirehoseSubscriptionRecord
      );
      const stored = await env.DB.prepare(
        'SELECT category FROM subscriptions_cache WHERE user_did = ? AND record_uri = ?'
      )
        .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/publicrkeyaaa`)
        .first<{ category: string | null }>();
      expect(stored?.category).toBe('Tech');
    });

    it('lists the feeds that would be published as they stand', async () => {
      await env.DB.prepare('UPDATE user_settings SET pds_sync_enabled = 0 WHERE user_did = ?')
        .bind(TEST_DID)
        .run();
      // Added while sync was off, so nothing asked; one of them parked.
      await subscribe({ rkey: PRIVATE_RKEY, feedUrl: PRIVATE_URL, title: 'Members' });
      await subscribe({ rkey: 'publicrkeyaaa', feedUrl: 'https://example.com/feed.xml' });
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, active)
         VALUES (?,?,?,?,unixepoch(),0)`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/parkedrkeyaaa`,
          'https://x.supercast.com/f/abc',
          'Parked'
        )
        .run();

      const res = await call('/api/subscriptions/private-candidates');
      const { candidates } = (await res.json()) as { candidates: Array<{ rkey: string }> };

      expect(candidates.map((c) => c.rkey).sort()).toEqual(['parkedrkeyaaa', PRIVATE_RKEY]);
    });
  });
});
