import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import { PDF_QUOTA_ENDPOINT, pdfQuotaDay } from '../src/services/pdf-quota';
import { cleanFilename, savedFileKey, titleFromFilename } from '../src/routes/saved-pdf';

// Uploaded PDFs (routes/saved-pdf.ts): Supporter-only, parsed by the extractor
// Worker (fetch is stubbed), kept in R2, deleted with their save.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:pdfuploader';
const OTHER = 'did:plc:pdfnosy';
const SESSION = 'sess-pdf-upload';
const OTHER_SESSION = 'sess-pdf-nosy';
const RKEY = 'aaaaaaaaaaaaa';

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const EXTRACTED = {
  title: 'Attention Is All You Need',
  author: 'Vaswani et al.',
  description: null,
  content: '<section data-pdf-page="1"><p>The dominant sequence transduction models…</p></section>',
  published: '2017-06-12T00:00:00Z',
  wordCount: 6,
  pageCount: 1,
  pagesKept: 1,
};

async function addUser(did: string, session: string, tier: string) {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, 'https://pds.test', ?, unixepoch())`
  )
    .bind(did, `${session}.bsky.social`, tier)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, ?, 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(
      session,
      did,
      `${session}.bsky.social`,
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3_600_000,
      GRANULAR_SCOPES
    )
    .run();
}

async function reset(tier = 'supporter') {
  for (const table of ['saved_articles', 'saved_files', 'user_settings']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_did IN (?, ?)`).bind(DID, OTHER).run();
  }
  await env.DB.prepare('DELETE FROM sessions WHERE did IN (?, ?)').bind(DID, OTHER).run();
  await env.DB.prepare('DELETE FROM users WHERE did IN (?, ?)').bind(DID, OTHER).run();
  await env.DB.prepare('DELETE FROM rate_limits').run();
  await addUser(DID, SESSION, tier);
  await addUser(OTHER, OTHER_SESSION, 'supporter');
}

function upload(body: BodyInit, opts: { rkey?: string; name?: string; session?: string } = {}) {
  const params = new URLSearchParams({ rkey: opts.rkey ?? RKEY, name: opts.name ?? 'paper.pdf' });
  return new IncomingRequest(`http://localhost/api/saved/pdf?${params}`, {
    method: 'POST',
    headers: {
      Cookie: `session_id=${opts.session ?? SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/pdf',
    },
    body,
  });
}

function request(path: string, method = 'GET', session = SESSION) {
  return new IncomingRequest(`http://localhost${path}`, {
    method,
    headers: { Cookie: `session_id=${session}`, Origin: env.FRONTEND_URL },
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

/** The extractor answers `answer`; every other outbound fetch fails fast. */
function extractorAnswers(answer: Response | (() => Response)) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://pdf-extractor.test/')) {
      return typeof answer === 'function' ? answer() : answer.clone();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

async function parsesSpent(): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT count FROM rate_limits WHERE did = ? AND endpoint = ? AND window_start = ?'
  )
    .bind(DID, PDF_QUOTA_ENDPOINT, pdfQuotaDay(Date.now()))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe('POST /api/saved/pdf', () => {
  let originalFetch: typeof fetch;
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await reset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('saves an upload as a URL-less PDF save and keeps the original', async () => {
    const mock = extractorAnswers(Response.json(EXTRACTED));
    const { status, body } = await call(upload(PDF));

    expect(status).toBe(201);
    expect(body).toMatchObject({
      rkey: RKEY,
      uri: `at://${DID}/app.skyreader.feed.saved/${RKEY}`,
      url: '',
      title: EXTRACTED.title,
      contentType: 'pdf',
      source: 'upload',
      content: EXTRACTED.content,
    });

    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-extract-secret');

    const row = await env.DB.prepare(
      'SELECT url, source, content_type, title, content FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(DID, RKEY)
      .first();
    expect(row).toMatchObject({ url: '', source: 'upload', content_type: 'pdf' });

    const file = await env.DB.prepare('SELECT * FROM saved_files WHERE user_did = ?')
      .bind(DID)
      .first<{ size: number; filename: string; r2_key: string }>();
    expect(file).toMatchObject({ size: PDF.byteLength, filename: 'paper.pdf' });
    const object = await env.SAVED_FILES.get(file!.r2_key);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PDF);

    expect(await parsesSpent()).toBe(1);
  });

  it('titles a PDF that names none after its file', async () => {
    extractorAnswers(Response.json({ ...EXTRACTED, title: null }));
    const { body } = await call(upload(PDF, { name: 'quarterly_report.PDF' }));
    expect(body.title).toBe('quarterly report');
  });

  it('is a Supporter feature', async () => {
    await reset('free');
    const mock = extractorAnswers(Response.json(EXTRACTED));
    const { status, body } = await call(upload(PDF));
    expect(status).toBe(403);
    expect(body.error).toBe('pdf_upgrade_required');
    expect(mock).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a PDF', async () => {
    const mock = extractorAnswers(Response.json(EXTRACTED));
    const { status, body } = await call(upload(new TextEncoder().encode('<html></html>')));
    expect(status).toBe(415);
    expect(body.error).toBe('not_a_pdf');
    expect(mock).not.toHaveBeenCalled();
  });

  it('refuses a file over the size cap without parsing it', async () => {
    const mock = extractorAnswers(Response.json(EXTRACTED));
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    const { status, body } = await call(upload(big));
    expect(status).toBe(413);
    expect(body.error).toBe('pdf_too_large');
    expect(mock).not.toHaveBeenCalled();
  });

  it('opens the existing save when the same file is uploaded again', async () => {
    extractorAnswers(Response.json(EXTRACTED));
    await call(upload(PDF));
    const { status, body } = await call(upload(PDF, { rkey: 'bbbbbbbbbbbbb' }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'already_saved', rkey: RKEY });
  });

  it('holds to the monthly upload allowance', async () => {
    const now = Date.now();
    const stmts = Array.from({ length: 200 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO saved_files (user_did, rkey, r2_key, mime_type, size, sha256, created_at)
         VALUES (?, ?, 'k', 'application/pdf', 1, ?, ?)`
      ).bind(DID, `old${String(i).padStart(10, '0')}`, `sha${i}`, now)
    );
    await env.DB.batch(stmts);
    const mock = extractorAnswers(Response.json(EXTRACTED));
    const { status, body } = await call(upload(PDF));
    expect(status).toBe(403);
    expect(body.error).toBe('pdf_upload_limit_reached');
    expect(body.resetsAt).toBeTruthy();
    expect(mock).not.toHaveBeenCalled();
  });

  it('holds to the storage allowance', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_files (user_did, rkey, r2_key, mime_type, size, sha256, created_at)
       VALUES (?, 'oldoldoldoldo', 'k', 'application/pdf', ?, 'sha', 0)`
    )
      .bind(DID, 2048 * 1024 * 1024 - 10)
      .run();
    extractorAnswers(Response.json(EXTRACTED));
    const { status, body } = await call(upload(PDF));
    expect(status).toBe(403);
    expect(body.error).toBe('pdf_storage_full');
  });

  it('spends the daily PDF allowance shared with URL saves', async () => {
    await env.DB.prepare(
      'INSERT INTO rate_limits (did, endpoint, window_start, count) VALUES (?, ?, ?, 100)'
    )
      .bind(DID, PDF_QUOTA_ENDPOINT, pdfQuotaDay(Date.now()))
      .run();
    const mock = extractorAnswers(Response.json(EXTRACTED));
    const { status, body } = await call(upload(PDF));
    expect(status).toBe(403);
    expect(body.error).toBe('pdf_daily_limit_reached');
    expect(mock).not.toHaveBeenCalled();
  });

  it('reports a password-protected PDF, charges the parse, and keeps nothing', async () => {
    extractorAnswers(
      Response.json(
        { name: 'PdfPasswordError', message: 'This PDF is password-protected' },
        { status: 422 }
      )
    );
    const { status, body } = await call(upload(PDF));
    expect(status).toBe(422);
    expect(body.message).toBe('This PDF is password-protected.');
    expect(await parsesSpent()).toBe(1);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM saved_files WHERE user_did = ?')
      .bind(DID)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("doesn't charge for an extractor outage", async () => {
    extractorAnswers(new Response('bad gateway', { status: 502 }));
    const { status } = await call(upload(PDF));
    expect(status).toBe(502);
    expect(await parsesSpent()).toBe(0);
  });

  it('refuses a PDF with no text layer', async () => {
    extractorAnswers(Response.json({ ...EXTRACTED, content: null, wordCount: 0 }));
    const { status, body } = await call(upload(PDF));
    expect(status).toBe(422);
    expect(body.error).toBe('pdf_unreadable');
  });
});

describe('GET /api/saved/<rkey>/file and deleting the save', () => {
  let originalFetch: typeof fetch;
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await reset();
    extractorAnswers(Response.json(EXTRACTED));
    await call(upload(PDF));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('serves the original to its owner only', async () => {
    const { status, res } = await call(request(`/api/saved/${RKEY}/file`));
    expect(status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('paper.pdf');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);

    const nosy = await call(request(`/api/saved/${RKEY}/file`, 'GET', OTHER_SESSION));
    expect(nosy.status).toBe(404);
  });

  it('deletes the file with the save', async () => {
    const { status } = await call(request(`/api/saved/${RKEY}`, 'DELETE'));
    expect(status).toBe(200);
    expect(await env.SAVED_FILES.get(savedFileKey(DID, RKEY))).toBeNull();
    const row = await env.DB.prepare('SELECT 1 FROM saved_files WHERE user_did = ? AND rkey = ?')
      .bind(DID, RKEY)
      .first();
    expect(row).toBeNull();
    expect((await call(request(`/api/saved/${RKEY}/file`))).status).toBe(404);
  });
});

describe('upload filenames', () => {
  it('keeps the last path segment, without control characters', () => {
    expect(cleanFilename('C:\\Users\\me\\paper.pdf')).toBe('paper.pdf');
    expect(cleanFilename('a\u0000b.pdf')).toBe('ab.pdf');
    expect(cleanFilename('   ')).toBeNull();
    expect(titleFromFilename('My_Paper.pdf')).toBe('My Paper');
  });
});
