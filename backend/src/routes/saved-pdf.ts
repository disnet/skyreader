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
import {
  EpubError,
  epubImageType,
  looksLikeZip,
  parseEpub,
  readStoredEpubEntry,
} from '../services/epub';
import { readStagedOriginal } from '../services/linked-originals';
import {
  STORED_FILE_COLUMNS,
  STORED_FILE_PLACEHOLDERS,
  savedFileStore,
  storeFor,
  storedFileBindings,
  storedFileRef,
  type SavedFileStore,
  type StoredFileBody,
  type StoredFileColumns,
  type StoredFileRef,
} from '../services/saved-file-store';
import { log } from '../utils/logger';
import { captureSnapshot } from '../services/archive/snapshots';
import { storedFileBytes } from '../services/archive/snapshot-images';

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
 * equations a reflow can't carry; saved_files says which store holds it
 * (services/saved-file-store.ts, the only way a kept original is read, written
 * or deleted).
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
 * month, total bytes stored (every kept original, however it was saved, and
 * every picture a snapshot kept: services/archive/snapshot-images.ts). A
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

export { savedFileKey } from '../services/saved-file-store';

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

function looksLikePdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, PDF_SIGNATURE_WINDOW);
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  outer: for (let i = 0; i + sig.length <= head.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (head[i + j] !== sig[j]) continue outer;
    }
    return true;
  }
  return false;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Why a file was turned away on its way into the store. */
class FileRejected extends Error {
  constructor(readonly reason: 'too_large' | 'wrong_type' | 'empty') {
    super(`file rejected: ${reason}`);
    this.name = 'FileRejected';
  }
}

/**
 * A file's bytes on their way to the store, checked as they pass, so it is
 * never held whole: past `maxBytes`, empty, or not starting like a `kind`, the
 * stream errors with FileRejected and the store keeps nothing. `done` gives the
 * size and SHA-256 once the last byte has gone through.
 */
function checkedFile(body: ReadableStream<Uint8Array>, kind: UploadKind, maxBytes: number) {
  const digest = new crypto.DigestStream('SHA-256');
  const hasher = digest.getWriter();
  const head = new Uint8Array(PDF_SIGNATURE_WINDOW);
  let headBytes = 0;
  let checked = false;
  let size = 0;
  const checkHead = () => {
    checked = true;
    const bytes = head.subarray(0, headBytes);
    if (!(kind === 'pdf' ? looksLikePdf(bytes) : looksLikeZip(bytes))) {
      throw new FileRejected('wrong_type');
    }
  };
  const reader = body.getReader();
  const step = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const { done, value } = await reader.read();
    if (done) {
      if (size === 0) throw new FileRejected('empty');
      if (!checked) checkHead();
      await hasher.close();
      return controller.close();
    }
    size += value.byteLength;
    if (size > maxBytes) throw new FileRejected('too_large');
    if (!checked) {
      const n = Math.min(value.byteLength, head.length - headBytes);
      head.set(value.subarray(0, n), headBytes);
      headBytes += n;
      if (headBytes === head.length) checkHead();
    }
    await hasher.write(value);
    controller.enqueue(value);
  };
  // Pulled by the store, so it reads the source only as fast as the store writes.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await step(controller);
      } catch (err) {
        // Refused or failed: stop pulling the source too.
        await reader.cancel(err).catch(() => {});
        throw err;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const done = async () => ({ size, sha256: toHex(await digest.digest) });
  return { stream, done };
}

function toHex(digest: ArrayBuffer): string {
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

// The pdf-extractor Worker reads a PDF, streamed to it from the store, and the
// reader's daily allowance (checked before the upload was taken) pays.
async function parsePdfUpload(env: Env, did: string, file: StoredFileBody): Promise<ParseOutcome> {
  let pdf;
  try {
    pdf = await parsePdf(env, file);
  } catch (err) {
    if (!(err instanceof PdfParseError)) throw err;
    if (err.charged) await chargePdfParse(env, did);
    log.warn('pdf_upload_parse_failed', { message: err.message, size: file.size });
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
  const store = savedFileStore(env);
  if ((kind === 'pdf' && !pdfExtractorConfigured(env)) || !store) {
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
  const storageFull = (used: number) =>
    json(
      {
        error: 'pdf_storage_full',
        message:
          'Your saved PDFs, EPUBs and article pictures are using all of your storage. Removing some saves frees space.',
        limit: limits.maxPdfStorageBytes,
        used,
      },
      403
    );
  // Answered before a byte is read when the caller declares an over-size body;
  // the checked stream below is what actually holds.
  const declaredHeader = request.headers.get('Content-Length');
  const declared = declaredHeader === null ? NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (!request.body || declared === 0) return json({ error: 'Empty file' }, 400);

  // Everything that can refuse the upload without its bytes is asked first, so
  // a refused file isn't streamed in only to be thrown away.
  const now = new Date();
  const [rkeyTaken, usage] = await env.DB.batch([
    env.DB.prepare('SELECT 1 AS taken FROM saved_articles WHERE user_did = ? AND rkey = ?').bind(
      session.did,
      rkey
    ),
    // The monthly count is uploads only (a PDF saved by link counts as a URL
    // save). PDFs and EPUBs share it.
    env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN f.created_at >= ? AND s.source = 'upload' THEN 1 ELSE 0 END), 0) AS this_month
       FROM saved_files f
       LEFT JOIN saved_articles s ON s.user_did = f.user_did AND s.rkey = f.rkey
       WHERE f.user_did = ?`
    ).bind(monthStart(now), session.did),
  ]);
  // Also what keeps the stream below from landing on another save's file: an
  // upload is kept where its rkey says.
  if (rkeyTaken.results.length > 0) return json({ error: 'rkey already in use' }, 409);

  const { this_month } = usage.results[0] as { this_month: number };
  // Stored bytes count every kept original and every snapshot picture.
  const stored = await storedFileBytes(env, session.did);
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
  if (stored + (Number.isFinite(declared) ? declared : 1) > limits.maxPdfStorageBytes) {
    return storageFull(stored);
  }
  if (kind === 'pdf' && !(await hasPdfAllowance(env, session.did))) {
    return json({ error: 'pdf_daily_limit_reached', message: PDF_QUOTA_MESSAGE }, 403);
  }

  // The file streams into the store as it arrives, checked on the way, so the
  // Worker holds a part of it at a time rather than the whole thing. From here
  // on, any refusal deletes what was kept.
  const mimeType = MIME_TYPES[kind];
  const checked = checkedFile(request.body, kind, maxBytes);
  let file: StoredFileRef;
  try {
    file = await store.put({ did: session.did, rkey, kind, mimeType, filename }, checked.stream);
  } catch (err) {
    if (!(err instanceof FileRejected)) throw err;
    if (err.reason === 'too_large') return tooLarge();
    if (err.reason === 'empty') return json({ error: 'Empty file' }, 400);
    return kind === 'pdf'
      ? json({ error: 'not_a_pdf', message: "That file isn't a PDF." }, 415)
      : json({ error: 'not_an_epub', message: "That file isn't an EPUB." }, 415);
  }
  const { size, sha256 } = await checked.done();
  const discard = async (response: Response) => {
    await store.delete(file).catch(() => {});
    return response;
  };

  // The same file again opens the save it already is (highlights and all).
  const dupe = await env.DB.prepare(
    `SELECT f.rkey FROM saved_files f
     JOIN saved_articles s ON s.user_did = f.user_did AND s.rkey = f.rkey
     WHERE f.user_did = ? AND f.sha256 = ? LIMIT 1`
  )
    .bind(session.did, sha256)
    .first<{ rkey: string }>();
  if (dupe) {
    return discard(
      json(
        { error: 'already_saved', message: `This ${kindName} is already saved.`, rkey: dupe.rkey },
        409
      )
    );
  }
  if (stored + size > limits.maxPdfStorageBytes) return discard(storageFull(stored));

  let parsed: ParseOutcome;
  try {
    const kept = await store.get(file);
    if (!kept) throw new Error('upload missing from the store just after it was kept');
    parsed =
      kind === 'pdf'
        ? await parsePdfUpload(env, session.did, kept)
        : await parseEpubUpload(await new Response(kept.body).arrayBuffer());
  } catch (err) {
    await store.delete(file).catch(() => {});
    throw err;
  }
  if (parsed instanceof Response) return discard(parsed);

  const title =
    parsed.title ||
    titleFromFilename(filename) ||
    (kind === 'pdf' ? 'Untitled PDF' : 'Untitled book');
  const publishedMs = parsed.published ? Date.parse(parsed.published) : NaN;
  const publishedAt = Number.isFinite(publishedMs) ? publishedMs : null;
  const savedAt = Date.now();
  const recordUri = `at://${session.did}/${COLLECTION}/${rkey}`;

  // The file is already kept: a row pointing at a missing file is worse than a
  // stray file.
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_key, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source)
         VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'upload')`
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
        `INSERT INTO saved_files (user_did, rkey, ${STORED_FILE_COLUMNS}, filename, mime_type, size, sha256, created_at)
         VALUES (?, ?, ${STORED_FILE_PLACEHOLDERS}, ?, ?, ?, ?, ?)`
      ).bind(
        session.did,
        rkey,
        ...storedFileBindings(file),
        filename,
        mimeType,
        size,
        sha256,
        savedAt
      ),
    ]);
  } catch (err) {
    // A save's file always lands in the same place: if a concurrent upload with
    // the same rkey won the insert, the file now belongs to its row, so keep it.
    const winner = await env.DB.prepare(
      'SELECT 1 AS x FROM saved_files WHERE user_did = ? AND rkey = ?'
    )
      .bind(session.did, rkey)
      .first()
      .catch(() => null);
    if (!winner) await store.delete(file).catch(() => {});
    throw err;
  }

  // The text read from the file is the save's first capture; the file itself
  // is already kept above.
  await captureSnapshot(env, {
    did: session.did,
    saveRkey: rkey,
    url: '',
    body: parsed.content,
    method: 'upload',
  });

  log.info(`${kind}_uploaded`, {
    size,
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

// Largest PDF the viewer route will relay for a save made by link: the most a
// Supporter can upload, so any PDF that could be read can be shown. It's
// streamed through, so the cap bounds the transfer, not what the Worker holds.
const MAX_RELAYED_PDF_BYTES = 50 * 1024 * 1024;
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
function fetchFromSite(url: string, kind: UploadKind = 'pdf'): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: `${MIME_TYPES[kind]},*/*;q=0.8`,
      'User-Agent': 'Mozilla/5.0 (compatible; Skyreader/1.0; +https://skyreader.app)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
}

// The filename a file saved by link is served under: its URL's last segment.
function linkedFilename(url: string, kind: UploadKind = 'pdf'): string {
  let path = new URL(url).pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape: name it by the raw path.
  }
  const name = cleanFilename(path) || (kind === 'pdf' ? 'document.pdf' : 'book.epub');
  return name.toLowerCase().endsWith(`.${kind}`) ? name : `${name}.${kind}`;
}

interface LinkedSave {
  rkey: string;
  url: string;
  kind: UploadKind;
}

/** A PDF or EPUB saved by link (not uploaded): which, or null for anything else. */
function linkedKind(
  row: { url: string; content_type: string | null; source: string | null } | null
): UploadKind | null {
  if (!row || row.source === 'upload' || !/^https?:\/\//i.test(row.url)) return null;
  return row.content_type === 'pdf' || row.content_type === 'epub' ? row.content_type : null;
}

export type StoreLinkedResult = 'stored' | 'storage_full' | 'unavailable';

/**
 * Keep the original of a PDF or EPUB saved by link in R2, as an upload's is
 * kept: a PDF's for the Original view, an EPUB's for its pictures. Run after
 * the save (under waitUntil), and again on first open for a save that predates
 * this or whose fetch failed then. Same plan limits as an upload: the file size
 * (the parse's cap, so any file that was read fits) and the stored bytes. It
 * isn't an upload, so the monthly upload count doesn't apply.
 */
async function storeLinkedOriginal(
  env: Env,
  did: string,
  save: LinkedSave
): Promise<StoreLinkedResult> {
  const store = savedFileStore(env);
  if (!store) return 'unavailable';
  const limits = await getUserTierLimits(env, did);
  if (!limits.pdfSaves) return 'unavailable';

  const existing = await env.DB.prepare(
    'SELECT 1 AS x FROM saved_files WHERE user_did = ? AND rkey = ?'
  )
    .bind(did, save.rkey)
    .first();
  if (existing) return 'stored';
  const stored = await storedFileBytes(env, did);
  if (stored >= limits.maxPdfStorageBytes) return 'storage_full';

  if (save.kind === 'epub') {
    const adopted = await adoptStagedOriginal(
      env,
      store,
      did,
      save,
      stored,
      limits.maxPdfStorageBytes
    );
    if (adopted) return adopted;
  }

  let upstream: Response;
  try {
    upstream = await fetchFromSite(save.url, save.kind);
  } catch {
    return 'unavailable';
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    return 'unavailable';
  }
  const maxBytes = save.kind === 'pdf' ? limits.maxPdfUploadBytes : limits.maxEpubUploadBytes;
  if (!upstream.body || Number(upstream.headers.get('Content-Length')) > maxBytes) {
    await upstream.body?.cancel().catch(() => {});
    return 'unavailable';
  }
  // Streamed into the store, checked on the way (as an upload is), so the
  // Worker never holds the whole file.
  const checked = checkedFile(upstream.body, save.kind, maxBytes);
  let file: StoredFileRef;
  try {
    file = await store.put(linkedFileMeta(did, save), checked.stream);
  } catch {
    return 'unavailable';
  }
  const { size, sha256 } = await checked.done();
  if (stored + size > limits.maxPdfStorageBytes) {
    await store.delete(file).catch(() => {});
    return 'storage_full';
  }

  const result = await recordLinkedOriginal(env, store, did, save, { ref: file, size, sha256 });
  if (result === 'stored') log.info(`${save.kind}_link_original_stored`, { size });
  return result;
}

/** How a linked save's original is labelled in its store. */
function linkedFileMeta(did: string, save: LinkedSave) {
  return {
    did,
    rkey: save.rkey,
    kind: save.kind,
    mimeType: MIME_TYPES[save.kind],
    filename: linkedFilename(save.url, save.kind),
  };
}

/**
 * The saved_files row for a linked save's kept original, once it's in `store`
 * at `file.ref`. Undone (the file deleted) when the save went away meanwhile.
 */
async function recordLinkedOriginal(
  env: Env,
  store: SavedFileStore,
  did: string,
  save: LinkedSave,
  file: { ref: StoredFileRef; size: number; sha256: string }
): Promise<StoreLinkedResult> {
  const filename = linkedFilename(save.url, save.kind);
  const mimeType = MIME_TYPES[save.kind];
  // OR IGNORE: two opens racing to store the same save write the same place.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO saved_files (user_did, rkey, ${STORED_FILE_COLUMNS}, filename, mime_type, size, sha256, created_at)
     SELECT ?, ?, ${STORED_FILE_PLACEHOLDERS}, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM saved_articles WHERE user_did = ? AND rkey = ?)`
  )
    .bind(
      did,
      save.rkey,
      ...storedFileBindings(file.ref),
      filename,
      mimeType,
      file.size,
      file.sha256,
      Date.now(),
      did,
      save.rkey
    )
    .run();
  if (!inserted.meta.changes) {
    // Deleted while we fetched: don't leave its file behind. (A lost race to
    // another keep leaves the file, which that row now owns.)
    const owned = await env.DB.prepare(
      'SELECT 1 AS x FROM saved_files WHERE user_did = ? AND rkey = ?'
    )
      .bind(did, save.rkey)
      .first();
    if (!owned) await store.delete(file.ref).catch(() => {});
    return owned ? 'stored' : 'unavailable';
  }
  return 'stored';
}

/**
 * A linked book already read by /api/extract was staged then
 * (services/linked-originals.ts): move it into place rather than download it a
 * second time. Null when nothing is staged (the save fetches the book itself).
 */
async function adoptStagedOriginal(
  env: Env,
  store: SavedFileStore,
  did: string,
  save: LinkedSave,
  stored: number,
  maxStorageBytes: number
): Promise<StoreLinkedResult | null> {
  const staged = await readStagedOriginal(env, did, save.url);
  if (!staged) return null;
  if (stored + staged.size > maxStorageBytes) {
    await staged.body.cancel().catch(() => {});
    return 'storage_full';
  }
  const file = await store.put(linkedFileMeta(did, save), staged);
  await staged.remove().catch(() => {});
  const result = await recordLinkedOriginal(env, store, did, save, {
    ref: file,
    size: staged.size,
    sha256: staged.sha256,
  });
  if (result === 'stored') log.info('epub_link_original_adopted', { size: staged.size });
  return result;
}

// Opens in this isolate that are already keeping a save's original.
const keeping = new Map<string, Promise<StoreLinkedResult>>();
// A minute is long enough for one fetch of the book (RELAY_TIMEOUT_MS).
const KEEP_CLAIM_WINDOW_MS = 60_000;
const KEEP_WAIT_MS = 25_000;
const KEEP_POLL_MS = 1_000;

/**
 * storeLinkedOriginal for a book's pictures, which all ask at once: one fetch
 * per save, not one per picture. Requests in this isolate share the attempt;
 * across isolates a D1 claim (one a minute per save, in rate_limits, swept with
 * it) picks the one that fetches, and the rest wait for its outcome: the kept
 * row, or the failure it records. A failed attempt isn't retried until the claim
 * window turns over, so a site that's gone costs one fetch a minute, not one
 * per picture per open.
 */
async function keepLinkedOriginalOnce(
  env: Env,
  did: string,
  save: LinkedSave
): Promise<StoreLinkedResult> {
  const id = `${did} ${save.rkey}`;
  const pending = keeping.get(id);
  if (pending) return pending;
  const attempt = (async (): Promise<StoreLinkedResult> => {
    const windowStart = Math.floor(Date.now() / KEEP_CLAIM_WINDOW_MS) * KEEP_CLAIM_WINDOW_MS;
    const claimKey = `epub-original:${save.rkey}`;
    // The outcome of a failed attempt this window: 1 unavailable, 2 storage full.
    const outcomeKey = `epub-original-failed:${save.rkey}`;
    const claim = await env.DB.prepare(
      `INSERT INTO rate_limits (did, endpoint, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(did, endpoint, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    )
      .bind(did, claimKey, windowStart)
      .first<{ count: number }>();
    if ((claim?.count ?? 1) === 1) {
      const result = await storeLinkedOriginal(env, did, save);
      if (result !== 'stored') {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO rate_limits (did, endpoint, window_start, count) VALUES (?, ?, ?, ?)`
        )
          .bind(did, outcomeKey, windowStart, result === 'storage_full' ? 2 : 1)
          .run();
      }
      return result;
    }
    // Another request is fetching (or just tried): wait for how it went.
    const deadline = Date.now() + KEEP_WAIT_MS;
    for (;;) {
      const [kept, failed] = await env.DB.batch([
        env.DB.prepare('SELECT 1 AS x FROM saved_files WHERE user_did = ? AND rkey = ?').bind(
          did,
          save.rkey
        ),
        env.DB.prepare(
          'SELECT count FROM rate_limits WHERE did = ? AND endpoint = ? AND window_start = ?'
        ).bind(did, outcomeKey, windowStart),
      ]);
      if (kept.results.length) return 'stored';
      const outcome = (failed.results[0] as { count: number } | undefined)?.count;
      if (outcome) return outcome === 2 ? 'storage_full' : 'unavailable';
      if (Date.now() >= deadline) return 'unavailable';
      await new Promise((resolve) => setTimeout(resolve, KEEP_POLL_MS));
    }
  })();
  keeping.set(id, attempt);
  try {
    return await attempt;
  } finally {
    keeping.delete(id);
  }
}

/**
 * After a PDF or EPUB is saved by link: keep its original. Looked up by URL,
 * since a re-save or a backed save lands on whichever row already holds the URL.
 */
export async function storeLinkedOriginalForUrl(env: Env, did: string, url: string): Promise<void> {
  try {
    const row = await env.DB.prepare(
      'SELECT rkey, url, content_type, source FROM saved_articles WHERE user_did = ? AND url = ?'
    )
      .bind(did, url)
      .first<{ rkey: string; url: string; content_type: string | null; source: string | null }>();
    const kind = linkedKind(row);
    if (!row || !kind) return;
    const result = await storeLinkedOriginal(env, did, { ...row, kind });
    if (result !== 'stored') log.info(`${kind}_link_original_not_stored`, { reason: result });
  } catch (error) {
    log.warn('link_original_store_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The original of a PDF or EPUB saved by link with no kept file yet. Kept now
 * and served from storage; only when the reader's storage is full is a PDF
 * streamed through from the site instead (the browser can't fetch most PDFs
 * itself: no CORS). Supporter, like PDFs.
 */
async function relayLinkedOriginal(env: Env, session: Session, rkey: string): Promise<Response> {
  const save = await env.DB.prepare(
    'SELECT url, content_type, source FROM saved_articles WHERE user_did = ? AND rkey = ?'
  )
    .bind(session.did, rkey)
    .first<{ url: string; content_type: string | null; source: string | null }>();
  const kind = linkedKind(save);
  if (!save || !kind) {
    return json({ error: 'Not found' }, 404);
  }
  if (!(await getUserTierLimits(env, session.did)).pdfSaves) {
    return json({ error: 'pdf_upgrade_required', message: PDF_SUPPORTER_MESSAGE }, 403);
  }

  // Kept now if it can be (a save from before originals were kept, or one whose
  // fetch failed at save time), then served from storage like any other.
  const kept = await storeLinkedOriginal(env, session.did, { rkey, url: save.url, kind });
  if (kept === 'stored') {
    return (await serveStoredFile(env, session.did, rkey)) ?? json({ error: 'Not found' }, 404);
  }
  const kindName = KIND_NAMES[kind];
  if (kept === 'unavailable') {
    return json({ error: `Couldn't fetch the ${kindName} from its site.` }, 502);
  }
  // A book is only kept, never relayed: its pictures are read out of the kept copy.
  if (kind === 'epub') return storageFullResponse();

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
  return fileResponse(body, linkedFilename(save.url));
}

// GET /api/saved/<rkey>/file — the original, only ever to the reader who saved it:
// the kept file (an upload's, or a link save's), else the link save's, kept now.
export async function handleGetSavedFile(request: Request, env: Env, session: Session) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const rkey = new URL(request.url).pathname.split('/')[3];
  if (!rkey || !isValidRkey(rkey)) return invalidRkeyResponse();

  return (await serveStoredFile(env, session.did, rkey)) ?? relayLinkedOriginal(env, session, rkey);
}

// Pictures are served sandboxed: an SVG from a book is the book's markup, and
// opened directly it must not run as a page on the API's origin.
const ASSET_HEADERS = {
  'Cache-Control': 'private, max-age=86400',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
};

// GET /api/saved/<rkey>/asset?path=<entry> — a picture inside a saved EPUB, read
// out of its kept original (services/epub.ts readStoredEpubEntry), only ever to
// the reader who saved it. The reader's text carries each picture's path
// (`data-epub-src`), and the reader asks for it here.
export async function handleGetSavedAsset(request: Request, env: Env, session: Session) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const url = new URL(request.url);
  const rkey = url.pathname.split('/')[3];
  if (!rkey || !isValidRkey(rkey)) return invalidRkeyResponse();
  const path = url.searchParams.get('path') ?? '';
  const contentType = epubImageType(path);
  if (!contentType || !savedFileStore(env)) return json({ error: 'Not found' }, 404);

  const fileRow = () =>
    env.DB.prepare(
      `SELECT ${STORED_FILE_COLUMNS}, mime_type FROM saved_files WHERE user_did = ? AND rkey = ?`
    )
      .bind(session.did, rkey)
      .first<StoredFileColumns & { mime_type: string }>();
  let row = await fileRow();
  if (!row) {
    // A book saved by link whose original wasn't kept at save time (the fetch
    // failed then): keep it now, as opening a PDF's Original does.
    const save = await env.DB.prepare(
      'SELECT url, content_type, source FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(session.did, rkey)
      .first<{ url: string; content_type: string | null; source: string | null }>();
    if (save && linkedKind(save) === 'epub') {
      const kept = await keepLinkedOriginalOnce(env, session.did, {
        rkey,
        url: save.url,
        kind: 'epub',
      });
      // Never relayed (each picture would download the whole book): say why the
      // pictures are missing, so the reader can tell the reader.
      if (kept === 'storage_full') return storageFullResponse();
      row = await fileRow();
    }
  }
  if (!row || row.mime_type !== MIME_TYPES.epub) return json({ error: 'Not found' }, 404);
  const ref = storedFileRef(row);
  const store = storeFor(env, ref);
  if (!store) return json({ error: 'Not found' }, 404);

  let bytes: Uint8Array | null;
  try {
    bytes = await readStoredEpubEntry(
      {
        size: () => store.size(ref),
        read: (offset, length) => store.readRange(ref, offset, length),
      },
      path
    );
  } catch (err) {
    if (!(err instanceof EpubError)) throw err;
    log.warn('epub_asset_unreadable', { message: err.message });
    bytes = null;
  }
  if (!bytes) return json({ error: 'Not found' }, 404);
  return new Response(bytes, {
    headers: {
      ...ASSET_HEADERS,
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
    },
  });
}

function storageFullResponse(): Response {
  return json({ error: 'pdf_storage_full', message: 'Your storage for saved files is full.' }, 403);
}

// A save's kept original, or null when it has none.
async function serveStoredFile(env: Env, did: string, rkey: string): Promise<Response | null> {
  const row = await env.DB.prepare(
    `SELECT ${STORED_FILE_COLUMNS}, filename, mime_type FROM saved_files WHERE user_did = ? AND rkey = ?`
  )
    .bind(did, rkey)
    .first<StoredFileColumns & { filename: string | null; mime_type: string }>();
  if (!row) return null;
  const ref = storedFileRef(row);
  const object = (await storeFor(env, ref)?.get(ref)) ?? null;
  if (!object) return json({ error: 'Not found' }, 404);
  const fallbackName = row.mime_type === MIME_TYPES.epub ? 'book.epub' : 'document.pdf';
  return fileResponse(object.body, row.filename || fallbackName, object.size, row.mime_type);
}

/** Drop a save's uploaded file, if it has one. Called after the save's row is deleted. */
export async function deleteSavedFile(env: Env, did: string, rkey: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT ${STORED_FILE_COLUMNS} FROM saved_files WHERE user_did = ? AND rkey = ?`
  )
    .bind(did, rkey)
    .first<StoredFileColumns>();
  if (!row) return;
  const ref = storedFileRef(row);
  await env.DB.prepare('DELETE FROM saved_files WHERE user_did = ? AND rkey = ?')
    .bind(did, rkey)
    .run();
  try {
    const store = storeFor(env, ref);
    if (store) await store.delete(ref);
    else log.warn('saved_file_store_unreachable', { rkey, storage: ref.storage });
  } catch (error) {
    // The row is gone, so the bytes no longer count against the reader; an
    // orphaned object costs storage, not correctness.
    log.error('saved_file_delete_failed', { rkey, error: String(error) });
  }
}
