import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import { buildEpub, buildZip } from './helpers/epub';

// EPUBs (Supporter): uploaded to POST /api/saved/epub and read in the Worker
// (services/epub.ts), or saved by link, where the feed proxy recognises the book
// and hands it back to /api/extract to fetch and read.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:epubreader';
const SESSION = 'sess-epub-reader';
const RKEY = 'ccccccccccccc';

async function reset(tier = 'supporter') {
  for (const table of ['saved_articles', 'saved_files', 'user_settings']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_did = ?`).bind(DID).run();
  }
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM rate_limits').run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'epub.bsky.social', 'https://pds.test', ?, unixepoch())`
  )
    .bind(DID, tier)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'epub.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, GRANULAR_SCOPES)
    .run();
}

function upload(body: BodyInit, opts: { rkey?: string; name?: string } = {}) {
  const params = new URLSearchParams({ rkey: opts.rkey ?? RKEY, name: opts.name ?? 'book.epub' });
  return new IncomingRequest(`http://localhost/api/saved/epub?${params}`, {
    method: 'POST',
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/epub+zip',
    },
    body,
  });
}

function request(path: string, init: RequestInit = {}) {
  return new IncomingRequest(`http://localhost${path}`, {
    ...init,
    headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL, ...init.headers },
  });
}

async function call(req: Request): Promise<{ status: number; body: any; res: Response }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const isJson = res.headers.get('Content-Type')?.includes('json');
  const body = isJson ? await res.json() : null;
  return { status: res.status, body, res };
}

const BOOK = () =>
  buildEpub({
    title: 'A Room of One’s Own',
    creators: ['Virginia Woolf'],
    date: '1929-10-24',
    chapters: [
      {
        id: 'ch1',
        body: '<h1>One</h1><p>But, you may say, we asked you to speak about women.</p>',
      },
      {
        id: 'ch2',
        body: '<h1>Two</h1><p>The scene, if I may ask you to follow me, was now changed.</p>',
      },
    ],
  });

describe('POST /api/saved/epub', () => {
  let originalFetch: typeof fetch;
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // Nothing leaves the Worker: an EPUB is read in place.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('unexpected fetch');
    }) as unknown as typeof fetch;
    await reset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('saves an upload as a URL-less EPUB save and keeps the original', async () => {
    const epub = await BOOK();
    const { status, body } = await call(upload(epub));

    expect(status).toBe(201);
    expect(body).toMatchObject({
      rkey: RKEY,
      url: '',
      title: 'A Room of One’s Own',
      author: 'Virginia Woolf',
      contentType: 'epub',
      source: 'upload',
      chapterCount: 2,
      chaptersKept: 2,
    });
    expect(body.content).toContain('<section data-epub-chapter="2">');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const row = await env.DB.prepare(
      'SELECT url, source, content_type, word_count FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(DID, RKEY)
      .first();
    expect(row).toMatchObject({ url: '', source: 'upload', content_type: 'epub' });

    const file = await env.DB.prepare('SELECT * FROM saved_files WHERE user_did = ?')
      .bind(DID)
      .first<{ r2_key: string; mime_type: string; size: number }>();
    expect(file).toMatchObject({
      r2_key: `epub/${DID}/${RKEY}.epub`,
      mime_type: 'application/epub+zip',
      size: epub.byteLength,
    });

    // Served back to its owner as an EPUB.
    const got = await call(request(`/api/saved/${RKEY}/file`));
    expect(got.status).toBe(200);
    expect(got.res.headers.get('Content-Type')).toBe('application/epub+zip');
    expect(got.res.headers.get('Content-Disposition')).toContain('book.epub');
    expect(new Uint8Array(await got.res.arrayBuffer())).toEqual(epub);

    // Deleting the save deletes the file.
    await call(request(`/api/saved/${RKEY}`, { method: 'DELETE' }));
    expect(await env.SAVED_FILES.get(file!.r2_key)).toBeNull();
  });

  it('is a Supporter feature', async () => {
    await reset('free');
    const { status, body } = await call(upload(await BOOK()));
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'pdf_upgrade_required' });
    expect(body.message).toContain('EPUB');
  });

  it('refuses a file that is not a zip, and a zip that is not a book', async () => {
    const notZip = await call(upload(new TextEncoder().encode('%PDF-1.7')));
    expect(notZip.status).toBe(415);
    expect(notZip.body.error).toBe('not_an_epub');

    const zip = await call(upload(await buildZip([['notes.txt', 'hello']])));
    expect(zip.status).toBe(422);
    expect(zip.body).toMatchObject({
      error: 'epub_unreadable',
      message: "This file isn't an EPUB.",
    });
    expect(
      await env.DB.prepare('SELECT 1 FROM saved_files WHERE user_did = ?').bind(DID).first()
    ).toBeNull();
  });

  it('refuses a book with no text', async () => {
    const { status, body } = await call(
      upload(await buildEpub({ chapters: [{ id: 'c', body: '<img src="p.jpg"/>' }] }))
    );
    expect(status).toBe(422);
    expect(body.error).toBe('epub_unreadable');
  });

  it('opens the existing save when the same book is uploaded again', async () => {
    const epub = await BOOK();
    await call(upload(epub));
    const { status, body } = await call(upload(epub, { rkey: 'ddddddddddddd' }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'already_saved', rkey: RKEY });
  });

  it('allows books larger than the PDF cap, up to its own', async () => {
    const images = new Uint8Array(12 * 1024 * 1024);
    crypto.getRandomValues(images.subarray(0, 65536));
    const epub = await buildEpub({ extra: [['OEBPS/images/plate.jpg', images]] });
    const { status } = await call(upload(epub));
    expect(status).toBe(201);
  });
});

describe('POST /api/extract for an EPUB link', () => {
  let originalFetch: typeof fetch;
  const BOOK_URL = 'https://books.example/woolf.epub';

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await reset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** The proxy says "that's an EPUB"; the site serves `book`. */
  function stub(book: Uint8Array) {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/extract')) {
        return Response.json({ error: 'EPUBs are read by the API', blocked: false, epub: true });
      }
      if (url === BOOK_URL) return new Response(book);
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  function extract() {
    return request('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: BOOK_URL }),
    });
  }

  it('fetches and reads the book itself', async () => {
    const mock = stub(await BOOK());
    const { status, body } = await call(extract());
    expect(status).toBe(200);
    expect(body).toMatchObject({
      title: 'A Room of One’s Own',
      contentType: 'epub',
      domain: 'books.example',
    });
    expect(body.content).toContain('speak about women');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('tells a reader without the plan that EPUBs are a Supporter feature', async () => {
    await reset('free');
    const mock = stub(await BOOK());
    const { status, body } = await call(extract());
    expect(status).toBe(502);
    expect(body).toMatchObject({ pdf: true, format: 'epub', code: 'upgrade_required' });
    // The book itself is never fetched.
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable book as a file the extension cannot help with', async () => {
    stub(await buildZip([['notes.txt', 'hello']]));
    const { status, body } = await call(extract());
    expect(status).toBe(502);
    expect(body).toMatchObject({ pdf: true, format: 'epub', blocked: false });
    expect(body.code).toBeUndefined();
  });

  it('saves the extraction typed as an EPUB', async () => {
    const save = await call(
      request('/api/saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: BOOK_URL,
          rkey: RKEY,
          title: 'A Room of One’s Own',
          content: '<section data-epub-chapter="1"><p>Text.</p></section>',
          contentType: 'epub',
        }),
      })
    );
    expect(save.status).toBeLessThan(300);
    const row = await env.DB.prepare('SELECT content_type FROM saved_articles WHERE user_did = ?')
      .bind(DID)
      .first();
    expect(row).toMatchObject({ content_type: 'epub' });
  });
});
