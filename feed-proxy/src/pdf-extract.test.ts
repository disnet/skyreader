import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  isPdf,
  PdfPasswordError,
  PdfUnreadableError,
  remotePdfExtractor,
  type PdfExtraction,
} from './pdf-extract';

describe('isPdf', () => {
  it('trusts a PDF content type', () => {
    expect(isPdf(new Uint8Array(0), 'application/pdf; charset=binary')).toBe(true);
  });

  it('sniffs a PDF served as something else', () => {
    expect(isPdf(new TextEncoder().encode('%PDF-1.7\n...'), 'application/octet-stream')).toBe(true);
  });

  it('leaves HTML alone, even HTML that mentions a PDF header', () => {
    expect(
      isPdf(
        new TextEncoder().encode('<p>Files start with %PDF-1.7</p>'),
        'text/html; charset=utf-8'
      )
    ).toBe(false);
  });

  it('sniffs when there is no content type', () => {
    expect(isPdf(new TextEncoder().encode('junk\n%PDF-1.4'), null)).toBe(true);
    expect(isPdf(new TextEncoder().encode('<html>'), null)).toBe(false);
  });
});

describe('remotePdfExtractor', () => {
  const PARSED: PdfExtraction = {
    title: 'A Paper',
    author: null,
    description: null,
    content: '<section data-pdf-page="1">\n<p>Text.</p>\n</section>',
    published: null,
    wordCount: 1,
    pageCount: 1,
    pagesKept: 1,
  };

  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => fetchMock?.mockRestore());

  function answer(status: number, body: unknown) {
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    );
  }

  it('posts the bytes with the secret and returns the parse', async () => {
    answer(200, PARSED);
    const extract = remotePdfExtractor('https://pdf.example/', 'shh');
    const bytes = new TextEncoder().encode('%PDF-1.7');

    expect(await extract(bytes)).toEqual(PARSED);

    const [url, init] = fetchMock!.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://pdf.example/extract');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer shh');
    expect(init.body).toBe(bytes);
  });

  it('rebuilds the errors the proxy branches on', async () => {
    const extract = remotePdfExtractor('https://pdf.example', 'shh');
    answer(422, { name: 'PdfUnreadableError', message: 'Invalid PDF structure.' });
    const unreadable = await extract(new Uint8Array(1)).catch((e) => e);
    expect(unreadable).toBeInstanceOf(PdfUnreadableError);
    expect(unreadable.message).toBe('Invalid PDF structure.');

    fetchMock!.mockRestore();
    answer(422, { name: 'PdfPasswordError', message: 'This PDF is password-protected' });
    expect(await extract(new Uint8Array(1)).catch((e) => e)).toBeInstanceOf(PdfPasswordError);
  });

  it('fails plainly on anything else, naming the status', async () => {
    answer(401, { message: 'Unauthorized' });
    const err = await remotePdfExtractor(
      'https://pdf.example',
      'bad'
    )(new Uint8Array(1)).catch((e) => e);
    expect(err).not.toBeInstanceOf(PdfUnreadableError);
    expect(err.message).toBe('PDF extractor answered 401: Unauthorized');
  });

  it('times out a call that takes too long', async () => {
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      ((_url: string, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        )) as unknown as typeof fetch
    );
    const err = await remotePdfExtractor(
      'https://pdf.example',
      'shh',
      10
    )(new Uint8Array(1)).catch((e) => e);
    expect(err.name).toBe('TimeoutError');
  });
});
