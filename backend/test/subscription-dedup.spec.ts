import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:dedup00000000';
const TEST_SESSION_ID = 'test-session-dedup';
const COLLECTION = 'app.skyreader.feed.subscription';

async function setupUser() {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(TEST_DID, 'dedup.bsky.social', 'https://test.pds.example')
    .run();

  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_SESSION_ID,
      TEST_DID,
      'dedup.bsky.social',
      'https://test.pds.example',
      'access-token',
      'refresh-token',
      JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'c' }),
      Date.now() + 3600000
    )
    .run();
}

function makeRequest(path: string, body: unknown) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Cookie: `session_id=${TEST_SESSION_ID}`,
      'Content-Type': 'application/json',
      Origin: env.FRONTEND_URL,
    },
    body: JSON.stringify(body),
  });
}

async function countRows(): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM subscriptions_cache WHERE user_did = ?`)
    .bind(TEST_DID)
    .first<{ c: number }>();
  return r?.c ?? 0;
}

describe('Subscription dedup', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM user_settings').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupUser();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns existing subscription when the same URL is added twice', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });

    const url = 'https://example.com/feed.xml';

    const ctx1 = createExecutionContext();
    const res1 = await worker.fetch(
      makeRequest('/api/subscriptions', { rkey: 'firstrkey0001', feedUrl: url }),
      env,
      ctx1
    );
    await waitOnExecutionContext(ctx1);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { rkey: string; existing?: boolean };
    expect(body1.rkey).toBe('firstrkey0001');
    expect(body1.existing).toBeUndefined();

    // Second add of the same URL should return the existing rkey.
    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(
      makeRequest('/api/subscriptions', { rkey: 'secondrkey002', feedUrl: url }),
      env,
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { rkey: string; existing?: boolean };
    expect(body2.rkey).toBe('firstrkey0001');
    expect(body2.existing).toBe(true);

    expect(await countRows()).toBe(1);
  });

  it('dedups across trivial URL variants (case, trailing slash, fragment, default port)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });

    const variants = [
      'https://example.com/feed',
      'https://Example.com/feed',
      'https://example.com/feed/',
      'https://example.com/feed#section',
      'https://example.com:443/feed',
    ];

    let firstRkey = '';
    for (let i = 0; i < variants.length; i++) {
      const rkey = `variant${String(i).padStart(7, '0')}`;
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        makeRequest('/api/subscriptions', { rkey, feedUrl: variants[i] }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rkey: string; existing?: boolean };
      if (i === 0) {
        firstRkey = body.rkey;
        expect(body.existing).toBeUndefined();
      } else {
        expect(body.rkey).toBe(firstRkey);
        expect(body.existing).toBe(true);
      }
    }

    expect(await countRows()).toBe(1);
  });

  it('keeps RSS and AT Proto subscriptions in separate dedup groups', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });

    // RSS subscription
    const ctx1 = createExecutionContext();
    const res1 = await worker.fetch(
      makeRequest('/api/subscriptions', {
        rkey: 'rsskey0000001',
        feedUrl: 'https://example.com/feed',
      }),
      env,
      ctx1
    );
    await waitOnExecutionContext(ctx1);
    expect(res1.status).toBe(200);

    // AT Proto subscription with empty feedUrl — should NOT collide with RSS
    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(
      makeRequest('/api/subscriptions', {
        rkey: 'atpkey0000001',
        sourceType: 'atproto.shares',
        subjectDid: 'did:plc:other00000001',
      }),
      env,
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(200);

    expect(await countRows()).toBe(2);
  });

  it('dedups AT Proto on (sourceType, subjectDid)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });

    const ctx1 = createExecutionContext();
    const res1 = await worker.fetch(
      makeRequest('/api/subscriptions', {
        rkey: 'atpkey0000001',
        sourceType: 'atproto.shares',
        subjectDid: 'did:plc:other00000001',
      }),
      env,
      ctx1
    );
    await waitOnExecutionContext(ctx1);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { rkey: string };

    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(
      makeRequest('/api/subscriptions', {
        rkey: 'atpkey0000002',
        sourceType: 'atproto.shares',
        subjectDid: 'did:plc:other00000001',
      }),
      env,
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { rkey: string; existing?: boolean };
    expect(body2.existing).toBe(true);
    expect(body2.rkey).toBe(body1.rkey);

    expect(await countRows()).toBe(1);
  });

  it('persists the normalized URL in feed_url so future lookups are stable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeRequest('/api/subscriptions', {
        rkey: 'normkey000001',
        feedUrl: 'https://Example.COM/feed/?x=1#frag',
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(`SELECT feed_url FROM subscriptions_cache WHERE user_did = ?`)
      .bind(TEST_DID)
      .first<{ feed_url: string }>();

    // Host lowercased, fragment dropped, trailing slash trimmed.
    expect(row?.feed_url).toBe('https://example.com/feed?x=1');
  });

  it('bulk import collapses duplicate URLs within the input', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeRequest('/api/subscriptions/bulk', {
        subscriptions: [
          { rkey: 'bulkrkey00001', feedUrl: 'https://example.com/feed' },
          { rkey: 'bulkrkey00002', feedUrl: 'https://example.com/feed/' },
          { rkey: 'bulkrkey00003', feedUrl: 'https://EXAMPLE.com/feed' },
          { rkey: 'bulkrkey00004', feedUrl: 'https://example.com/other' },
        ],
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await countRows()).toBe(2);
  });
});
