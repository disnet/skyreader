import type { Env, Session } from '../types';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import { getUserTierLimits } from '../services/user-tier';
import {
  EPUB_SUPPORTER_MESSAGE,
  PDF_QUOTA_MESSAGE,
  PDF_SUPPORTER_MESSAGE,
  chargePdfParse,
  hasPdfAllowance,
} from '../services/pdf-quota';
import { PdfParseError, parsePdf, pdfExtractorConfigured } from '../services/pdf-extractor';
import { EpubError, looksLikeZip, parseEpub } from '../services/epub';
import { readCapped } from './feedback';
import { log } from '../utils/logger';

/**
 * Uploaded PDFs and EPUBs, and the originals of every saved PDF (Supporter).
 *
 *   POST /api/saved/pdf?rkey=<tid>&name=<filename>    body: the PDF's bytes
 *   POST /api/saved/epub?rkey=<tid>&name=<filename>   body: the EPUB's bytes
 *   GET  /api/saved/<rkey>/file                       the original, to its owner
 *
 * An EPUB upload works the same way, except that the book is read here
 * (services/epub.ts) rather than by the extractor, so it spends no daily parse
 * allowance; it saves with content_type 'epub'. It shares the PDF limits below:
 * the monthly upload count and the stored bytes are one budget for both.
 *
 * An upload becomes an ordinary save: a saved_articles row with source 'upload',
 * content_type 'pdf', no URL, and the PDF's text reflowed into reader HTML by the
 * pdf-extractor Worker — so highlights, notes, search and read state work on it
 * exactly as on any other save (they key on the save's record uri). The original
 * file is kept in R2 (SAVED_FILES), private to the reader, for the figures and
 * equations a reflow can't carry; saved_files says where it is.
 *
 * A PDF saved by link keeps its original the same way (storeLinkedPdf): fetched
 * from its URL right after the save, so the reader needn't know or care which
 * way a PDF came in, and the original outlives the site that served it.
 *
 * It never reaches the reader's PDS, nor their Semble/Margin backing: it has no
 * URL to put on a card, and uploads are often someone else's copyright. With
 * backing on, the Saved list serves it alongside the collection like any other
 * URL-less save (services/backing/sync.ts listBackedSaved).
 *
 * Limits, from the plan (config/tier-limits.ts): the file size, uploads per
 * month, total bytes stored (every kept original, however it was saved). A
 * parse also spends the reader's daily PDF allowance (services/pdf-quota.ts),
 * shared with PDFs saved by URL.
 */

const COLLECTION = 'app.skyreader.feed.saved';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function savedFileKey(did: string, rkey: string, kind: UploadKind = 'pdf'): string {
  return `${kind}/${did}/${rkey}.${kind}`;
}

/** A display filename: the last path segment, without control characters, capped. */
export function cleanFilename(raw: string | null): string | null {
  if (!raw) return null;
  const name = raw
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
  return name || null;
}

/** The title for an upload whose file names none: its filename, less the extension. */
export function titleFromFilename(name: string | null): string | null {
  if (!name) return null;
  const stem = name
    .replace(/\.(pdf|epub)$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
  return stem || null;
}

// A PDF starts with `%PDF-`, though the spec lets junk precede it within the
// first kilobyte (and some generators do).
const PDF_SIGNATURE_WINDOW = 1024;

function looksLikePdf(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, PDF_SIGNATURE_WINDOW));
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  outer: for (let i = 0; i + sig.length <= head.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (head[i + j] !== sig[j]) continue outer;
    }
    return true;
  }
  return false;
}

function concatChunks(chunks: Uint8Array[], total: number): ArrayBuffer {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function monthStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function nextMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** The two kinds of file a reader can upload; each is a save's content_type. */
export type UploadKind = 'pdf' | 'epub';

const MIME_TYPES: Record<UploadKind, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
};

/** What an upload's file reflowed to, whichever parser read it. */
interface ParsedUpload {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  published: string | null;
  wordCount: number;
  /** Reported back: pages for a PDF, chapters for an EPUB. */
  extent: Record<string, number>;
}

type ParseOutcome = ParsedUpload | Response;

// The pdf-extractor Worker reads a PDF, and the reader's daily allowance pays.
async function parsePdfUpload(env: Env, did: string, bytes: ArrayBuffer): Promise<ParseOutcome> {
  if (!(await hasPdfAllowance(env, did))) {
    return json({ error: 'pdf_daily_limit_reached', message: PDF_QUOTA_MESSAGE }, 403);
  }
  let pdf;
  try {
    pdf = await parsePdf(env, bytes);
  } catch (err) {
    if (!(err instanceof PdfParseError)) throw err;
    if (err.charged) await chargePdfParse(env, did);
    log.warn('pdf_upload_parse_failed', { message: err.message, size: bytes.byteLength });
    return json({ error: 'pdf_unreadable', message: err.message }, err.userFacing ? 422 : 502);
  }
  await chargePdfParse(env, did);
  // A scan with no text layer reflows to nothing: there would be nothing to
  // read or highlight, so it isn't kept.
  if (!pdf.content || pdf.wordCount === 0) {
    return json(
      {
        error: 'pdf_unreadable',
        message: 'This PDF has no text Skyreader can read. It may be scanned pages.',
      },
      422
    );
  }
  return { ...pdf, extent: { pageCount: pdf.pageCount, pagesKept: pdf.pagesKept } };
}

// An EPUB is already marked-up text, read here (services/epub.ts): no extractor
// call, so no daily allowance to spend.
async function parseEpubUpload(bytes: ArrayBuffer): Promise<ParseOutcome> {
  let book;
  try {
    book = await parseEpub(bytes);
  } catch (err) {
    if (!(err instanceof EpubError)) throw err;
    log.warn('epub_upload_parse_failed', { message: err.message, size: bytes.byteLength });
    return json({ error: 'epub_unreadable', message: err.message }, 422);
  }
  if (!book.content || book.wordCount === 0) {
    return json(
      { error: 'epub_unreadable', message: 'This EPUB has no text Skyreader can read.' },
      422
    );
  }
  return {
    ...book,
    extent: { chapterCount: book.chapterCount, chaptersKept: book.chaptersKept },
  };
}

const KIND_NAMES: Record<UploadKind, string> = { pdf: 'PDF', epub: 'EPUB' };

// POST /api/saved/pdf
export function handleUploadPdf(request: Request, env: Env, session: Session) {
  return handleUpload(request, env, session, 'pdf');
}

// POST /api/saved/epub
export function handleUploadEpub(request: Request, env: Env, session: Session) {
  return handleUpload(request, env, session, 'epub');
}

async function handleUpload(request: Request, env: Env, session: Session, kind: UploadKind) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!hasRequiredScopes(session.grantedScopes)) return insufficientScopesResponse();

  const url = new URL(request.url);
  const rkey = url.searchParams.get('rkey');
  if (!rkey || !isValidRkey(rkey)) return invalidRkeyResponse();
  const filename = cleanFilename(url.searchParams.get('name'));
  const kindName = KIND_NAMES[kind];

  const limits = await getUserTierLimits(env, session.did);
  if (!limits.pdfSaves) {
    return json(
      {
        error: 'pdf_upgrade_required',
        message: kind === 'pdf' ? PDF_SUPPORTER_MESSAGE : EPUB_SUPPORTER_MESSAGE,
      },
      403
    );
  }
  if ((kind === 'pdf' && !pdfExtractorConfigured(env)) || !env.SAVED_FILES) {
    return json({ error: `Uploading ${kindName}s is not set up on this server` }, 503);
  }

  const maxBytes = kind === 'pdf' ? limits.maxPdfUploadBytes : limits.maxEpubUploadBytes;
  const tooLarge = () =>
    json(
      {
        error: 'pdf_too_large',
        message: `${kindName}s up to ${Math.round(maxBytes / (1024 * 1024))} MB can be uploaded.`,
        limit: maxBytes,
      },
      413
    );
  // Answered before a byte is read when the caller declares an over-size body;
  // the capped read below is what actually holds.
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  const bytes = await readCapped(request.body, maxBytes);
  if (bytes === null) return tooLarge();
  if (bytes.byteLength === 0) return json({ error: 'Empty file' }, 400);
  if (kind === 'pdf' && !looksLikePdf(bytes)) {
    return json({ error: 'not_a_pdf', message: "That file isn't a PDF." }, 415);
  }
  // Any zip gets as far as the parser, which knows an EPUB by its package
  // document; plenty of tools don't store the `mimetype` entry first.
  if (kind === 'epub' && !looksLikeZip(new Uint8Array(bytes))) {
    return json({ error: 'not_an_epub', message: "That file isn't an EPUB." }, 415);
  }

  const sha256 = await sha256Hex(bytes);
  const now = new Date();
  const [dupe, rkeyTaken, usage] = await env.DB.batch([
    env.DB.prepare(
      `SELECT f.rkey FROM saved_files f
       JOIN saved_articles s ON s.user_did = f.user_did AND s.rkey = f.rkey
       WHERE f.user_did = ? AND f.sha256 = ? LIMIT 1`
    ).bind(session.did, sha256),
    env.DB.prepare('SELECT 1 AS taken FROM saved_articles WHERE user_did = ? AND rkey = ?').bind(
      session.did,
      rkey
    ),
    // Stored bytes count every kept original; the monthly count, uploads only
    // (a PDF saved by link counts as a URL save). PDFs and EPUBs share both.
    env.DB.prepare(
      `SELECT COALESCE(SUM(f.size), 0) AS stored,
              COALESCE(SUM(CASE WHEN f.created_at >= ? AND s.source = 'upload' THEN 1 ELSE 0 END), 0) AS this_month
       FROM saved_files f
       LEFT JOIN saved_articles s ON s.user_did = f.user_did AND s.rkey = f.rkey
       WHERE f.user_did = ?`
    ).bind(monthStart(now), session.did),
  ]);

  // The same file again opens the save it already is (highlights and all).
  const dupeRkey = (dupe.results[0] as { rkey: string } | undefined)?.rkey;
  if (dupeRkey) {
    return json(
      { error: 'already_saved', message: `This ${kindName} is already saved.`, rkey: dupeRkey },
      409
    );
  }
  if (rkeyTaken.results.length > 0) return json({ error: 'rkey already in use' }, 409);

  const { stored, this_month } = usage.results[0] as { stored: number; this_month: number };
  if (this_month >= limits.maxPdfUploadsPerMonth) {
    return json(
      {
        error: 'pdf_upload_limit_reached',
        message: `You've uploaded ${limits.maxPdfUploadsPerMonth} files this month.`,
        limit: limits.maxPdfUploadsPerMonth,
        resetsAt: nextMonth(now),
      },
      403
    );
  }
  if (stored + bytes.byteLength > limits.maxPdfStorageBytes) {
    return json(
      {
        error: 'pdf_storage_full',
        message:
          'Your saved PDFs and EPUBs are using all of your storage. Removing some frees space.',
        limit: limits.maxPdfStorageBytes,
        used: stored,
      },
      403
    );
  }

  const parsed =
    kind === 'pdf' ? await parsePdfUpload(env, session.did, bytes) : await parseEpubUpload(bytes);
  if (parsed instanceof Response) return parsed;

  const title =
    parsed.title ||
    titleFromFilename(filename) ||
    (kind === 'pdf' ? 'Untitled PDF' : 'Untitled book');
  const publishedMs = parsed.published ? Date.parse(parsed.published) : NaN;
  const publishedAt = Number.isFinite(publishedMs) ? publishedMs : null;
  const savedAt = Date.now();
  const recordUri = `at://${session.did}/${COLLECTION}/${rkey}`;
  const r2Key = savedFileKey(session.did, rkey, kind);
  const mimeType = MIME_TYPES[kind];

  // The file first: a row pointing at a missing file is worse than a stray file.
  await env.SAVED_FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { did: session.did, rkey, ...(filename ? { filename } : {}) },
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'upload')`
      ).bind(
        session.did,
        rkey,
        recordUri,
        title,
        parsed.author,
        parsed.description,
        parsed.content,
        kind,
        parsed.wordCount,
        publishedAt,
        savedAt,
        savedAt
      ),
      env.DB.prepare(
        `INSERT INTO saved_files (user_did, rkey, r2_key, filename, mime_type, size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(session.did, rkey, r2Key, filename, mimeType, bytes.byteLength, sha256, savedAt),
    ]);
  } catch (err) {
    // r2Key is derived from (did, rkey): if a concurrent upload with the same
    // rkey won the insert, the object now belongs to its row, so keep it.
    const winner = await env.DB.prepare(
      'SELECT 1 AS x FROM saved_files WHERE user_did = ? AND rkey = ?'
    )
      .bind(session.did, rkey)
      .first()
      .catch(() => null);
    if (!winner) await env.SAVED_FILES.delete(r2Key).catch(() => {});
    throw err;
  }

  log.info(`${kind}_uploaded`, {
    size: bytes.byteLength,
    wordCount: parsed.wordCount,
    ...parsed.extent,
  });

  return json(
    {
      rkey,
      uri: recordUri,
      url: '',
      title,
      author: parsed.author,
      description: parsed.description,
      content: parsed.content,
      contentType: kind,
      domain: null,
      image: null,
      wordCount: parsed.wordCount,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      savedAt: new Date(savedAt).toISOString(),
      source: 'upload',
      // pageCount/pagesKept for a PDF, chapterCount/chaptersKept for an EPUB:
      // the kept count is less when a cap (1 MB of text) cut the reflow short.
      ...parsed.extent,
    },
    201
  );
}

// Largest PDF the viewer route will relay for a save made by link. Nothing parses
// it here (the browser draws it), so it can be bigger than a parse allows. It's
// streamed through, so the cap bounds the transfer, not what the Worker holds.
const MAX_RELAYED_PDF_BYTES = 30 * 1024 * 1024;
const RELAY_TIMEOUT_MS = 20_000;

function fileResponse(
  body: BodyInit,
  filename: string,
  size?: number,
  contentType = 'application/pdf'
): Response {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    // RFC 5987, so a non-ASCII filename survives; the plain one is the fallback.
    'Content-Disposition': `inline; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  if (size !== undefined) headers['Content-Length'] = String(size);
  return new Response(body, { headers });
}

/**
 * A PDF saved by link, from its own URL. The Worker's fetch reaches only the
 * public internet (global_fetch_strictly_public), and the URL is one this reader
 * saved.
 */
function fetchFromSite(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: 'application/pdf,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (compatible; Skyreader/1.0; +https://skyreader.app)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
}

// The filename a PDF saved by link is served under: its URL's last segment.
function linkedPdfFilename(url: string): string {
  let path = new URL(url).pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape: name it by the raw path.
  }
  const name = cleanFilename(path) || 'document.pdf';
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

interface LinkedPdfSave {
  rkey: string;
  url: string;
}

function isLinkedPdf(
  row: { url: string; content_type: string | null; source: string | null } | null
): boolean {
  return Boolean(
    row && row.content_type === 'pdf' && row.source !== 'upload' && /^https?:\/\//i.test(row.url)
  );
}

export type StoreLinkedPdfResult = 'stored' | 'storage_full' | 'unavailable';

/**
 * Keep the original of a PDF saved by link in R2, as an upload's is kept. Run
 * after the save (under waitUntil), and again on first open for a save that
 * predates this or whose fetch failed then. Same plan limits as an upload: the
 * file size (the extractor's cap, so any PDF that was read fits) and the stored
 * bytes. It isn't an upload, so the monthly upload count doesn't apply.
 */
async function storeLinkedPdf(
  env: Env,
  did: string,
  save: LinkedPdfSave
): Promise<StoreLinkedPdfResult> {
  if (!env.SAVED_FILES) return 'unavailable';
  const limits = await getUserTierLimits(env, did);
  if (!limits.pdfSaves) return 'unavailable';

  const [existing, usage] = await env.DB.batch([
    env.DB.prepare('SELECT 1 AS x FROM saved_files WHERE user_did = ? AND rkey = ?').bind(
      did,
      save.rkey
    ),
    env.DB.prepare(
      'SELECT COALESCE(SUM(size), 0) AS stored FROM saved_files WHERE user_did = ?'
    ).bind(did),
  ]);
  if (existing.results.length > 0) return 'stored';
  const { stored } = usage.results[0] as { stored: number };
  if (stored >= limits.maxPdfStorageBytes) return 'storage_full';

  let upstream: Response;
  try {
    upstream = await fetchFromSite(save.url);
  } catch {
    return 'unavailable';
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    return 'unavailable';
  }
  const bytes = await readCapped(upstream.body, limits.maxPdfUploadBytes).catch(() => null);
  if (!bytes || bytes.byteLength === 0 || !looksLikePdf(bytes)) return 'unavailable';
  if (stored + bytes.byteLength > limits.maxPdfStorageBytes) return 'storage_full';

  const r2Key = savedFileKey(did, save.rkey);
  const filename = linkedPdfFilename(save.url);
  await env.SAVED_FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { did, rkey: save.rkey, filename },
  });
  // OR IGNORE: two opens racing to store the same save write the same key.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO saved_files (user_did, rkey, r2_key, filename, mime_type, size, sha256, created_at)
     SELECT ?, ?, ?, ?, 'application/pdf', ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM saved_articles WHERE user_did = ? AND rkey = ?)`
  )
    .bind(
      did,
      save.rkey,
      r2Key,
      filename,
      bytes.byteLength,
      await sha256Hex(bytes),
      Date.now(),
      did,
      save.rkey
    )
    .run();
  if (!inserted.meta.changes) {
    // Deleted while we fetched: don't leave its file behind. (A lost race to
    // another store keeps the key, which that row now owns.)
    const owned = await env.DB.prepare(
      'SELECT 1 AS x FROM saved_files WHERE user_did = ? AND rkey = ?'
    )
      .bind(did, save.rkey)
      .first();
    if (!owned) await env.SAVED_FILES.delete(r2Key).catch(() => {});
    return owned ? 'stored' : 'unavailable';
  }
  log.info('pdf_link_original_stored', { size: bytes.byteLength });
  return 'stored';
}

/**
 * After a PDF is saved by link: keep its original. Looked up by URL, since a
 * re-save or a backed save lands on whichever row already holds the URL.
 */
export async function storeLinkedPdfForUrl(env: Env, did: string, url: string): Promise<void> {
  try {
    const row = await env.DB.prepare(
      'SELECT rkey, url, content_type, source FROM saved_articles WHERE user_did = ? AND url = ?'
    )
      .bind(did, url)
      .first<{ rkey: string; url: string; content_type: string | null; source: string | null }>();
    if (!row || !isLinkedPdf(row)) return;
    const result = await storeLinkedPdf(env, did, row);
    if (result !== 'stored') log.info('pdf_link_original_not_stored', { reason: result });
  } catch (error) {
    log.warn('pdf_link_original_store_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The original of a PDF saved by link with no kept file yet. Kept now and served
 * from storage; only when the reader's storage is full is it streamed through
 * from the site instead (the browser can't fetch most PDFs itself: no CORS).
 * Supporter, like PDFs.
 */
async function relayLinkedPdf(env: Env, session: Session, rkey: string): Promise<Response> {
  const save = await env.DB.prepare(
    'SELECT url, content_type, source FROM saved_articles WHERE user_did = ? AND rkey = ?'
  )
    .bind(session.did, rkey)
    .first<{ url: string; content_type: string | null; source: string | null }>();
  if (!save || !isLinkedPdf(save)) {
    return json({ error: 'Not found' }, 404);
  }
  if (!(await getUserTierLimits(env, session.did)).pdfSaves) {
    return json({ error: 'pdf_upgrade_required', message: PDF_SUPPORTER_MESSAGE }, 403);
  }

  // Kept now if it can be (a save from before originals were kept, or one whose
  // fetch failed at save time), then served from storage like any other.
  const kept = await storeLinkedPdf(env, session.did, { rkey, url: save.url });
  if (kept === 'stored') {
    return (await serveStoredFile(env, session.did, rkey)) ?? json({ error: 'Not found' }, 404);
  }
  if (kept === 'unavailable') return json({ error: "Couldn't fetch the PDF from its site." }, 502);

  // Storage is full: show it anyway, streamed through without keeping it.
  let upstream: Response;
  try {
    upstream = await fetchFromSite(save.url);
  } catch {
    return json({ error: "Couldn't fetch the PDF from its site." }, 502);
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    return json({ error: "Couldn't fetch the PDF from its site.", status: upstream.status }, 502);
  }
  const declared = Number(upstream.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_RELAYED_PDF_BYTES) {
    await upstream.body?.cancel().catch(() => {});
    return json({ error: 'This PDF is too large to show.' }, 413);
  }
  if (!upstream.body) return json({ error: "That link doesn't serve a PDF now." }, 502);

  // Hold only the head (enough to find the signature), then stream the rest
  // through, so one request costs a chunk of memory rather than the whole file.
  const reader = upstream.body.getReader();
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let ended = false;
  try {
    while (headBytes < PDF_SIGNATURE_WINDOW) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      head.push(value);
      headBytes += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => {});
    return json({ error: "Couldn't fetch the PDF from its site." }, 502);
  }
  if (!looksLikePdf(concatChunks(head, headBytes))) {
    await reader.cancel().catch(() => {});
    return json({ error: "That link doesn't serve a PDF now." }, 502);
  }

  // A body with no (or a lying) Content-Length is still capped: past the limit
  // the stream errors and the reader gets a truncated file, not a held isolate.
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
      sent = headBytes;
      if (ended) controller.close();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        sent += value.byteLength;
        if (sent > MAX_RELAYED_PDF_BYTES) {
          await reader.cancel().catch(() => {});
          return controller.error(new Error('relayed PDF over the size cap'));
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return fileResponse(body, linkedPdfFilename(save.url));
}

// GET /api/saved/<rkey>/file — the original, only ever to the reader who saved it:
// the kept file (an upload's, or a link save's), else the link save's, kept now.
export async function handleGetSavedFile(request: Request, env: Env, session: Session) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const rkey = new URL(request.url).pathname.split('/')[3];
  if (!rkey || !isValidRkey(rkey)) return invalidRkeyResponse();

  return (await serveStoredFile(env, session.did, rkey)) ?? relayLinkedPdf(env, session, rkey);
}

// A save's kept original, or null when it has none.
async function serveStoredFile(env: Env, did: string, rkey: string): Promise<Response | null> {
  const row = await env.DB.prepare(
    'SELECT r2_key, filename, mime_type FROM saved_files WHERE user_did = ? AND rkey = ?'
  )
    .bind(did, rkey)
    .first<{ r2_key: string; filename: string | null; mime_type: string }>();
  if (!row) return null;
  const object = env.SAVED_FILES ? await env.SAVED_FILES.get(row.r2_key) : null;
  if (!object) return json({ error: 'Not found' }, 404);
  const fallbackName = row.mime_type === MIME_TYPES.epub ? 'book.epub' : 'document.pdf';
  return fileResponse(object.body, row.filename || fallbackName, object.size, row.mime_type);
}

/** Drop a save's uploaded file, if it has one. Called after the save's row is deleted. */
export async function deleteSavedFile(env: Env, did: string, rkey: string): Promise<void> {
  const row = await env.DB.prepare('SELECT r2_key FROM saved_files WHERE user_did = ? AND rkey = ?')
    .bind(did, rkey)
    .first<{ r2_key: string }>();
  if (!row) return;
  await env.DB.prepare('DELETE FROM saved_files WHERE user_did = ? AND rkey = ?')
    .bind(did, rkey)
    .run();
  try {
    await env.SAVED_FILES?.delete(row.r2_key);
  } catch (error) {
    // The row is gone, so the bytes no longer count against the reader; an
    // orphaned object costs storage, not correctness.
    log.error('saved_file_delete_failed', { rkey, error: String(error) });
  }
}
