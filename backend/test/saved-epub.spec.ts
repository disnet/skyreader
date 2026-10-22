import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import { buildEpub, buildZip } from './helpers/epub';
import { parseEpub } from '../src/services/epub';
import { readStagedOriginal, stageLinkedBook } from '../src/services/linked-originals';

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

  // Over the old 30 MB cap, and mostly a picture (stored, as books store their
  // images): the book streams into R2 in parts and is read back by range.
  it('reads a book bigger than one part from where it was kept', async () => {
    const picture = new Uint8Array(31 * 1024 * 1024);
    for (let i = 0; i < picture.length; i += 4096) picture[i] = (i / 4096) % 251;
    const epub = await buildEpub({
      title: 'Illustrated',
      chapters: [{ id: 'ch1', body: '<h1>One</h1><p>A long caption under a large plate.</p>' }],
      extra: [['OEBPS/plate.bin', picture]],
      stored: ['OEBPS/plate.bin'],
    });
    const { status, body } = await call(upload(epub));
    expect(status).toBe(201);
    expect(body).toMatchObject({ title: 'Illustrated', chaptersKept: 1 });
    const file = await env.DB.prepare('SELECT size FROM saved_files WHERE user_did = ?')
      .bind(DID)
      .first<{ size: number }>();
    expect(file!.size).toBe(epub.byteLength);
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
    expect(body.content).toContain('<section data-epub-chapter="2" id="epub-c2">');
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

  it('allows illustrated books past the old 10 MB cap', async () => {
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

  it('reads the book in memory when staging it in R2 fails', async () => {
    const book = await BOOK();
    const mock = stub(book);
    const spy = vi
      .spyOn(env.SAVED_FILES!, 'createMultipartUpload')
      .mockRejectedValue(new Error('R2 is down'));
    try {
      const { status, body } = await call(extract());
      expect(status).toBe(200);
      expect(body).toMatchObject({ contentType: 'epub', title: 'A Room of One’s Own' });
      // The proxy, the staged read that failed, then the book again in memory.
      expect(mock).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  // Two reads of one book at once (two tabs, a sync) each stage their own copy:
  // one failing and dropping its copy leaves the other's whole.
  it("keeps each read's staged copy apart", async () => {
    const book = await BOOK();
    stub(book);
    const a = await stageLinkedBook(env.SAVED_FILES!, DID, BOOK_URL, 50 * 1024 * 1024);
    const b = await stageLinkedBook(env.SAVED_FILES!, DID, BOOK_URL, 50 * 1024 * 1024);
    await b.discard();
    expect((await parseEpub(a.file)).title).toBe('A Room of One’s Own');
    const staged = await readStagedOriginal(env, DID, BOOK_URL);
    expect(staged!.size).toBe(book.byteLength);
    await staged!.body.cancel();
    await staged!.remove();
    expect((await env.SAVED_FILES!.list({ prefix: `staged/epub/${DID}/` })).objects).toHaveLength(
      0
    );
  });

  it('reports an unreadable book as a file the extension cannot help with', async () => {
    stub(await buildZip([['notes.txt', 'hello']]));
    const { status, body } = await call(extract());
    expect(status).toBe(502);
    expect(body).toMatchObject({ pdf: true, format: 'epub', blocked: false });
    expect(body.code).toBeUndefined();
  });

  function saveLink() {
    return call(
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
  }

  it('saves the extraction typed as an EPUB, and keeps the book for its pictures', async () => {
    const book = await BOOK();
    stub(book);
    const save = await saveLink();
    expect(save.status).toBeLessThan(300);
    const row = await env.DB.prepare('SELECT content_type FROM saved_articles WHERE user_did = ?')
      .bind(DID)
      .first();
    expect(row).toMatchObject({ content_type: 'epub' });

    const file = await env.DB.prepare('SELECT * FROM saved_files WHERE user_did = ?')
      .bind(DID)
      .first<{ r2_key: string; mime_type: string; filename: string; size: number }>();
    expect(file).toMatchObject({
      r2_key: `epub/${DID}/${RKEY}.epub`,
      mime_type: 'application/epub+zip',
      filename: 'woolf.epub',
      size: book.byteLength,
    });
  });

  it('keeps the book it read for the save, without fetching it again', async () => {
    const book = await BOOK();
    const mock = stub(book);
    expect((await call(extract())).status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
    expect((await saveLink()).status).toBeLessThan(300);
    // The proxy and the book, once: the save adopted what extract read.
    expect(mock).toHaveBeenCalledTimes(2);
    const file = await env.DB.prepare('SELECT r2_key, size FROM saved_files WHERE user_did = ?')
      .bind(DID)
      .first<{ r2_key: string; size: number }>();
    expect(file).toMatchObject({ r2_key: `epub/${DID}/${RKEY}.epub`, size: book.byteLength });
    const kept = await env.SAVED_FILES!.get(file!.r2_key);
    expect(new Uint8Array(await kept!.arrayBuffer())).toEqual(book);
    const staged = await env.SAVED_FILES!.list({ prefix: `staged/epub/${DID}/` });
    expect(staged.objects).toHaveLength(0);
  });

  it('fetches the book once for a burst of pictures', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await saveLink();
    const mock = stub(await buildEpub({ extra: [['OEBPS/images/a.png', png]] }));
    const got = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(request(`/api/saved/${RKEY}/asset?path=OEBPS/images/a.png`))
      )
    );
    expect(got.map((g) => g.status)).toEqual([200, 200, 200, 200, 200]);
    expect(mock.mock.calls.filter(([u]) => String(u) === BOOK_URL)).toHaveLength(1);
  });

  it('says storage is full rather than leaving a book’s pictures to fail silently', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await saveLink();
    await env.DB.prepare(
      `INSERT INTO saved_files (user_did, rkey, r2_key, filename, mime_type, size, sha256, created_at)
       VALUES (?, 'ddddddddddddd', 'x', 'x.pdf', 'application/pdf', ?, 'x', 0)`
    )
      .bind(DID, 100 * 1024 * 1024 * 1024)
      .run();
    const got = await call(request(`/api/saved/${RKEY}/asset?path=OEBPS/images/a.png`));
    expect(got.status).toBe(403);
    expect(got.body).toMatchObject({ error: 'pdf_storage_full' });
    // A later picture in the same minute hears the same, without trying again.
    const again = await call(request(`/api/saved/${RKEY}/asset?path=OEBPS/images/b.png`));
    expect(again.status).toBe(403);
  });

  it('keeps the book on the first picture asked for when the save could not', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await saveLink();
    expect(
      await env.DB.prepare('SELECT 1 FROM saved_files WHERE user_did = ?').bind(DID).first()
    ).toBeNull();

    stub(await buildEpub({ extra: [['OEBPS/images/a.png', png]] }));
    const got = await call(request(`/api/saved/${RKEY}/asset?path=OEBPS/images/a.png`));
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.res.arrayBuffer())).toEqual(png);
  });
});

describe('GET /api/saved/<rkey>/asset', () => {
  let originalFetch: typeof fetch;
  const PNG = new Uint8Array(4096).map((_, i) => (i * 7) % 256);
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await reset();
    const epub = await buildEpub({
      chapters: [
        { id: 'ch1', body: '<p>Text.</p><img src="../images/plate%201.png" alt="Plate"/>' },
      ],
      extra: [
        ['OEBPS/images/plate 1.png', PNG],
        ['OEBPS/images/logo.svg', SVG],
      ],
    });
    const { status, body } = await call(upload(epub));
    expect(status).toBe(201);
    expect(body.content).toContain('data-epub-src="OEBPS/images/plate 1.png"');
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const asset = (path: string, rkey = RKEY) =>
    call(request(`/api/saved/${rkey}/asset?path=${encodeURIComponent(path)}`));

  it('serves a picture out of the kept book', async () => {
    const { status, res } = await asset('OEBPS/images/plate 1.png');
    expect(status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('serves an SVG sandboxed, so it cannot run as a page', async () => {
    const { status, res } = await asset('OEBPS/images/logo.svg');
    expect(status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('serves only pictures that are in the book', async () => {
    expect((await asset('OEBPS/images/missing.png')).status).toBe(404);
    expect((await asset('OEBPS/content.opf')).status).toBe(404);
    expect((await asset('OEBPS/text/ch1.xhtml')).status).toBe(404);
    expect((await asset('OEBPS/images/plate 1.png', 'eeeeeeeeeeeee')).status).toBe(404);
  });

  it('answers 404, not 500, when the book’s directory points past its end', async () => {
    const key = `epub/${DID}/${RKEY}.epub`;
    const bytes = new Uint8Array(await (await env.SAVED_FILES!.get(key))!.arrayBuffer());
    const view = new DataView(bytes.buffer);
    // Every central directory entry's local header offset, past the end.
    for (let i = 0; i + 46 <= bytes.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 42, bytes.length + 10, true);
    }
    await env.SAVED_FILES!.put(key, bytes);
    expect((await asset('OEBPS/images/plate 1.png')).status).toBe(404);
  });

  it('serves only to the reader who saved it', async () => {
    await env.DB.prepare('UPDATE saved_files SET user_did = ? WHERE user_did = ?')
      .bind('did:plc:someoneelse', DID)
      .run();
    expect((await asset('OEBPS/images/plate 1.png')).status).toBe(404);
    await env.DB.prepare('DELETE FROM saved_files WHERE user_did = ?')
      .bind('did:plc:someoneelse')
      .run();
  });
});
