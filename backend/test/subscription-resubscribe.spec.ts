import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';

// Re-subscribing to a feed the reader can't see it already has.
//
// /api/records/list serves the client ACTIVE rows only, so a parked feed is
// absent from the store's duplicate check — and gets evicted from its cache when
// it is parked. The create route therefore has to dedupe server-side. Before it
// did, `INSERT OR REPLACE` either replaced the parked row (atproto, where the
// (user_did, source_type, feed_url) unique index matches) — losing user_parked
// and orphaning the PDS record under the old rkey — or added a second active row
// (RSS, where a NULL source_type makes the index not match).

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const TEST_DID = 'did:plc:resubscribe';
const SID = 'sess-resubscribe';
const COLLECTION = 'app.skyreader.feed.subscription';
const PUB_URI = 'at://did:plc:author/site.standard.publication/links';

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

async function rows() {
  const r = await env.DB.prepare(
    'SELECT record_uri, active, user_parked FROM subscriptions_cache WHERE user_did = ? ORDER BY record_uri'
  )
    .bind(TEST_DID)
    .all<{ record_uri: string; active: number; user_parked: number }>();
  return r.results || [];
}

async function post(body: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req('/api/subscriptions', { method: 'POST', body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('re-subscribing to an existing subscription', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // Feed warming and any PDS traffic are irrelevant here; keep them inert.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => '{}',
    });
    for (const t of ['subscriptions_cache', 'user_settings', 'sessions', 'users']) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?,?,?,?,unixepoch())`
    )
      .bind(TEST_DID, 'resub.test', 'https://pds.test', 'free')
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
      .bind(
        SID,
        TEST_DID,
        'resub.test',
        'https://pds.test',
        'tok',
        'rtok',
        '{}',
        Date.now() + 3600000
      )
      .run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function seedParkedAtproto() {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, created_at, source_type, subject_did, active, user_parked)
       VALUES (?,?,?,?,unixepoch(),'atproto.documents','did:plc:author',0,1)`
    )
      .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/oldrkeyaaaaaa`, PUB_URI, 'Links')
      .run();
  }

  it('reactivates a parked atproto sub in place, keeping its rkey', async () => {
    await seedParkedAtproto();

    const res = await post({
      rkey: 'newrkeybbbbbb',
      feedUrl: PUB_URI,
      title: 'Links',
      sourceType: 'atproto.documents',
      subjectDid: 'did:plc:author',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { rkey: string; reactivated?: boolean };
    expect(body.reactivated).toBe(true);
    expect(body.rkey).toBe('oldrkeyaaaaaa');

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].record_uri).toContain('oldrkeyaaaaaa');
    expect(all[0].active).toBe(1);
    expect(all[0].user_parked).toBe(0);
  });

  it('reactivates a parked RSS sub instead of adding a duplicate row', async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, created_at, active, user_parked)
       VALUES (?,?,?,?,unixepoch(),0,1)`
    )
      .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/oldrsskeyaaaa`, 'https://ex.com/f.xml', 'Ex')
      .run();

    const res = await post({
      rkey: 'newrsskeybbbb',
      feedUrl: 'https://ex.com/f.xml',
      title: 'Ex',
    });

    expect(res.status).toBe(200);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].record_uri).toContain('oldrsskeyaaaa');
    expect(all[0].active).toBe(1);
    expect(all[0].user_parked).toBe(0);
  });

  it('refuses to reactivate past the plan cap, leaving the row parked', async () => {
    await seedParkedAtproto();
    // Fill every active slot on the free tier.
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, active)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?2)
       SELECT ?1,
              'at://${TEST_DID}/${COLLECTION}/seed' || printf('%010d', n),
              'https://seed.example/f-' || n || '.xml', 'S' || n, unixepoch(), 1
       FROM seq`
    )
      .bind(TEST_DID, 200)
      .run();

    const res = await post({
      rkey: 'newrkeybbbbbb',
      feedUrl: PUB_URI,
      title: 'Links',
      sourceType: 'atproto.documents',
      subjectDid: 'did:plc:author',
    });

    expect(res.status).toBe(403);
    const parked = await env.DB.prepare(
      'SELECT active, user_parked FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
    )
      .bind(TEST_DID, '%/oldrkeyaaaaaa')
      .first<{ active: number; user_parked: number }>();
    expect(parked?.active).toBe(0);
    expect(parked?.user_parked).toBe(1);
  });

  it('prefers the active row when duplicate RSS rows exist for one feed', async () => {
    // Legacy RSS rows carry a NULL source_type, which the
    // (user_did, source_type, feed_url) unique index does not constrain, so
    // duplicates for one feed exist in the wild — that is the bug being fixed
    // here. Seeded parked-first so an unordered lookup would return the parked
    // row and reactivate it alongside the live one.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscriptions_cache
           (user_did, record_uri, feed_url, title, created_at, active, user_parked)
         VALUES (?,?,?,?,unixepoch(),0,1)`
      ).bind(
        TEST_DID,
        `at://${TEST_DID}/${COLLECTION}/parkeddupeaaa`,
        'https://ex.com/f.xml',
        'Ex'
      ),
      env.DB.prepare(
        `INSERT INTO subscriptions_cache
           (user_did, record_uri, feed_url, title, created_at, active)
         VALUES (?,?,?,?,unixepoch(),1)`
      ).bind(
        TEST_DID,
        `at://${TEST_DID}/${COLLECTION}/activedupeaaa`,
        'https://ex.com/f.xml',
        'Ex'
      ),
    ]);

    const res = await post({
      rkey: 'newrsskeybbbb',
      feedUrl: 'https://ex.com/f.xml',
      title: 'Ex',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { rkey: string; alreadySubscribed?: boolean };
    expect(body.alreadySubscribed).toBe(true);
    expect(body.rkey).toBe('activedupeaaa');

    // The parked duplicate is left as it was — no second active row.
    const all = await rows();
    expect(all.filter((r) => r.active === 1)).toHaveLength(1);
    const parked = all.find((r) => r.record_uri.endsWith('parkeddupeaaa'));
    expect(parked?.active).toBe(0);
    expect(parked?.user_parked).toBe(1);
  });

  it('fills in facts the parked row is missing, without touching the user’s edits', async () => {
    // A re-subscribe often arrives from a richer surface than the original add.
    // siteUrl matters most: for a linkblog follow it is the only durable
    // "this is a linkblog" tell. custom_title is the user's own rename and a
    // re-subscribe is not a request to reset it.
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, site_url, custom_title, created_at, source_type, subject_did, active, user_parked)
       VALUES (?,?,?,NULL,NULL,?,unixepoch(),'atproto.documents','did:plc:author',0,1)`
    )
      .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/oldrkeyaaaaaa`, PUB_URI, 'My Rename')
      .run();

    const res = await post({
      rkey: 'newrkeybbbbbb',
      feedUrl: PUB_URI,
      title: 'Links',
      siteUrl: 'https://author.example/links',
      sourceType: 'atproto.documents',
      subjectDid: 'did:plc:author',
    });

    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      'SELECT title, site_url, custom_title, active FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
    )
      .bind(TEST_DID, '%/oldrkeyaaaaaa')
      .first<{ title: string; site_url: string; custom_title: string; active: number }>();
    expect(row?.active).toBe(1);
    expect(row?.title).toBe('Links');
    expect(row?.site_url).toBe('https://author.example/links');
    expect(row?.custom_title).toBe('My Rename');
  });

  it('does not overwrite facts the parked row already has', async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, site_url, created_at, source_type, subject_did, active, user_parked)
       VALUES (?,?,?,?,?,unixepoch(),'atproto.documents','did:plc:author',0,1)`
    )
      .bind(
        TEST_DID,
        `at://${TEST_DID}/${COLLECTION}/oldrkeyaaaaaa`,
        PUB_URI,
        'Original',
        'https://author.example/original'
      )
      .run();

    const res = await post({
      rkey: 'newrkeybbbbbb',
      feedUrl: PUB_URI,
      title: 'Different',
      siteUrl: 'https://author.example/different',
      sourceType: 'atproto.documents',
      subjectDid: 'did:plc:author',
    });

    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      'SELECT title, site_url FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
    )
      .bind(TEST_DID, '%/oldrkeyaaaaaa')
      .first<{ title: string; site_url: string }>();
    expect(row?.title).toBe('Original');
    expect(row?.site_url).toBe('https://author.example/original');
  });

  it('fills a missing siteUrl on an already-active row too', async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, site_url, created_at, source_type, subject_did, active)
       VALUES (?,?,?,?,NULL,unixepoch(),'atproto.documents','did:plc:author',1)`
    )
      .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/liverkeyaaaaa`, PUB_URI, 'Links')
      .run();

    const res = await post({
      rkey: 'newrkeybbbbbb',
      feedUrl: PUB_URI,
      title: 'Links',
      siteUrl: 'https://author.example/links',
      sourceType: 'atproto.documents',
      subjectDid: 'did:plc:author',
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { alreadySubscribed?: boolean }).alreadySubscribed).toBe(true);
    const row = await env.DB.prepare(
      'SELECT site_url FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
    )
      .bind(TEST_DID, '%/liverkeyaaaaa')
      .first<{ site_url: string }>();
    expect(row?.site_url).toBe('https://author.example/links');
  });

  it('returns the existing record when the feed is already active', async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, created_at, active)
       VALUES (?,?,?,?,unixepoch(),1)`
    )
      .bind(TEST_DID, `at://${TEST_DID}/${COLLECTION}/liverkeyaaaaa`, 'https://ex.com/f.xml', 'Ex')
      .run();

    const res = await post({
      rkey: 'newrsskeybbbb',
      feedUrl: 'https://ex.com/f.xml',
      title: 'Ex',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { rkey: string; alreadySubscribed?: boolean };
    expect(body.alreadySubscribed).toBe(true);
    expect(body.rkey).toBe('liverkeyaaaaa');
    expect(await rows()).toHaveLength(1);
  });
});
