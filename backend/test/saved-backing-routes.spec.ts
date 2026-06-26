import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as write from '../src/services/backing/write';
import * as read from '../src/services/backing/read';
import * as sync from '../src/services/backing/sync';
import { GRANULAR_SCOPES, SEMBLE_SCOPES } from '../src/config/scopes';

// Route-level coverage for /api/saved/backing (enable/disable/exportBatch) and the
// backing-aware branches of POST/DELETE /api/saved. The pure service logic is
// covered in backing-{enable,sync,write}.spec; these pin the HTTP contract: scope
// gating, validation, and which branch each request takes.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:savedbacking';
const SESSION = 'sess-saved-backing';
const COLLECTION = `at://${DID}/network.cosmik.collection/col1`;
// Granular saves scopes + the Semble integration scopes (enable requires both halves).
const FULL_SCOPES = `${GRANULAR_SCOPES} ${SEMBLE_SCOPES.join(' ')}`;

async function setupUser(grantedScopes: string) {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'sb.bsky.social', 'https://pds.test', 'free', unixepoch())
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'sb.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
    .run();
}

async function reset(grantedScopes = FULL_SCOPES) {
  // Delete child rows before users (FK order).
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM backed_collection_members WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM backed_unsave_tombstones WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await setupUser(grantedScopes);
}

function post(path: string, body: unknown, method = 'POST') {
  return new IncomingRequest(`http://localhost${path}`, {
    method,
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function setBackingRow(value: string) {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_did, backing) VALUES (?, ?)
     ON CONFLICT(user_did) DO UPDATE SET backing = excluded.backing`
  )
    .bind(DID, value)
    .run();
}

describe('POST /api/saved/backing — enable validation + scope gating', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('rejects enable with a 403 scope_upgrade_required when integration scopes are missing', async () => {
    await reset(GRANULAR_SCOPES); // saves scopes only, no Semble repo scopes
    const { status, body } = await call(
      post('/api/saved/backing', { action: 'enable', provider: 'semble' })
    );
    expect(status).toBe(403);
    expect(body.error).toBe('scope_upgrade_required');
    expect(body.integration).toBe('semble');
  });

  it('rejects an unknown provider with 400', async () => {
    const { status } = await call(
      post('/api/saved/backing', { action: 'enable', provider: 'notreal' })
    );
    expect(status).toBe(400);
  });

  it('rejects a non-at:// collectionUri with 400', async () => {
    const { status, body } = await call(
      post('/api/saved/backing', {
        action: 'enable',
        provider: 'semble',
        collectionUri: 'https://not-an-at-uri',
      })
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/at:\/\//);
  });

  it('enables backing against a given collection and persists the setting', async () => {
    // Empty, complete snapshot so the backfill poll is a clean no-op (no network).
    vi.spyOn(read, 'snapshotBackedCollection').mockResolvedValue({
      complete: true,
      members: [],
      skipped: [],
      typeMix: {},
    });
    const { status, body } = await call(
      post('/api/saved/backing', {
        action: 'enable',
        provider: 'semble',
        collectionUri: COLLECTION,
      })
    );
    expect(status).toBe(200);
    expect(body.backing).toEqual({ provider: 'semble', collectionUri: COLLECTION });
    const row = await env.DB.prepare('SELECT backing FROM user_settings WHERE user_did = ?')
      .bind(DID)
      .first<{ backing: string }>();
    expect(row?.backing).toBe(`semble:${COLLECTION}`);
  });

  it('rejects an unknown action with 400', async () => {
    const { status } = await call(post('/api/saved/backing', { action: 'frobnicate' }));
    expect(status).toBe(400);
  });
});

describe('POST /api/saved/backing — disable + exportBatch', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('disable reverts to skyreader and clears the local snapshot', async () => {
    await setBackingRow(`semble:${COLLECTION}`);
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri)
       VALUES (?, ?, 'https://a.test/x', 'https://a.test/x', 'semble', 'at://card/1', 'at://link/1')`
    )
      .bind(DID, COLLECTION)
      .run();

    const { status, body } = await call(post('/api/saved/backing', { action: 'disable' }));
    expect(status).toBe(200);
    expect(body.backing).toEqual({ provider: 'skyreader' });
    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(0);
  });

  it('exportBatch returns 409 when backing is not enabled', async () => {
    const { status, body } = await call(
      post('/api/saved/backing', { action: 'exportBatch', offset: 0, limit: 25 })
    );
    expect(status).toBe(409);
    expect(body.error).toMatch(/not enabled/i);
  });

  it('exportBatch clamps an over-max limit, advances by scanned, and reports total', async () => {
    await setBackingRow(`semble:${COLLECTION}`);
    // 3 native saves to export; createMember is mocked so no real PDS writes.
    let n = 0;
    const createMember = vi.spyOn(write, 'createMember').mockImplementation(async () => {
      n++;
      return {
        itemUri: `at://${DID}/network.cosmik.card/c${n}`,
        linkUri: `at://${DID}/network.cosmik.collectionLink/l${n}`,
      };
    });
    for (const [rkey, url] of [
      ['rk1', 'https://a.test/1'],
      ['rk2', 'https://b.test/2'],
      ['rk3', 'https://c.test/3'],
    ]) {
      await env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, url, source, saved_at, created_at)
         VALUES (?, ?, ?, 'url', 100, 100)`
      )
        .bind(DID, rkey, url)
        .run();
    }

    const { status, body } = await call(
      post('/api/saved/backing', { action: 'exportBatch', offset: 0, limit: 9999 })
    );
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.scanned).toBe(3); // clamped to MAX_LIMIT (50) ≥ 3, so all scanned
    expect(body.exported).toBe(3);
    expect(createMember).toHaveBeenCalledTimes(3);
  });
});

describe('POST /api/saved — backed save routing', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('routes to the backed path: creates a member, writes a NULL-record_uri enrichment row', async () => {
    await setBackingRow(`semble:${COLLECTION}`);
    const createMember = vi.spyOn(write, 'createMember').mockResolvedValue({
      itemUri: `at://${DID}/network.cosmik.card/c1`,
      linkUri: `at://${DID}/network.cosmik.collectionLink/l1`,
    });

    const { status, body } = await call(
      post('/api/saved', {
        url: 'https://a.test/post',
        rkey: '3kabcde123456',
        source: 'url',
        title: 'Post',
      })
    );
    expect(status).toBe(200);
    expect(createMember).toHaveBeenCalledTimes(1);
    expect(body.uri).toBe(`at://${DID}/network.cosmik.card/c1`); // foreign item uri surfaced

    const member = await env.DB.prepare(
      'SELECT external_item_uri FROM backed_collection_members WHERE user_did = ? AND url_normalized = ?'
    )
      .bind(DID, 'https://a.test/post')
      .first<{ external_item_uri: string }>();
    expect(member?.external_item_uri).toBe(`at://${DID}/network.cosmik.card/c1`);

    const enrich = await env.DB.prepare(
      'SELECT record_uri, url_normalized FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ record_uri: string | null; url_normalized: string }>();
    expect(enrich?.record_uri).toBeNull(); // backed save has no app.skyreader.feed.saved export
    expect(enrich?.url_normalized).toBe('https://a.test/post');
  });

  it('idempotency: a raw-different but normalize-equal save REUSES existing handles (no second card)', async () => {
    await setBackingRow(`semble:${COLLECTION}`);
    // Pre-seed a member keyed on the normalized url, as a prior save / poll would.
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri)
       VALUES (?, ?, 'https://a.test/post', 'https://a.test/post', 'semble', 'at://existing/card', 'at://existing/link')`
    )
      .bind(DID, COLLECTION)
      .run();
    const createMember = vi.spyOn(write, 'createMember').mockResolvedValue({
      itemUri: 'at://should/not/be/used',
      linkUri: 'at://should/not/be/used',
    });

    // Save the SAME article with a tracking param (raw-different, normalizes the same).
    const { status, body } = await call(
      post('/api/saved', {
        url: 'https://a.test/post?utm_source=newsletter',
        rkey: '3kxyz98765432',
        source: 'url',
      })
    );
    expect(status).toBe(200);
    expect(createMember).not.toHaveBeenCalled(); // reused, no orphan card written
    expect(body.uri).toBe('at://existing/card');
    // membership row keeps the original handles
    const member = await env.DB.prepare(
      'SELECT external_item_uri, external_link_uri FROM backed_collection_members WHERE user_did = ? AND url_normalized = ?'
    )
      .bind(DID, 'https://a.test/post')
      .first<{ external_item_uri: string; external_link_uri: string }>();
    expect(member?.external_item_uri).toBe('at://existing/card');
    expect(member?.external_link_uri).toBe('at://existing/link');
  });
});

describe('DELETE /api/saved/:rkey — backed unsave branch', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('deletes enrichment, leaves the collection (membership delete + tombstone), fires foreign delete', async () => {
    await setBackingRow(`semble:${COLLECTION}`);
    const removeMember = vi.spyOn(write, 'removeMember').mockResolvedValue(undefined);
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, source, saved_at, created_at)
       VALUES (?, '3kdelete00001', 'https://a.test/x', 'https://a.test/x', 'url', 100, 100)`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri)
       VALUES (?, ?, 'https://a.test/x', 'https://a.test/x', 'semble', 'at://card/1', 'at://link/1')`
    )
      .bind(DID, COLLECTION)
      .run();

    const { status } = await call(post('/api/saved/3kdelete00001', undefined, 'DELETE'));
    expect(status).toBe(200);

    const saved = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(saved?.n).toBe(0); // enrichment row deleted
    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(0); // left the collection
    const tomb = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_unsave_tombstones WHERE user_did = ? AND url_normalized = ?'
    )
      .bind(DID, 'https://a.test/x')
      .first<{ n: number }>();
    expect(tomb?.n).toBe(1); // resurrection guard written
    expect(removeMember).toHaveBeenCalledWith(expect.anything(), 'semble', {
      linkUri: 'at://link/1',
    });
  });
});

describe('GET /api/saved — backed list path', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('serves membership ⋈ enrichment when backing is on, and tolerates a failed poll', async () => {
    await setBackingRow(`semble:${COLLECTION}`);
    // Poll fails (incomplete) — the GET must still serve the last good membership.
    vi.spyOn(read, 'snapshotBackedCollection').mockResolvedValue({
      complete: false,
      members: [],
      skipped: [],
      typeMix: {},
    });
    vi.spyOn(sync, 'extractMissingBackedContent').mockResolvedValue(0);
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, title, content, source, saved_at, created_at)
       VALUES (?, '3klist0000001', 'https://a.test/x', 'https://a.test/x', 'A', 'BODY', 'url', 200, 200)`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri)
       VALUES (?, ?, 'https://a.test/x', 'https://a.test/x', 'semble', 'at://card/1', 'at://link/1')`
    )
      .bind(DID, COLLECTION)
      .run();

    const req = new IncomingRequest('http://localhost/api/saved', {
      method: 'GET',
      headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
    });
    const { status, body } = await call(req);
    expect(status).toBe(200);
    expect(body.articles).toHaveLength(1);
    // The list is metadata-only now — the body is hydrated separately via
    // /api/saved/bodies, so it must NOT ride along in the snapshot.
    expect(body.articles[0]).toMatchObject({ title: 'A' });
    expect('content' in body.articles[0]).toBe(false);
  });
});
