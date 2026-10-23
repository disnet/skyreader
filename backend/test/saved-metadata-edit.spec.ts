import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import { fillExtractedContent } from '../src/services/saved-content';

// PATCH /api/saved/:rkey as a metadata edit: the reader's title/author/
// description/date overwrite the row, stamp updated_at (so other devices and
// search pick it up), and survive the automated writes that would otherwise put
// the extracted values back.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:savedmetaedit';
const SESSION = 'sess-saved-meta-edit';
const URL = 'https://example.com/an-article';
const RKEY = 'aaaaaaaaaaaaa';

async function reset() {
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'me.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'me.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, GRANULAR_SCOPES)
    .run();
}

function request(method: string, path: string, body: unknown) {
  return new IncomingRequest(`http://localhost${path}`, {
    method,
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

const patch = (body: unknown, rkey = RKEY) => call(request('PATCH', `/api/saved/${rkey}`, body));

async function getRow() {
  return env.DB.prepare('SELECT * FROM saved_articles WHERE user_did = ? AND rkey = ?')
    .bind(DID, RKEY)
    .first<any>();
}

async function saveIt(extra: Record<string, unknown> = {}) {
  const res = await call(
    request('POST', '/api/saved', {
      url: URL,
      rkey: RKEY,
      title: 'Extracted Title',
      author: 'Site Name',
      description: 'An excerpt',
      publishedAt: '2025-01-01T00:00:00.000Z',
      ...extra,
    })
  );
  expect(res.status).toBe(200);
}

describe('PATCH /api/saved/:rkey — editing metadata', () => {
  beforeEach(() => reset());

  it('overwrites the fields it names, stamps updated_at, and marks them edited', async () => {
    await saveIt();
    const before = await getRow();
    expect(before.updated_at).toBeNull();

    const { status, body } = await patch({
      title: '  The Real Title  ',
      author: 'Ada Lovelace; Charles Babbage',
      publishedAt: '1843-10-01',
    });
    expect(status).toBe(200);
    expect(body.updatedAt).toEqual(expect.any(String));

    const row = await getRow();
    expect(row.title).toBe('The Real Title');
    expect(row.author).toBe('Ada Lovelace; Charles Babbage');
    expect(row.published_at).toBe(Date.parse('1843-10-01'));
    expect(row.description).toBe('An excerpt'); // not named, untouched
    expect(row.updated_at).toBe(Date.parse(body.updatedAt));
    expect(row.edited_fields).toBe(' title author published_at ');

    // A later edit adds to the set rather than replacing it.
    await patch({ description: 'My summary' });
    expect((await getRow()).edited_fields).toBe(' title author published_at description ');
  });

  it('clears an optional field with an empty string or null', async () => {
    await saveIt();
    await patch({ author: '', description: null, publishedAt: null });
    const row = await getRow();
    expect(row.author).toBeNull();
    expect(row.description).toBeNull();
    expect(row.published_at).toBeNull();
  });

  it('rejects an empty title, a bad date, an over-long field and an empty patch', async () => {
    await saveIt();
    expect((await patch({ title: '   ' })).status).toBe(400);
    expect((await patch({ publishedAt: 'not a date' })).status).toBe(400);
    expect((await patch({ author: 'x'.repeat(501) })).status).toBe(400);
    expect((await patch({ author: 42 })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await getRow()).title).toBe('Extracted Title');
  });

  it('cuts an over-long summary rather than refusing the edit', async () => {
    await saveIt();
    expect((await patch({ description: 'y'.repeat(2_500) })).status).toBe(200);
    expect((await getRow()).description).toHaveLength(2_000);
  });

  it('keeps both markers when two edits land at once', async () => {
    await saveIt();
    await Promise.all([patch({ title: 'A' }), patch({ author: 'B' })]);
    const fields = (await getRow()).edited_fields;
    expect(fields).toContain(' title ');
    expect(fields).toContain(' author ');
  });

  it("404s on a save that isn't the reader's", async () => {
    expect((await patch({ title: 'Nope' }, 'zzzzzzzzzzzzz')).status).toBe(404);
  });

  it('still takes the word-count backfill alone, without stamping an edit', async () => {
    await saveIt();
    expect((await patch({ wordCount: 1234 })).status).toBe(200);
    const row = await getRow();
    expect(row.word_count).toBe(1234);
    expect(row.updated_at).toBeNull();
    expect(row.edited_fields).toBeNull();
  });

  it('shows up in GET /api/saved/updates for other devices', async () => {
    await saveIt();
    await patch({ title: 'Edited' });
    const { body } = await call(
      new IncomingRequest('http://localhost/api/saved/updates?since=0', {
        headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
      })
    );
    expect(body.articles.map((a: any) => [a.rkey, a.title])).toEqual([[RKEY, 'Edited']]);
  });

  it('survives an extension re-save upgrading the body', async () => {
    await saveIt({ content: '<p>Stub</p>' });
    await patch({ title: 'Mine', author: 'Me' });

    const res = await call(
      request('POST', '/api/saved', {
        url: URL,
        rkey: 'bbbbbbbbbbbbb',
        updateContent: true,
        title: 'Extracted Again',
        author: 'Site Again',
        description: 'Fresh excerpt',
        content: '<p>The whole article.</p>',
      })
    );
    expect(res.status).toBe(200);
    // The answer says what the save now carries, so the client shows the edit.
    expect(res.body).toMatchObject({ title: 'Mine', author: 'Me', description: 'Fresh excerpt' });

    const row = await getRow();
    expect(row.content).toBe('<p>The whole article.</p>');
    expect(row.title).toBe('Mine');
    expect(row.author).toBe('Me');
    // Not edited by hand, so the upgrade still refreshes it.
    expect(row.description).toBe('Fresh excerpt');
  });

  it('survives a background extraction filling a cleared field', async () => {
    await saveIt();
    await patch({ author: '' });
    await fillExtractedContent(
      env,
      { title: 'X', author: 'Extracted Author', content: '<p>Body text here.</p>' } as any,
      { userDid: DID, rkey: RKEY }
    );
    const row = await getRow();
    expect(row.content).toBe('<p>Body text here.</p>');
    expect(row.author).toBeNull();
    expect(row.title).toBe('Extracted Title');
  });
});
