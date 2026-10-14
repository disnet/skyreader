import { describe, expect, it } from 'vitest';
import { MAX_PDF_BYTES } from './extract';
import worker, { type Env } from './index';
import { makePdf } from './pdf-fixture';

const env: Env = { EXTRACT_SECRET: 'test-secret', GIT_COMMIT_SHA: 'abc123' };

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request('https://pdf-extractor.test/extract', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', ...headers },
    body,
  });
}

const paper = () =>
  makePdf([
    [
      [72, 700, 20, 'Notes on Margins'],
      [72, 660, 10, 'Readers who write in the margins remember more of what'],
      [72, 648, 10, 'they read than readers who do not.'],
    ],
  ]);

describe('POST /extract', () => {
  it('parses the posted PDF', async () => {
    const res = await worker.fetch(post(paper()), env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.title).toBe('Notes on Margins');
    expect(out.content).toContain(
      '<p>Readers who write in the margins remember more of what they read than readers who do not.</p>'
    );
    expect(out.pageCount).toBe(1);
  });

  it('refuses a request without the secret, or with the wrong one', async () => {
    const none = new Request('https://pdf-extractor.test/extract', {
      method: 'POST',
      body: paper(),
    });
    expect((await worker.fetch(none, env)).status).toBe(401);
    const wrong = post(paper(), { Authorization: 'Bearer nope' });
    expect((await worker.fetch(wrong, env)).status).toBe(401);
  });

  it('fails closed when no secret is configured', async () => {
    expect((await worker.fetch(post(paper()), {})).status).toBe(401);
  });

  it('names an unreadable PDF so the proxy can fall back', async () => {
    const res = await worker.fetch(post(new TextEncoder().encode('%PDF-1.4 nothing else')), env);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: 'PdfUnreadableError' });
  });

  it('refuses a body over the size limit', async () => {
    const res = await worker.fetch(post(new Uint8Array(MAX_PDF_BYTES + 1)), env);
    expect(res.status).toBe(413);
  });
});

describe('routing', () => {
  it('reports its version on /health', async () => {
    const res = await worker.fetch(new Request('https://pdf-extractor.test/health'), env);
    expect(await res.json()).toEqual({ status: 'ok', version: 'abc123' });
  });

  it('only parses on POST /extract', async () => {
    const get = new Request('https://pdf-extractor.test/extract');
    expect((await worker.fetch(get, env)).status).toBe(405);
    const other = new Request('https://pdf-extractor.test/', { method: 'POST' });
    expect((await worker.fetch(other, env)).status).toBe(404);
  });
});
