import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { runZoteroSync, zoteroItem, zoteroNote } from '../src/services/zotero';
import { openSecret, sealSecret } from '../src/utils/secret-box';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// ─── A small Zotero library, behind fetch ──────────────────────────────────────

interface FakeObject {
  key: string;
  version: number;
  data: Record<string, unknown>;
}

function fakeZotero() {
  const items = new Map<string, FakeObject>();
  const collections = new Map<string, FakeObject>();
  const calls: string[] = [];
  // Item writes to fail with a 503, by their order (1 = the first write).
  const failWrites = new Set<number>();
  let itemWrites = 0;
  let seq = 0;
  let version = 0;
  const key = () => `K${String(++seq).padStart(7, '0')}`;
  const store = (map: Map<string, FakeObject>, data: Record<string, unknown>) => {
    const object = { key: key(), version: ++version, data };
    map.set(object.key, object);
    return object;
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    const headers = new Headers(init?.headers);
    if (headers.get('Zotero-API-Key') !== 'GOODKEY0123456789abcd') {
      return new Response('Forbidden', { status: 403 });
    }
    if (url.pathname === '/keys/current') {
      return Response.json({
        userID: 4242,
        username: 'reader',
        access: { user: { library: true, write: true } },
      });
    }
    const path = url.pathname.replace('/users/4242', '');
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (method === 'POST' && path === '/items' && failWrites.has(++itemWrites)) {
      return new Response('Busy', { status: 503 });
    }
    if (method === 'POST' && (path === '/items' || path === '/collections')) {
      const map = path === '/items' ? items : collections;
      const successful: Record<string, { key: string; version: number }> = {};
      const failed: Record<string, { code: number; message: string }> = {};
      (body as Record<string, unknown>[]).forEach((data, i) => {
        if (data.parentItem && !items.get(data.parentItem as string)) {
          failed[i] = { code: 400, message: 'Parent item not found' };
          return;
        }
        const object = store(map, data);
        successful[i] = { key: object.key, version: object.version };
      });
      return Response.json({ successful, failed });
    }
    if (path === '/items/top') {
      const q = url.searchParams.get('q')!.toLowerCase();
      return Response.json(
        [...items.values()].filter(
          (o) => !o.data.parentItem && String(o.data.DOI ?? '').toLowerCase() === q
        )
      );
    }
    const one = /^\/items\/(\w+)$/.exec(path);
    if (one) {
      const object = items.get(one[1]);
      if (!object) return new Response('Not found', { status: 404 });
      if (method === 'PATCH') {
        const expected = headers.get('If-Unmodified-Since-Version');
        if (expected && Number(expected) !== object.version) {
          return new Response('Precondition failed', { status: 412 });
        }
        Object.assign(object.data, body);
        object.version = ++version;
        return new Response(null, {
          status: 204,
          headers: { 'Last-Modified-Version': String(object.version) },
        });
      }
      return Response.json(object, {
        headers: { 'Last-Modified-Version': String(object.version) },
      });
    }
    return new Response('Unexpected', { status: 500 });
  };
  return { items, collections, calls, handler, store, failWrites };
}

// ─── D1 helpers ─────────────────────────────────────────────────────────────────

let userSeq = 0;

async function createUser(tier: 'free' | 'supporter' = 'supporter') {
  userSeq++;
  const did = `did:plc:zotero${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `zotero-session-${did}`;
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(did, `${did}.test`, 'https://test.pds.example', tier)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, 'a', 'r', ?, ?)`
  )
    .bind(
      sessionId,
      did,
      `${did}.test`,
      'https://test.pds.example',
      '{"kty":"EC"}',
      Date.now() + 3600000
    )
    .run();
  return { did, sessionId };
}

type User = Awaited<ReturnType<typeof createUser>>;

async function save(
  user: User,
  rkey: string,
  title: string,
  opts: { itemGuid?: string; doi?: string; url?: string } = {}
) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, saved_at, created_at, source, item_guid, doi, author, published_at)
     VALUES (?, ?, ?, ?, ?, 1700000000000, 1700000000000, ?, ?, ?, 'Jane Doe', 1600000000000)`
  )
    .bind(
      user.did,
      rkey,
      `at://${user.did}/app.skyreader.feed.saved/${rkey}`,
      opts.url ?? `https://blog.example/${rkey}`,
      title,
      opts.itemGuid ? 'feed' : 'url',
      opts.itemGuid ?? null,
      opts.doi ?? null
    )
    .run();
}

let labelSeq = 0;
async function highlights(user: User, itemKey: string, texts: string[]) {
  labelSeq++;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
     VALUES (?, ?, 'article', 'highlights', ?, ?, ?, ?, ?)
     ON CONFLICT (user_did, item_key, label) DO UPDATE SET props = excluded.props, updated_at = excluded.updated_at`
  )
    .bind(
      user.did,
      itemKey,
      JSON.stringify({
        highlights: texts.map((exact, i) => ({
          id: `h${i}`,
          selector: { type: 'TextQuoteSelector', exact },
          createdAt: 10 + i,
        })),
      }),
      `zl${labelSeq}`,
      now,
      now,
      now * 1000
    )
    .run();
}

async function call(user: User, method: string, path = '/api/zotero', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, {
      method,
      headers: {
        Cookie: `session_id=${user.sessionId}`,
        Origin: env.FRONTEND_URL,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

// Let a sync run again straight away, as the cron would after its interval.
async function resync(user: User) {
  await env.DB.prepare('UPDATE zotero_connections SET last_sync_at = NULL WHERE user_did = ?')
    .bind(user.did)
    .run();
  expect(await runZoteroSync(env, user.did)).not.toBeNull();
}

let zotero: ReturnType<typeof fakeZotero>;
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  zotero = fakeZotero();
  originalFetch = globalThis.fetch;
  globalThis.fetch = zotero.handler as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Zotero items and notes', () => {
  it('picks an item type with only its own fields', () => {
    const base = { kind: 'save' as const, title: 'T', url: 'https://x.example/a', highlights: [] };
    expect(
      zoteroItem({ ...base, arxivId: '1706.03762', doi: '10.48550/arXiv.1706.03762' }, 'C')
    ).toMatchObject({ itemType: 'preprint', archiveID: 'arXiv:1706.03762', collections: ['C'] });
    expect(zoteroItem({ ...base, doi: '10.1/x' }, null)).toMatchObject({
      itemType: 'journalArticle',
      DOI: '10.1/x',
    });
    expect(zoteroItem(base, null)).toMatchObject({
      itemType: 'webpage',
      websiteTitle: 'x.example',
    });
    expect(
      zoteroItem({ kind: 'save', filename: 'book.epub', contentType: 'epub', highlights: [] }, null)
    ).toMatchObject({ itemType: 'book', title: 'book.epub', extra: 'Original file: book.epub' });
    expect(zoteroItem({ ...base, author: 'Doe, Jane; Ada Lovelace' }, null).creators).toEqual([
      { creatorType: 'author', lastName: 'Doe', firstName: 'Jane' },
      { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
    ]);
  });

  it('escapes the note', () => {
    const html = zoteroNote({
      kind: 'save',
      highlights: [{ text: '<script>x</script>', note: 'a & b' }],
    });
    expect(html).toContain('<blockquote><p>&lt;script&gt;x&lt;/script&gt;</p></blockquote>');
    expect(html).toContain('<p><strong>Note:</strong> a &amp; b</p>');
  });
});

describe('/api/zotero', () => {
  it('is for Supporters, and checks the key with Zotero', async () => {
    const free = await createUser('free');
    expect(
      (await call(free, 'POST', '/api/zotero', { apiKey: 'GOODKEY0123456789abcd' })).status
    ).toBe(403);
    const user = await createUser();
    expect((await call(user, 'POST', '/api/zotero', { apiKey: 'nope' })).status).toBe(400);
    const wrong = await call(user, 'POST', '/api/zotero', { apiKey: 'BADKEY0123456789abcde' });
    expect(wrong.status).toBe(400);
    expect(await (await call(user, 'GET')).json()).toEqual({ connected: false });
  });

  it('syncs every save and highlighted page into a Skyreader collection, then keeps notes current', async () => {
    const user = await createUser();
    await save(user, '3mwhuiodre72s', 'A blog post', { itemGuid: 'guid-1' });
    await save(user, '3mwhuiodre73s', 'A paper', { doi: '10.1234/abc' });
    await highlights(user, 'guid-1', ['first quote']);
    await highlights(user, 'https://unsaved.example/x', ['unsaved quote']);
    // The paper is already in the reader's library: it gets the note, not a twin.
    const existing = zotero.store(zotero.items, { itemType: 'journalArticle', DOI: '10.1234/ABC' });

    const connected = await call(user, 'POST', '/api/zotero', { apiKey: 'GOODKEY0123456789abcd' });
    expect(connected.status).toBe(201);
    const status = (await (await call(user, 'GET')).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ connected: true, username: 'reader', scope: 'everything' });
    expect(status).not.toHaveProperty('apiKey');
    expect(status.lastError).toBeNull();

    expect([...zotero.collections.values()].map((c) => c.data.name)).toEqual(['Skyreader']);
    const [collectionKey] = zotero.collections.keys();
    const tops = [...zotero.items.values()].filter((o) => o.data.itemType !== 'note');
    expect(tops.map((o) => [o.data.itemType, o.data.title ?? null])).toEqual([
      ['journalArticle', null],
      ['webpage', 'A blog post'],
      ['webpage', 'unsaved.example'],
    ]);
    expect(tops[1].data).toMatchObject({
      collections: [collectionKey],
      url: 'https://blog.example/3mwhuiodre72s',
      accessDate: '2023-11-14',
      date: '2020-09-13',
      creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
    });
    const notes = [...zotero.items.values()].filter((o) => o.data.itemType === 'note');
    // The paper has no highlights: no note for it.
    expect(notes.map((n) => n.data.parentItem)).toEqual([tops[1].key, tops[2].key]);
    expect(notes[0].data.note).toContain('first quote');
    expect(notes.some((n) => n.data.parentItem === existing.key)).toBe(false);

    // Nothing changed: nothing written.
    zotero.calls.length = 0;
    await resync(user);
    expect(zotero.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);

    // A new highlight rewrites the note in place, even after an edit in Zotero.
    notes[0].version += 5;
    await highlights(user, 'guid-1', ['first quote', 'second quote']);
    await highlights(user, 'saved:3mwhuiodre73s', ['paper quote']);
    await resync(user);
    expect(notes[0].data.note).toContain('second quote');
    const paperNote = [...zotero.items.values()].find((o) => o.data.parentItem === existing.key);
    expect(paperNote?.data.note).toContain('paper quote');
    expect([...zotero.items.values()].filter((o) => o.data.itemType !== 'note')).toHaveLength(3);
  });

  it('with collections: only their saves; and a deleted item stays deleted', async () => {
    const user = await createUser();
    await save(user, '3mwhuiodre74s', 'In Thesis');
    await save(user, '3mwhuiodre75s', 'Elsewhere');
    await highlights(user, 'saved:3mwhuiodre75s', ['not wanted']);
    await env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
       VALUES (?, 'thesis', '3mwhuiodre74s', 1, unixepoch())`
    )
      .bind(user.did)
      .run();
    await call(user, 'POST', '/api/zotero', { apiKey: 'GOODKEY0123456789abcd' });
    const scoped = await call(user, 'PATCH', '/api/zotero', {
      scope: 'collections',
      collections: ['thesis'],
    });
    expect(await scoped.json()).toMatchObject({ scope: 'collections', collections: ['thesis'] });
    await resync(user);
    const titles = () =>
      [...zotero.items.values()].filter((o) => o.data.itemType !== 'note').map((o) => o.data.title);
    // The connect-time sync ran with everything; switching scope kept those
    // items and added nothing twice.
    expect(titles().filter((t) => t === 'In Thesis')).toHaveLength(1);

    // The reader deletes it in Zotero, then highlights it: it isn't made again.
    const [thesisKey] = [...zotero.items.values()].filter((o) => o.data.title === 'In Thesis');
    zotero.items.delete(thesisKey.key);
    await highlights(user, 'saved:3mwhuiodre74s', ['a quote']);
    await resync(user);
    await resync(user);
    expect(titles().filter((t) => t === 'In Thesis')).toHaveLength(0);
    const row = await env.DB.prepare(
      'SELECT dropped FROM zotero_items WHERE user_did = ? AND source_key = ?'
    )
      .bind(user.did, 'saved:3mwhuiodre74s')
      .first<{ dropped: number }>();
    expect(row?.dropped).toBe(1);

    expect((await call(user, 'DELETE')).status).toBe(200);
    expect(await (await call(user, 'GET')).json()).toEqual({ connected: false });
  });

  it('keeps the key sealed in D1, opening only for its own reader and secret', async () => {
    const user = await createUser();
    await call(user, 'POST', '/api/zotero', { apiKey: 'GOODKEY0123456789abcd' });
    const row = await env.DB.prepare(
      'SELECT api_key_sealed FROM zotero_connections WHERE user_did = ?'
    )
      .bind(user.did)
      .first<{ api_key_sealed: string }>();
    expect(row!.api_key_sealed).toMatch(/^v1:/);
    expect(row!.api_key_sealed).not.toContain('GOODKEY');
    const sealed = row!.api_key_sealed;
    expect(await openSecret(env.ZOTERO_KEY_SECRET, user.did, sealed)).toBe('GOODKEY0123456789abcd');
    expect(await openSecret(env.ZOTERO_KEY_SECRET, 'did:plc:someoneelse', sealed)).toBeNull();
    expect(await openSecret('another-secret', user.did, sealed)).toBeNull();
    expect(await openSecret(env.ZOTERO_KEY_SECRET, user.did, 'GOODKEY0123456789abcd')).toBeNull();

    // A key sealed for someone else's row fails closed, asking for a new one.
    await env.DB.prepare('UPDATE zotero_connections SET api_key_sealed = ? WHERE user_did = ?')
      .bind(
        await sealSecret(env.ZOTERO_KEY_SECRET, 'did:plc:someoneelse', 'GOODKEY0123456789abcd'),
        user.did
      )
      .run();
    await resync(user);
    const status = (await (await call(user, 'GET')).json()) as { lastError: string };
    expect(status.lastError).toMatch(/Paste a new one/);

    // Without the secret, connecting is off.
    const secret = env.ZOTERO_KEY_SECRET;
    env.ZOTERO_KEY_SECRET = '';
    try {
      const refused = await call(user, 'POST', '/api/zotero', { apiKey: 'GOODKEY0123456789abcd' });
      expect(refused.status).toBe(503);
    } finally {
      env.ZOTERO_KEY_SECRET = secret;
    }
  });

  it('records a refused key on the connection', async () => {
    const user = await createUser();
    await save(user, '3mwhuiodre76s', 'Something');
    await call(user, 'POST', '/api/zotero', { apiKey: 'GOODKEY0123456789abcd' });
    await env.DB.prepare('UPDATE zotero_connections SET api_key_sealed = ? WHERE user_did = ?')
      .bind(await sealSecret(env.ZOTERO_KEY_SECRET, user.did, 'REVOKED0123456789abcd'), user.did)
      .run();
    await highlights(user, 'saved:3mwhuiodre76s', ['q']);
    await resync(user);
    const status = (await (await call(user, 'GET')).json()) as { lastError: string };
    expect(status.lastError).toMatch(/refused the API key/);
  });

  it('a large library arrives over several syncs, with nothing made twice', async () => {
    const user = await createUser();
    for (let i = 0; i < 45; i++) {
      await save(user, `3mwhuiodre${String(i).padStart(3, '0')}`, `Paper ${i}`, {
        doi: `10.5555/p${i}`,
      });
    }
    // The second item write fails: what the first made is still recorded.
    zotero.failWrites.add(2);
    await call(user, 'POST', '/api/zotero', { apiKey: 'GOODKEY0123456789abcd' });
    for (let i = 0; i < 6; i++) await resync(user);
    const titles = [...zotero.items.values()].map((o) => o.data.title);
    expect(titles).toHaveLength(45);
    expect(new Set(titles).size).toBe(45);
    const status = (await (await call(user, 'GET')).json()) as { lastError: string | null };
    expect(status.lastError).toBeNull();
  });

  it('remakes a note the reader deleted, on the next sync', async () => {
    const user = await createUser();
    await save(user, '3mwhuiodre80s', 'Noted');
    await highlights(user, 'saved:3mwhuiodre80s', ['one']);
    await call(user, 'POST', '/api/zotero', { apiKey: 'GOODKEY0123456789abcd' });
    const note = () => [...zotero.items.values()].find((o) => o.data.itemType === 'note');
    zotero.items.delete(note()!.key);
    await highlights(user, 'saved:3mwhuiodre80s', ['one', 'two']);
    await resync(user);
    await resync(user);
    expect(note()?.data.note).toContain('two');
  });
});
