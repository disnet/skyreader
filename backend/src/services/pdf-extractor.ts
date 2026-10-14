import type { Env } from '../types';
import { getRequestId } from '../utils/request-context';

// The backend's own client for the pdf-extractor Worker, used for uploaded PDFs
// (routes/saved-pdf.ts). A PDF saved by URL goes through the feed proxy instead,
// which fetches it and calls the same Worker; an upload has no URL to fetch, so
// its bytes are posted here directly. See pdf-extractor/CLAUDE.md for the contract.

/** Same shape as pdf-extractor/src/extract.ts and feed-proxy/src/pdf-extract.ts. */
export interface PdfExtraction {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  published: string | null;
  wordCount: number;
  pageCount: number;
  pagesKept: number;
}

// Wall-clock ceiling on one parse. The Worker's own ceiling is cpu_ms = 10000;
// a 100-page paper takes ~2s of CPU, so this only trips on a wedged call.
const PARSE_TIMEOUT_MS = 25_000;

/**
 * A parse that produced no text. `charged` says whether the Worker ran (and so
 * whether the reader's daily allowance pays for it): a password-protected or
 * unreadable PDF did cost a parse; an outage or a misconfiguration did not.
 */
export class PdfParseError extends Error {
  constructor(
    message: string,
    readonly charged: boolean,
    /** The reader's problem (their file), as opposed to ours (the Worker). */
    readonly userFacing: boolean
  ) {
    super(message);
    this.name = 'PdfParseError';
  }
}

export function pdfExtractorConfigured(env: Env): boolean {
  return Boolean((env.PDF_EXTRACTOR_URL as string | undefined) && env.PDF_EXTRACTOR_SECRET);
}

export async function parsePdf(env: Env, bytes: ArrayBuffer): Promise<PdfExtraction> {
  const base = (env.PDF_EXTRACTOR_URL as string).replace(/\/+$/, '');
  const headers = new Headers({
    Authorization: `Bearer ${env.PDF_EXTRACTOR_SECRET}`,
    'Content-Type': 'application/pdf',
  });
  const requestId = getRequestId();
  if (requestId) headers.set('X-Request-Id', requestId);

  let response: Response;
  try {
    response = await fetch(`${base}/extract`, {
      method: 'POST',
      headers,
      body: bytes,
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new PdfParseError('This PDF took too long to read.', true, true);
    }
    throw new PdfParseError("Couldn't read PDFs just now. Try again in a moment.", false, false);
  }

  const body = (await response.json().catch(() => null)) as
    (Partial<PdfExtraction> & { name?: string; message?: string }) | null;

  if (response.status === 422) {
    // PdfPasswordError / PdfUnreadableError: the file, not the service.
    const message =
      body?.name === 'PdfPasswordError'
        ? 'This PDF is password-protected.'
        : "Skyreader couldn't read the text of this PDF.";
    throw new PdfParseError(message, true, true);
  }
  if (response.status === 413) {
    throw new PdfParseError('This PDF is too large to read.', false, true);
  }
  if (!response.ok || !body || (body.content !== null && typeof body.content !== 'string')) {
    console.error(`[PdfExtractor] HTTP ${response.status}: ${body?.message ?? 'no body'}`);
    // A 500 is the Worker giving up on this file; anything else is the service.
    const ran = response.status === 500;
    throw new PdfParseError(
      ran
        ? "Skyreader couldn't read the text of this PDF."
        : "Couldn't read PDFs just now. Try again in a moment.",
      ran,
      ran
    );
  }

  return {
    title: typeof body.title === 'string' ? body.title : null,
    author: typeof body.author === 'string' ? body.author : null,
    description: typeof body.description === 'string' ? body.description : null,
    content: body.content ?? null,
    published: typeof body.published === 'string' ? body.published : null,
    wordCount: typeof body.wordCount === 'number' ? body.wordCount : 0,
    pageCount: typeof body.pageCount === 'number' ? body.pageCount : 0,
    pagesKept: typeof body.pagesKept === 'number' ? body.pagesKept : 0,
  };
}
