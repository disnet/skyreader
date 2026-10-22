import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';

// POST /api/saved/import: a library from another read-later app, already parsed
// by the browser. New URLs become saves with their archived state, tags and
// highlights as labels; URLs already saved are skipped but still gain the
// export's highlights; an imported save's text is fetched lazily.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:savedimport';
const SESSION = 'sess-saved-import';

async function reset() {
  for (const table of ['saved_articles', 'item_labels_cache', 'user_settings']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_did = ?`).bind(DID).run();
  }
  await env.DB.prepare('DELETE FROM rate_limits WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'si.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'si.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, GRANULAR_SCOPES)
    .run();
}

function post(path: string, body: unknown) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const importItems = (items: unknown[], source = 'pocket') =>
  call(post('/api/saved/import', { source, items }));

async function saves() {
  return (
    await env.DB.prepare('SELECT * FROM saved_articles WHERE user_did = ? ORDER BY saved_at DESC')
      .bind(DID)
      .all<any>()
  ).results;
}

async function labels(itemKey: string) {
  const rows = (
    await env.DB.prepare(
      'SELECT label, item_type, props FROM item_labels_cache WHERE user_did = ? AND item_key = ? AND deleted_at IS NULL'
    )
      .bind(DID, itemKey)
      .all<{ label: string; item_type: string; props: string }>()
  ).results;
  return Object.fromEntries(rows.map((r) => [r.label, { ...r, props: JSON.parse(r.props) }]));
}

// The proxy is unreachable in tests; anything that tries it gets a refusal.
let originalFetch: typeof fetch;
function stubExtract(content = '<p>The whole article.</p>') {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/extract')) {
      return new Response(JSON.stringify({ content, title: 'Extracted', wordCount: 3 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('POST /api/saved/import', () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await reset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('saves each item with its date, archived state, tags and highlights', async () => {
    stubExtract();
    const savedAt = Date.UTC(2021, 4, 6);
    const { status, body } = await importItems([
      {
        url: 'https://example.com/a',
        title: 'Article A',
        savedAt,
        archived: true,
        tags: ['history', ' history ', 'longreads'],
        highlights: [
          { text: 'A passage worth keeping.', note: 'Remember this', createdAt: savedAt + 1000 },
        ],
      },
      { url: 'https://www.example.org/b', title: 'Article B', savedAt: savedAt + 5000 },
    ]);
    expect(status).toBe(200);
    expect(body).toEqual({ added: 2, duplicates: 0, invalid: 0, highlights: 1 });

    const rows = await saves();
    expect(rows.map((r) => r.url)).toEqual(['https://www.example.org/b', 'https://example.com/a']);
    const a = rows[1];
    expect(a.saved_at).toBe(savedAt);
    expect(a.source).toBe('url');
    expect(a.imported_from).toBe('pocket');
    expect(a.record_uri).toBe(`at://${DID}/app.skyreader.feed.saved/${a.rkey}`);
    expect(a.updated_at).toBeGreaterThan(0);
    expect(rows[0].domain).toBe('example.org');

    const aLabels = await labels(a.record_uri);
    expect(aLabels.archived.item_type).toBe('saved');
    expect(aLabels.archived.props).toEqual({ archivedAt: savedAt });
    expect(aLabels.tagged.props).toEqual({ tags: ['history', 'longreads'] });
    const [h] = aLabels.highlights.props.highlights;
    expect(h).toMatchObject({
      selector: { type: 'TextQuoteSelector', exact: 'A passage worth keeping.' },
      note: 'Remember this',
      createdAt: savedAt + 1000,
      sourceUrl: 'https://example.com/a',
      sourceTitle: 'Article A',
    });
    expect(h.id).toMatch(/^imp[0-9a-f]{24}$/);

    // The unarchived one has no labels.
    expect(await labels(rows[0].record_uri)).toEqual({});
  });

  it('skips URLs already saved, by exact URL or normalized key, and repeats in the batch', async () => {
    await importItems([{ url: 'https://example.com/a?utm_source=x' }]);
    const { body } = await importItems([
      { url: 'https://example.com/a?utm_source=x' },
      { url: 'https://example.com/a' },
      { url: 'https://example.com/c' },
      { url: 'https://example.com/c' },
    ]);
    expect(body).toMatchObject({ added: 1, duplicates: 3 });
    expect((await saves()).map((r) => r.url).sort()).toEqual([
      'https://example.com/a?utm_source=x',
      'https://example.com/c',
    ]);
  });

  it('adds highlights to a save already in the Library, once', async () => {
    await importItems([{ url: 'https://example.com/a', tags: ['keep'] }]);
    const [row] = await saves();
    const item = {
      url: 'https://example.com/a',
      archived: true,
      tags: ['other'],
      highlights: [{ text: 'First passage.' }, { text: 'Second passage.' }],
    };
    expect((await importItems([item])).body).toMatchObject({
      added: 0,
      duplicates: 1,
      highlights: 2,
    });
    // Again: nothing new to add.
    expect((await importItems([item])).body.highlights).toBe(0);

    const l = await labels(row.record_uri);
    expect(l.highlights.props.highlights.map((h: any) => h.selector.exact).sort()).toEqual([
      'First passage.',
      'Second passage.',
    ]);
    // Only highlights: the save keeps its own tags and stays unarchived.
    expect(l.tagged.props.tags).toEqual(['keep']);
    expect(l.archived).toBeUndefined();
  });

  it("doesn't bring back highlights the reader deleted from a save", async () => {
    const item = {
      url: 'https://example.com/a',
      highlights: [{ text: 'Kept.' }, { text: 'Gone.' }],
    };
    await importItems([item]);
    const [row] = await saves();
    const l = await labels(row.record_uri);
    const kept = l.highlights.props.highlights.filter((h: any) => h.selector.exact === 'Kept.');
    await env.DB.prepare(
      `UPDATE item_labels_cache SET props = ? WHERE user_did = ? AND item_key = ? AND label = 'highlights'`
    )
      .bind(JSON.stringify({ highlights: kept }), DID, row.record_uri)
      .run();

    expect((await importItems([item])).body).toMatchObject({ duplicates: 1, highlights: 0 });
    const after = await labels(row.record_uri);
    expect(after.highlights.props.highlights.map((h: any) => h.selector.exact)).toEqual(['Kept.']);
  });

  it('merges two URLs for one article in a batch into one save', async () => {
    const { body } = await importItems([
      { url: 'https://example.com/a?utm_source=x', highlights: [{ text: 'From one.' }] },
      {
        url: 'https://example.com/a',
        tags: ['t'],
        archived: true,
        highlights: [{ text: 'From two.' }],
      },
    ]);
    expect(body).toEqual({ added: 1, duplicates: 1, invalid: 0, highlights: 2 });
    const [row] = await saves();
    const l = await labels(row.record_uri);
    expect(l.highlights.props.highlights).toHaveLength(2);
    expect(l.tagged.props.tags).toEqual(['t']);
    expect(l.archived).toBeDefined();
  });

  it('counts items with no web URL as invalid and drops oversized highlights', async () => {
    const { body } = await importItems([
      { url: 'not a url' },
      { url: 'javascript:alert(1)' },
      { title: 'no url' },
      { url: 'https://example.com/ok', highlights: [{ text: 'x'.repeat(5001) }, { text: '  ' }] },
    ]);
    expect(body).toEqual({ added: 1, duplicates: 0, invalid: 3, highlights: 0 });
  });

  it('dates a save with a missing or impossible date to now', async () => {
    const before = Date.now();
    await importItems([
      { url: 'https://example.com/future', savedAt: Date.now() + 86_400_000 },
      { url: 'https://example.com/ancient', savedAt: 12 },
    ]);
    for (const row of await saves()) expect(row.saved_at).toBeGreaterThanOrEqual(before);
  });

  it("doesn't count imported saves against the monthly URL-save limit", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/${i}` }));
    expect((await importItems(items)).body.added).toBe(100);
    const res = await call(
      post('/api/saved', {
        url: 'https://example.com/fresh',
        rkey: 'aaaaaaaaaaaaa',
        title: 'Fresh',
      })
    );
    expect(res.status).toBe(200);
  });

  it('extracts the newest unread imports in the background, once per import', async () => {
    const mock = stubExtract();
    await importItems([
      { url: 'https://example.com/old', savedAt: Date.UTC(2020, 0, 1) },
      { url: 'https://example.com/archived', archived: true },
    ]);
    const extracted = mock.mock.calls.filter(([u]) =>
      String(u instanceof Request ? u.url : u).endsWith('/extract')
    );
    expect(extracted).toHaveLength(1);
    const old = (await saves()).find((r) => r.url === 'https://example.com/old');
    expect(old.content).toBe('<p>The whole article.</p>');
    expect(
      (await saves()).find((r) => r.url === 'https://example.com/archived').content
    ).toBeNull();

    // A second batch of the same import doesn't fetch again.
    mock.mockClear();
    await importItems([{ url: 'https://example.com/next' }]);
    expect(mock).not.toHaveBeenCalled();
  });

  it('extracts an imported save when it is opened', async () => {
    await env.DB.prepare(
      `INSERT INTO rate_limits (did, endpoint, window_start, count) VALUES (?, '/api/saved/import:extract', ?, 5)`
    )
      .bind(DID, Math.floor(Date.now() / 600000) * 600000)
      .run();
    await importItems([{ url: 'https://example.com/later' }]);
    const [row] = await saves();
    expect(row.content).toBeNull();

    stubExtract('<p>Fetched on open.</p>');
    // Plain hydration never fetches.
    const plain = await call(post('/api/saved/bodies', { rkeys: [row.rkey] }));
    expect(plain.body.bodies[row.rkey]).toBeNull();
    const opened = await call(post('/api/saved/bodies', { rkeys: [row.rkey], extract: true }));
    expect(opened.body.bodies[row.rkey]).toBe('<p>Fetched on open.</p>');
  });

  it('refuses while saves are backed by Semble or Margin', async () => {
    await env.DB.prepare(`INSERT INTO user_settings (user_did, backing) VALUES (?, ?)`)
      .bind(DID, `semble:at://${DID}/network.cosmik.collection/abc`)
      .run();
    const { status, body } = await importItems([{ url: 'https://example.com/a' }]);
    expect(status).toBe(409);
    expect(body.error).toBe('backing_enabled');
    expect(await saves()).toEqual([]);
  });

  it('rejects an unknown source and an oversized batch', async () => {
    expect((await importItems([], 'delicious')).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => ({ url: `https://example.com/${i}` }));
    expect((await importItems(many)).status).toBe(400);
  });
});
