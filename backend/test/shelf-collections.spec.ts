import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:shelf123';
const OTHER_DID = 'did:plc:shelfother';
const TEST_SESSION_ID = 'test-session-shelf';

const C1 = '3kshelfcoll001';
const C2 = '3kshelfcoll002';
const R1 = '3ksavedrkey001';
const R2 = '3ksavedrkey002';
const R3 = '3ksavedrkey003';

async function setupTestUser() {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(TEST_DID, 'shelf.bsky.social', 'https://test.pds.example')
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_SESSION_ID,
      TEST_DID,
      'shelf.bsky.social',
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000
    )
    .run();
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Origin: env.FRONTEND_URL };
  if (opts.auth !== false) headers.Cookie = `session_id=${TEST_SESSION_ID}`;
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

async function list() {
  const { status, body } = await call('GET', '/api/shelf/collections');
  expect(status).toBe(200);
  return body.collections as Array<{
    id: string;
    name: string;
    description: string | null;
    items: Array<{ rkey: string }>;
  }>;
}

describe('/api/shelf/collections', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM shelf_collection_items').run();
    await env.DB.prepare('DELETE FROM shelf_collections').run();
    await env.DB.prepare('DELETE FROM saved_articles').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  it('requires a session', async () => {
    const { status } = await call('GET', '/api/shelf/collections', undefined, { auth: false });
    expect(status).toBe(401);
  });

  it('creates collections idempotently on the client id, in creation order', async () => {
    expect(
      (await call('POST', '/api/shelf/collections', { id: C1, name: '  Books  ' })).status
    ).toBe(200);
    expect(
      (await call('POST', '/api/shelf/collections', { id: C2, name: 'Papers', description: 'ML' }))
        .status
    ).toBe(200);
    // A replayed create neither fails nor duplicates nor renames.
    expect((await call('POST', '/api/shelf/collections', { id: C1, name: 'Other' })).status).toBe(
      200
    );

    const collections = await list();
    expect(collections.map((c) => [c.id, c.name, c.description])).toEqual([
      [C1, 'Books', null],
      [C2, 'Papers', 'ML'],
    ]);
  });

  it('validates names and ids', async () => {
    expect((await call('POST', '/api/shelf/collections', { id: C1, name: '   ' })).status).toBe(
      400
    );
    expect((await call('POST', '/api/shelf/collections', { id: 'bad', name: 'x' })).status).toBe(
      400
    );
    expect(
      (await call('POST', '/api/shelf/collections', { id: C1, name: 'x'.repeat(101) })).status
    ).toBe(400);
  });

  it('renames, describes and clears a description', async () => {
    await call('POST', '/api/shelf/collections', { id: C1, name: 'Books' });
    expect(
      (
        await call('PATCH', `/api/shelf/collections/${C1}`, {
          name: 'Novels',
          description: 'Fiction',
        })
      ).status
    ).toBe(200);
    expect((await list())[0]).toMatchObject({ name: 'Novels', description: 'Fiction' });

    await call('PATCH', `/api/shelf/collections/${C1}`, { description: null });
    expect((await list())[0].description).toBeNull();

    expect((await call('PATCH', `/api/shelf/collections/${C2}`, { name: 'x' })).status).toBe(404);
  });

  it('adds members idempotently, in order, and removes them', async () => {
    await call('POST', '/api/shelf/collections', { id: C1, name: 'Books' });
    for (const rkey of [R1, R2, R3, R1]) {
      expect((await call('POST', `/api/shelf/collections/${C1}/items`, { rkey })).status).toBe(200);
    }
    expect((await list())[0].items.map((i) => i.rkey)).toEqual([R1, R2, R3]);

    expect((await call('DELETE', `/api/shelf/collections/${C1}/items/${R2}`)).status).toBe(200);
    expect((await list())[0].items.map((i) => i.rkey)).toEqual([R1, R3]);
  });

  it('refuses members for a collection that does not exist', async () => {
    expect((await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: R1 })).status).toBe(
      404
    );
  });

  it('reorders, keeping unnamed members after the named ones and ignoring strangers', async () => {
    await call('POST', '/api/shelf/collections', { id: C1, name: 'Books' });
    for (const rkey of [R1, R2, R3]) {
      await call('POST', `/api/shelf/collections/${C1}/items`, { rkey });
    }
    const unknown = '3kunknownrkey9';
    expect(
      (await call('PUT', `/api/shelf/collections/${C1}/items`, { rkeys: [R3, unknown, R1] })).status
    ).toBe(200);
    expect((await list())[0].items.map((i) => i.rkey)).toEqual([R3, R1, R2]);
  });

  it('reorders a collection at the item cap', async () => {
    await call('POST', '/api/shelf/collections', { id: C1, name: 'Books' });
    const rkeys = Array.from({ length: 2000 }, (_, i) => `3kbulkrkey${String(i).padStart(4, '0')}`);
    // Seed directly: 2000 POSTs would be slow, and the add path isn't under test.
    await env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
       SELECT ?, ?, value, key, 0 FROM json_each(?)`
    )
      .bind(TEST_DID, C1, JSON.stringify(rkeys))
      .run();
    const reversed = [...rkeys].reverse();
    // The local runtime doesn't enforce D1's 1,000 queries per invocation, so
    // count them: one statement per member is what broke this in production.
    const prepare = vi.spyOn(env.DB, 'prepare');
    expect(
      (await call('PUT', `/api/shelf/collections/${C1}/items`, { rkeys: reversed })).status
    ).toBe(200);
    expect(prepare.mock.calls.length).toBeLessThan(20);
    prepare.mockRestore();
    expect((await list())[0].items.map((i) => i.rkey)).toEqual(reversed);
  });

  it('deletes a collection with its memberships', async () => {
    await call('POST', '/api/shelf/collections', { id: C1, name: 'Books' });
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: R1 });
    expect((await call('DELETE', `/api/shelf/collections/${C1}`)).status).toBe(200);
    expect(await list()).toEqual([]);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM shelf_collection_items').first<{
      n: number;
    }>();
    expect(row?.n).toBe(0);
  });

  it("never shows or touches another reader's collections", async () => {
    await env.DB.prepare(
      `INSERT INTO shelf_collections (user_did, id, name, position, created_at, updated_at)
       VALUES (?, ?, 'Theirs', 0, 1, 1)`
    )
      .bind(OTHER_DID, C1)
      .run();
    expect(await list()).toEqual([]);
    expect((await call('PATCH', `/api/shelf/collections/${C1}`, { name: 'Mine' })).status).toBe(
      404
    );
    expect((await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: R1 })).status).toBe(
      404
    );
  });

  it('drops a save from its collections when the save is deleted', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, title, saved_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'A', 1, 1)`
    )
      .bind(
        TEST_DID,
        R1,
        `at://${TEST_DID}/app.skyreader.feed.saved/${R1}`,
        'https://example.com/a',
        'example.com/a'
      )
      .run();
    await call('POST', '/api/shelf/collections', { id: C1, name: 'Books' });
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: R1 });
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: R2 });

    expect((await call('DELETE', `/api/saved/${R1}`)).status).toBe(200);
    expect((await list())[0].items.map((i) => i.rkey)).toEqual([R2]);
  });
});
