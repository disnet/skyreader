import type { Env, Session } from '../types';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import { getUserTierLimits } from '../services/user-tier';
import {
  PDF_QUOTA_MESSAGE,
  PDF_SUPPORTER_MESSAGE,
  chargePdfParse,
  hasPdfAllowance,
} from '../services/pdf-quota';
import { PdfParseError, parsePdf, pdfExtractorConfigured } from '../services/pdf-extractor';
import { readCapped } from './feedback';
import { log } from '../utils/logger';

/**
 * Uploaded PDFs (Supporter).
 *
 *   POST /api/saved/pdf?rkey=<tid>&name=<filename>   body: the PDF's bytes
 *   GET  /api/saved/<rkey>/file                      the original, to its owner
 *
 * An upload becomes an ordinary save: a saved_articles row with source 'upload',
 * content_type 'pdf', no URL, and the PDF's text reflowed into reader HTML by the
 * pdf-extractor Worker — so highlights, notes, search and read state work on it
 * exactly as on any other save (they key on the save's record uri). The original
 * file is kept in R2 (SAVED_FILES), private to the reader, for the figures and
 * equations a reflow can't carry; saved_files says where it is.
 *
 * It never reaches the reader's PDS, nor their Semble/Margin backing: it has no
 * URL to put on a card, and uploads are often someone else's copyright. With
 * backing on, the Saved list serves it alongside the collection like any other
 * URL-less save (services/backing/sync.ts listBackedSaved).
 *
 * Limits, from the plan (config/tier-limits.ts): the file size, uploads per
 * month, total bytes stored. A parse also spends the reader's daily PDF
 * allowance (services/pdf-quota.ts), shared with PDFs saved by URL.
 */

const COLLECTION = 'app.skyreader.feed.saved';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function savedFileKey(did: string, rkey: string): string {
  return `pdf/${did}/${rkey}.pdf`;
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

/** The title for an upload whose PDF names none: its filename, less the extension. */
export function titleFromFilename(name: string | null): string | null {
  if (!name) return null;
  const stem = name
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
  return stem || null;
}

// A PDF starts with `%PDF-`, though the spec lets junk precede it within the
// first kilobyte (and some generators do).
function looksLikePdf(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024));
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  outer: for (let i = 0; i + sig.length <= head.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (head[i + j] !== sig[j]) continue outer;
    }
    return true;
  }
  return false;
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

// POST /api/saved/pdf
export async function handleUploadPdf(request: Request, env: Env, session: Session) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!hasRequiredScopes(session.grantedScopes)) return insufficientScopesResponse();

  const url = new URL(request.url);
  const rkey = url.searchParams.get('rkey');
  if (!rkey || !isValidRkey(rkey)) return invalidRkeyResponse();
  const filename = cleanFilename(url.searchParams.get('name'));

  const limits = await getUserTierLimits(env, session.did);
  if (!limits.pdfSaves) {
    return json({ error: 'pdf_upgrade_required', message: PDF_SUPPORTER_MESSAGE }, 403);
  }
  if (!pdfExtractorConfigured(env) || !env.SAVED_FILES) {
    return json({ error: 'Uploading PDFs is not set up on this server' }, 503);
  }

  const maxBytes = limits.maxPdfUploadBytes;
  const tooLarge = () =>
    json(
      {
        error: 'pdf_too_large',
        message: `PDFs up to ${Math.round(maxBytes / (1024 * 1024))} MB can be uploaded.`,
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
  if (!looksLikePdf(bytes)) {
    return json({ error: 'not_a_pdf', message: "That file isn't a PDF." }, 415);
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
    env.DB.prepare(
      `SELECT COALESCE(SUM(size), 0) AS stored,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS this_month
       FROM saved_files WHERE user_did = ?`
    ).bind(monthStart(now), session.did),
  ]);

  // The same file again opens the save it already is (highlights and all).
  const dupeRkey = (dupe.results[0] as { rkey: string } | undefined)?.rkey;
  if (dupeRkey) {
    return json(
      { error: 'already_saved', message: 'This PDF is already saved.', rkey: dupeRkey },
      409
    );
  }
  if (rkeyTaken.results.length > 0) return json({ error: 'rkey already in use' }, 409);

  const { stored, this_month } = usage.results[0] as { stored: number; this_month: number };
  if (this_month >= limits.maxPdfUploadsPerMonth) {
    return json(
      {
        error: 'pdf_upload_limit_reached',
        message: `You've uploaded ${limits.maxPdfUploadsPerMonth} PDFs this month.`,
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
          'Your uploaded PDFs are using all of your storage. Removing saved PDFs frees space.',
        limit: limits.maxPdfStorageBytes,
        used: stored,
      },
      403
    );
  }
  if (!(await hasPdfAllowance(env, session.did))) {
    return json({ error: 'pdf_daily_limit_reached', message: PDF_QUOTA_MESSAGE }, 403);
  }

  let pdf;
  try {
    pdf = await parsePdf(env, bytes);
  } catch (err) {
    if (!(err instanceof PdfParseError)) throw err;
    if (err.charged) await chargePdfParse(env, session.did);
    log.warn('pdf_upload_parse_failed', { message: err.message, size: bytes.byteLength });
    return json({ error: 'pdf_unreadable', message: err.message }, err.userFacing ? 422 : 502);
  }
  await chargePdfParse(env, session.did);

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

  const title = pdf.title || titleFromFilename(filename) || 'Untitled PDF';
  const publishedMs = pdf.published ? Date.parse(pdf.published) : NaN;
  const publishedAt = Number.isFinite(publishedMs) ? publishedMs : null;
  const savedAt = Date.now();
  const recordUri = `at://${session.did}/${COLLECTION}/${rkey}`;
  const r2Key = savedFileKey(session.did, rkey);

  // The file first: a row pointing at a missing file is worse than a stray file.
  await env.SAVED_FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { did: session.did, rkey, ...(filename ? { filename } : {}) },
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, 'pdf', NULL, NULL, ?, ?, ?, ?, 'upload')`
      ).bind(
        session.did,
        rkey,
        recordUri,
        title,
        pdf.author,
        pdf.description,
        pdf.content,
        pdf.wordCount,
        publishedAt,
        savedAt,
        savedAt
      ),
      env.DB.prepare(
        `INSERT INTO saved_files (user_did, rkey, r2_key, filename, mime_type, size, sha256, created_at)
         VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, ?)`
      ).bind(session.did, rkey, r2Key, filename, bytes.byteLength, sha256, savedAt),
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

  log.info('pdf_uploaded', {
    size: bytes.byteLength,
    pages: pdf.pageCount,
    pagesKept: pdf.pagesKept,
    wordCount: pdf.wordCount,
  });

  return json(
    {
      rkey,
      uri: recordUri,
      url: '',
      title,
      author: pdf.author,
      description: pdf.description,
      content: pdf.content,
      contentType: 'pdf',
      domain: null,
      image: null,
      wordCount: pdf.wordCount,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      savedAt: new Date(savedAt).toISOString(),
      source: 'upload',
      // Less than pageCount when a cap (300 pages, 1 MB of text) cut the reflow short.
      pageCount: pdf.pageCount,
      pagesKept: pdf.pagesKept,
    },
    201
  );
}

// Largest PDF the viewer route will relay for a save made by link. Nothing parses
// it here (the browser draws it), so it can be bigger than a parse allows; the
// cap bounds what one request holds in the Worker's memory.
const MAX_RELAYED_PDF_BYTES = 30 * 1024 * 1024;
const RELAY_TIMEOUT_MS = 20_000;

function pdfResponse(body: BodyInit, filename: string, size?: number): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    // RFC 5987, so a non-ASCII filename survives; the plain one is the fallback.
    'Content-Disposition': `inline; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  if (size !== undefined) headers['Content-Length'] = String(size);
  return new Response(body, { headers });
}

/**
 * The original of a PDF saved by link, for the reader's PDF view. Those saves
 * keep only their text, and the browser can't fetch most PDFs itself (no CORS),
 * so it's read from the save's own URL here and relayed. Supporter, like PDFs.
 * The Worker's fetch reaches only the public internet
 * (global_fetch_strictly_public), and the URL is one this reader saved.
 */
async function relayLinkedPdf(env: Env, session: Session, rkey: string): Promise<Response> {
  const save = await env.DB.prepare(
    'SELECT url, content_type FROM saved_articles WHERE user_did = ? AND rkey = ?'
  )
    .bind(session.did, rkey)
    .first<{ url: string; content_type: string | null }>();
  if (!save || save.content_type !== 'pdf' || !/^https?:\/\//i.test(save.url)) {
    return json({ error: 'Not found' }, 404);
  }
  if (!(await getUserTierLimits(env, session.did)).pdfSaves) {
    return json({ error: 'pdf_upgrade_required', message: PDF_SUPPORTER_MESSAGE }, 403);
  }

  let upstream: Response;
  try {
    upstream = await fetch(save.url, {
      headers: {
        Accept: 'application/pdf,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; Skyreader/1.0; +https://skyreader.app)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
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
  const bytes = await readCapped(upstream.body, MAX_RELAYED_PDF_BYTES);
  if (bytes === null) return json({ error: 'This PDF is too large to show.' }, 413);
  if (!looksLikePdf(bytes)) return json({ error: "That link doesn't serve a PDF now." }, 502);

  let path = new URL(save.url).pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape: name it by the raw path.
  }
  const name = cleanFilename(path) || 'document.pdf';
  return pdfResponse(bytes, /\.pdf$/i.test(name) ? name : `${name}.pdf`, bytes.byteLength);
}

// GET /api/saved/<rkey>/file — the original, only ever to the reader who saved it:
// an upload's stored file, or (relayed) the PDF a link save points at.
export async function handleGetSavedFile(request: Request, env: Env, session: Session) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const rkey = new URL(request.url).pathname.split('/')[3];
  if (!rkey || !isValidRkey(rkey)) return invalidRkeyResponse();

  const row = await env.DB.prepare(
    'SELECT r2_key, filename, mime_type FROM saved_files WHERE user_did = ? AND rkey = ?'
  )
    .bind(session.did, rkey)
    .first<{ r2_key: string; filename: string | null; mime_type: string }>();
  if (!row) return relayLinkedPdf(env, session, rkey);
  if (!env.SAVED_FILES) return json({ error: 'Not found' }, 404);

  const object = await env.SAVED_FILES.get(row.r2_key);
  if (!object) return json({ error: 'Not found' }, 404);

  return pdfResponse(object.body, row.filename || 'document.pdf', object.size);
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
