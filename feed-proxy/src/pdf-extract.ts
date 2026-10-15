// PDF detection, and the client for the PDF extractor Worker (pdf-extractor/).
//
// The proxy fetches a PDF like any page, then hands the bytes to the Worker,
// which reflows them into reader HTML. The parse used to run here, on a worker
// thread, but pdf.js is CPU-bound and this machine's shared vCPUs are not: an
// ordinary paper ran past the timeout once burst credit was spent, and starved
// the crawler while it did.

/** What the Worker returns for a parsed PDF (pdf-extractor/src/extract.ts). */
export interface PdfExtraction {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  published: string | null;
  wordCount: number;
  pageCount: number;
  /** Pages in `content`; less than pageCount when a cap cut it short. */
  pagesKept: number;
}

export type PdfExtractor = (bytes: Uint8Array<ArrayBuffer>) => Promise<PdfExtraction>;

// How long /extract waits on the Worker: upload + parse. Part of /extract's
// budget (see idleTimeout in index.ts), so raise that first. A 100-page paper
// parses in ~2s there; this is the ceiling for a pathological one.
export const PDF_EXTRACT_TIMEOUT_MS = 15 * 1000;

export class PdfPasswordError extends Error {
  constructor() {
    super('This PDF is password-protected');
    this.name = 'PdfPasswordError';
  }
}

/** pdf.js could not open the bytes as a PDF at all. */
export class PdfUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfUnreadableError';
  }
}

/** The response says it is a PDF. */
export function isDeclaredPdf(contentType: string | null): boolean {
  return !!contentType && /^application\/(x-)?pdf\b/i.test(contentType);
}

/**
 * True when the response is a PDF. A PDF type is trusted; a text type is too,
 * the other way (an article about PDFs can mention `%PDF-` near its top). Only
 * a missing or generic type (octet-stream and friends) is settled by sniffing.
 */
export function isPdf(bytes: Uint8Array, contentType: string | null): boolean {
  if (isDeclaredPdf(contentType)) return true;
  if (contentType && /^text\/|html|xml|json/i.test(contentType)) return false;
  // The header may follow a little junk; the spec lets readers look in the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/**
 * Parses PDFs on the extractor Worker at `baseUrl`. Rejects with PdfPasswordError
 * or PdfUnreadableError when the Worker says so, a TimeoutError past
 * `timeoutMs`, and a plain Error for anything else.
 */
export function remotePdfExtractor(
  baseUrl: string,
  secret: string,
  timeoutMs = PDF_EXTRACT_TIMEOUT_MS
): PdfExtractor {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/extract`;
  return async (bytes) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/pdf' },
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as
      (PdfExtraction & { name?: string; message?: string }) | null;
    if (res.ok && body && typeof body.content === 'string' && typeof body.wordCount === 'number') {
      return body;
    }
    if (res.status === 413) throw new PdfUnreadableError('PDF too large');
    if (res.status === 422 && body?.name === 'PdfPasswordError') throw new PdfPasswordError();
    if (res.status === 422 && body?.name === 'PdfUnreadableError')
      throw new PdfUnreadableError(body.message ?? 'Unreadable PDF');
    throw new Error(
      `PDF extractor answered ${res.status}${body?.message ? `: ${body.message}` : ''}`
    );
  };
}

// EPUBs. The proxy only recognises one: a book is already marked-up text, so the
// backend fetches and reads it itself (backend/src/services/epub.ts) when
// /extract answers `epub: true`. Without this, a book was decoded as text and
// handed to Defuddle, the same mojibake PDFs used to get.

/** The response says it is an EPUB. */
export function isDeclaredEpub(contentType: string | null): boolean {
  return !!contentType && /^application\/epub\+zip\b/i.test(contentType);
}

/**
 * True when the response is an EPUB: declared so, or a zip whose first entry is
 * the uncompressed `mimetype` file naming `application/epub+zip` (OCF 3.0 §4.3),
 * when the type is missing or generic.
 */
export function isEpub(bytes: Uint8Array, contentType: string | null): boolean {
  if (isDeclaredEpub(contentType)) return true;
  if (contentType && /^text\/|html|xml|json|pdf/i.test(contentType)) return false;
  if (bytes.length < 58) return false;
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 58));
  return head.startsWith('PK\x03\x04') && head.slice(30) === 'mimetypeapplication/epub+zip';
}

/**
 * isEpub, plus the books its strict check misses: plenty of tools don't store
 * the `mimetype` entry first (or pad its local header), and plenty of servers
 * send a book as octet-stream or zip. A zip is never a web page, so one is a
 * book when its path says .epub or it holds an OCF container document (the
 * name sits in the zip's directory as plain bytes).
 */
export function isEpubResponse(
  bytes: Uint8Array,
  contentType: string | null,
  url: string
): boolean {
  if (isEpub(bytes, contentType)) return true;
  if (contentType && /^text\/|html|xml|json|pdf/i.test(contentType)) return false;
  if (bytes.length < 4 || new TextDecoder('latin1').decode(bytes.subarray(0, 4)) !== 'PK\x03\x04') {
    return false;
  }
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a URL we can read a path from: only the contents can say.
  }
  return /\.epub$/i.test(path) || containsAscii(bytes, 'META-INF/container.xml');
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== first) continue;
    for (let k = 1; k < needle.length; k++) {
      if (bytes[i + k] !== needle.charCodeAt(k)) continue outer;
    }
    return true;
  }
  return false;
}
