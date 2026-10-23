import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { applySembleConnectionCommit } from '../src/services/semble-connections';
import { GRANULAR_SCOPES } from '../src/config/scopes';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:conn123';
const CURATOR = 'did:plc:curator1';
const TEST_SESSION_ID = 'test-session-connections';

const R1 = '3ksavedconn001';
const R2 = '3ksavedconn002';
const URL1 = 'https://example.com/essay';
const URL2 = 'https://example.org/paper';

async function setupTestUser() {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(TEST_DID, 'conn.bsky.social', 'https://test.pds.example')
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_SESSION_ID,
      TEST_DID,
      'conn.bsky.social',
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000,
      GRANULAR_SCOPES
    )
    .run();
}

async function save(rkey: string, url: string, savedAt: number) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, url, url_key, saved_at) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(TEST_DID, rkey, url, url, savedAt)
    .run();
}

function connect(
  rkey: string,
  source: string,
  target: string,
  opts: { did?: string; now?: number; note?: string } = {}
) {
  return applySembleConnectionCommit(
    env,
    opts.did ?? CURATOR,
    {
      operation: 'create',
      rkey,
      record: {
        source,
        target,
        connectionType: 'RELATED',
        note: opts.note,
        createdAt: '2026-10-01T00:00:00Z',
      },
    },
    opts.now
  );
}

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    Origin: env.FRONTEND_URL,
    Cookie: `session_id=${TEST_SESSION_ID}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function activity() {
  const { status, body } = await call('GET', '/api/saved/connections');
  expect(status).toBe(200);
  return body.items as Array<{
    rkey: string;
    unseen: number;
    latestAt: number;
    seenAt: number | null;
    newest: Array<{ uri: string; direction: string; otherUrl: string; note: string | null }>;
  }>;
}

describe('Semble connections off saves', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM semble_connections').run();
    await env.DB.prepare('DELETE FROM semble_connection_seen').run();
    await env.DB.prepare('DELETE FROM saved_articles').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  it('keeps an edge only when one of its ends is saved', async () => {
    await save(R1, URL1, 1000);
    expect(await connect('3kconnrec00001', 'https://elsewhere.net/a', URL1, { now: 2000 })).toBe(
      true
    );
    expect(
      await connect('3kconnrec00002', 'https://elsewhere.net/a', 'https://elsewhere.net/b')
    ).toBe(false);
    // A card AT URI isn't a URL anyone saved.
    expect(await connect('3kconnrec00003', 'at://did:plc:x/network.cosmik.card/abc', URL1)).toBe(
      false
    );
    const { results } = await env.DB.prepare('SELECT uri FROM semble_connections').all();
    expect(results).toHaveLength(1);
  });

  it('matches on the normalized URL', async () => {
    await save(R1, URL1, 1000);
    expect(
      await connect('3kconnrec00001', `${URL1}/?utm_source=x#top`, 'https://elsewhere.net/a', {
        now: 2000,
      })
    ).toBe(true);
    expect(await activity()).toMatchObject([{ rkey: R1, unseen: 1, latestAt: 2000, seenAt: null }]);
  });

  it('counts other people’s edges since the save, then since the last look', async () => {
    await save(R1, URL1, 1000);
    await save(R2, URL2, 1000);
    await connect('3kconnrec00001', URL1, 'https://elsewhere.net/a', { now: 2000 });
    await connect('3kconnrec00002', 'https://elsewhere.net/b', URL1, { now: 3000 });
    // The reader's own connection is not news to them.
    await connect('3kconnrec00003', URL2, 'https://elsewhere.net/c', { did: TEST_DID, now: 2500 });

    expect(await activity()).toMatchObject([{ rkey: R1, unseen: 2, latestAt: 3000, seenAt: null }]);

    const seen = await call('POST', '/api/saved/connections/seen', { rkey: R1 });
    expect(seen).toEqual({ status: 200, body: { success: true } });
    const [after] = await activity();
    expect(after.unseen).toBe(0);
    expect(after.seenAt).toBeGreaterThan(3000);

    await connect('3kconnrec00004', URL1, 'https://elsewhere.net/d', {
      now: Date.now() + 1000,
    });
    expect((await activity())[0].unseen).toBe(1);
  });

  it('describes the unseen connections, newest first', async () => {
    await save(R1, URL1, 1000);
    await connect('3kconnrec00001', URL1, 'https://elsewhere.net/a', { now: 2000 });
    await connect('3kconnrec00002', 'https://elsewhere.net/b', URL1, {
      now: 3000,
      note: 'A reply to it',
    });
    const [item] = await activity();
    expect(item.newest).toEqual([
      {
        uri: `at://${CURATOR}/network.cosmik.connection/3kconnrec00002`,
        curatorDid: CURATOR,
        direction: 'in',
        otherUrl: 'https://elsewhere.net/b',
        type: 'RELATED',
        note: 'A reply to it',
        indexedAt: 3000,
        liked: false,
      },
      {
        uri: `at://${CURATOR}/network.cosmik.connection/3kconnrec00001`,
        curatorDid: CURATOR,
        direction: 'out',
        otherUrl: 'https://elsewhere.net/a',
        type: 'RELATED',
        note: null,
        indexedAt: 2000,
        liked: false,
      },
    ]);

    // At most three per save, the newest.
    await connect('3kconnrec00003', URL1, 'https://elsewhere.net/c', { now: 4000 });
    await connect('3kconnrec00004', URL1, 'https://elsewhere.net/d', { now: 5000 });
    const [busy] = await activity();
    expect(busy.unseen).toBe(4);
    expect(busy.newest.map((c) => c.otherUrl)).toEqual([
      'https://elsewhere.net/d',
      'https://elsewhere.net/c',
      'https://elsewhere.net/b',
    ]);

    // Once looked at, nothing is new to describe.
    await call('POST', '/api/saved/connections/seen', { rkey: R1 });
    expect((await activity())[0].newest).toEqual([]);
  });

  it('an edge older than the save is not new', async () => {
    await save(R1, URL1, 5000);
    await connect('3kconnrec00001', URL1, 'https://elsewhere.net/a', { now: 2000 });
    expect((await activity())[0]).toMatchObject({ rkey: R1, unseen: 0 });
  });

  it('an edit keeps its first indexed time; a delete removes it', async () => {
    await save(R1, URL1, 1000);
    await connect('3kconnrec00001', URL1, 'https://elsewhere.net/a', { now: 2000 });
    await connect('3kconnrec00001', URL1, 'https://elsewhere.net/a', {
      now: 9000,
      note: 'edited',
    });
    const row = await env.DB.prepare('SELECT note, indexed_at FROM semble_connections').first();
    expect(row).toEqual({ note: 'edited', indexed_at: 2000 });

    await applySembleConnectionCommit(env, CURATOR, {
      operation: 'delete',
      rkey: '3kconnrec00001',
    });
    expect(await activity()).toEqual([]);
  });

  it('matches a save made through the API, with no Semble backing', async () => {
    const saved = await call('POST', '/api/saved', {
      url: `${URL1}?utm_source=feed`,
      rkey: R1,
      source: 'url',
      title: 'Essay',
      content: '<p>Body</p>',
    });
    expect(saved.status).toBe(200);
    expect(await connect('3kconnrec00001', 'https://elsewhere.net/a', URL1)).toBe(true);
    expect((await activity()).map((a) => a.rkey)).toEqual([R1]);
  });

  it('backfills older saves before listing, so their edges can match', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, saved_at) VALUES (?, ?, ?, ?), (?, ?, '', ?)`
    )
      .bind(TEST_DID, R1, `${URL1}#top`, 1000, TEST_DID, R2, 1000)
      .run();
    // Nothing to match yet: the ingest only sees keyed saves.
    expect(await connect('3kconnrec00001', URL1, 'https://elsewhere.net/a')).toBe(false);

    expect(await activity()).toEqual([]);
    const keys = await env.DB.prepare(
      'SELECT rkey, url_key FROM saved_articles WHERE user_did = ? ORDER BY rkey'
    )
      .bind(TEST_DID)
      .all();
    expect(keys.results).toEqual([
      { rkey: R1, url_key: URL1 },
      { rkey: R2, url_key: '' },
    ]);
    expect(await connect('3kconnrec00002', URL1, 'https://elsewhere.net/b')).toBe(true);
  });

  it('drops an edge an edit moved off every saved URL', async () => {
    await save(R1, URL1, 1000);
    await connect('3kconnrec00001', URL1, 'https://elsewhere.net/a', { now: 2000 });
    await applySembleConnectionCommit(env, CURATOR, {
      operation: 'update',
      rkey: '3kconnrec00001',
      record: { source: 'https://elsewhere.net/b', target: 'https://elsewhere.net/a' },
    });
    expect(await activity()).toEqual([]);
  });

  it('requires a session', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new IncomingRequest('http://localhost/api/saved/connections', {
        headers: { Origin: env.FRONTEND_URL },
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('validates the seen request', async () => {
    expect((await call('POST', '/api/saved/connections/seen', { rkey: 'nope' })).status).toBe(400);
    expect((await call('POST', '/api/saved/connections/seen', { rkey: R1 })).body).toEqual({
      success: false,
    });
  });
});
