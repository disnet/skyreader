// Snapshot pictures: the images a snapshot's body showed, kept with it.
//
// A snapshot keeps a save's text as it was (snapshots.ts), but its <img> tags
// still point at the site, so the pictures go when the site does. Each capture
// also keeps the pictures its body shows, in the save's file store
// (services/saved-file-store.ts), one row per picture per snapshot in
// saved_snapshot_images. The body is never rewritten: the reader loads the
// site's own picture and asks for the kept copy only when that fails
// (GET /api/saved/<rkey>/snapshot-image?url=…).
//
// A Supporter feature (TierLimits.snapshotImages) whose bytes count against the
// plan's storage for saved files (storedFileBytes). Bounded per capture (count,
// bytes per picture, bytes in all), per save and per invocation. The plan is
// checked at capture time only: what was captured stays readable whatever the
// plan later becomes.

import type { Env } from '../../types';
import { getUserTierLimits } from '../user-tier';
import { readCapped } from '../../routes/feedback';
import {
  STORED_FILE_COLUMNS,
  savedFileStore,
  storeFor,
  storedFileRef,
  type StoredFileColumns,
  type StoredFileRef,
} from '../saved-file-store';
import { sha256Hex } from '../../utils/sha256';
import { log } from '../../utils/logger';
import { decodeEntities } from '../../utils/html-text';
import { getRequestContext } from '../../utils/request-context';

/** Pictures kept per capture: an article's figures, not a gallery's every thumbnail. */
export const MAX_IMAGES_PER_SNAPSHOT = 30;
/** Largest picture kept. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Bytes of pictures kept per capture, all told. */
export const MAX_SNAPSHOT_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * Bytes of pictures kept per save, across its captures. A re-save with new text
 * skips the monthly save limit, so this is what bounds one save's pictures.
 */
export const MAX_SAVE_IMAGE_BYTES = 40 * 1024 * 1024;
/** How long one picture's download may take. */
const IMAGE_TIMEOUT_MS = 8_000;
/**
 * How long one invocation spends on pictures, across all its captures: they run
 * under waitUntil, which ends 30 seconds after the response.
 */
const CAPTURE_BUDGET_MS = 20_000;
/**
 * Downloads per invocation, across all its captures: each is a fetch and a
 * store write against the invocation's subrequest ceiling, and a backfill
 * captures many saves in one. A capture past it keeps its text only.
 */
export const MAX_IMAGE_DOWNLOADS_PER_INVOCATION = 60;
/** Downloads at once. */
const CONCURRENCY = 4;

/** The pictures worth keeping. SVG is left out: it can carry script. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

/** A saved_snapshot_images row, less `user_did`. */
export interface SnapshotImageRow extends StoredFileColumns {
  snapshot_rkey: string;
  save_rkey: string;
  url: string;
  content_type: string;
  sha256: string;
  size: number;
}

const ROW_COLUMNS = `snapshot_rkey, save_rkey, url, content_type, sha256, size, ${STORED_FILE_COLUMNS}`;

/** A picture's address made absolute against the page, or null when it isn't a web address. */
export function snapshotImageUrl(src: string, pageUrl: string): string | null {
  const value = src.trim();
  if (!value) return null;
  try {
    const url = pageUrl ? new URL(value, pageUrl) : new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

/**
 * The pictures a body shows, in order, each once: every <img>'s `src`, or the
 * first `srcset` candidate when it has no usable `src`. Made absolute against
 * the page, as the reader's sanitizer makes them, so the reader can ask for a
 * picture by the address it has. Capped at MAX_IMAGES_PER_SNAPSHOT.
 */
export function snapshotImageUrls(body: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  for (const [tag] of body.matchAll(/<img\b[^>]*>/gi)) {
    let url: string | null = null;
    const src = attribute(tag, 'src');
    if (src) url = snapshotImageUrl(src, pageUrl);
    if (!url) {
      // A candidate's address runs to its first space: it may hold commas itself.
      const first = attribute(tag, 'srcset')?.trim().split(/\s+/)[0]?.replace(/,$/, '');
      if (first) url = snapshotImageUrl(first, pageUrl);
    }
    if (url) urls.add(url);
    if (urls.size >= MAX_IMAGES_PER_SNAPSHOT) break;
  }
  return [...urls];
}

/** The save's pictures captured so far, by address: a later capture reuses them. */
export async function keptImagesByUrl(
  env: Env,
  did: string,
  saveRkey: string
): Promise<Map<string, SnapshotImageRow>> {
  const rows = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM saved_snapshot_images WHERE user_did = ? AND save_rkey = ?
     ORDER BY snapshot_rkey ASC`
  )
    .bind(did, saveRkey)
    .all<SnapshotImageRow>();
  return new Map(rows.results.map((row) => [row.url, row]));
}

type Fetched = { bytes: Uint8Array; contentType: string } | null;

async function fetchImage(url: string, deadline: number): Promise<Fetched> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; Skyreader/1.0; +https://skyreader.app)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.min(IMAGE_TIMEOUT_MS, remaining)),
    });
  } catch {
    return null;
  }
  const contentType = (response.headers.get('Content-Type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const declared = Number(response.headers.get('Content-Length'));
  if (!response.ok || !IMAGE_TYPES.has(contentType) || declared > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  try {
    const bytes = await readCapped(response.body, MAX_IMAGE_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;
    return { bytes: new Uint8Array(bytes), contentType };
  } catch {
    return null;
  }
}

/**
 * Bytes a reader keeps against their plan's storage for saved files: every kept
 * original (saved_files) plus every distinct picture their snapshots kept.
 */
export async function storedFileBytes(env: Env, did: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(size), 0) FROM saved_files WHERE user_did = ?1) +
       (SELECT COALESCE(SUM(size), 0) FROM (
          SELECT MAX(size) AS size FROM saved_snapshot_images WHERE user_did = ?1 GROUP BY r2_key
        )) AS stored`
  )
    .bind(did)
    .first<{ stored: number }>();
  return row?.stored ?? 0;
}

export interface ImageCaptureInput {
  did: string;
  saveRkey: string;
  snapshotRkey: string;
  pageUrl: string;
  body: string;
  /** The save's pictures already kept (keptImagesByUrl), reused rather than downloaded again. */
  kept: Map<string, SnapshotImageRow>;
}

/**
 * Keep the pictures `body` shows as part of snapshot `snapshotRkey`. A picture
 * the save already kept is reused; a new one is downloaded and kept. One that
 * can't be had (gone, too big, not a picture, out of budget) is skipped. Returns
 * how many the snapshot now holds. Throws only on a D1 failure.
 */
export async function captureSnapshotImages(env: Env, input: ImageCaptureInput): Promise<number> {
  const { did, saveRkey, snapshotRkey, pageUrl, body, kept } = input;
  const urls = snapshotImageUrls(body, pageUrl);
  const store = savedFileStore(env);
  if (urls.length === 0 || !store) return 0;
  const limits = await getUserTierLimits(env, did);
  if (!limits.snapshotImages) return 0;

  // Shared by every capture in this invocation; a capture outside one (a test
  // calling in directly) gets its own.
  const context = getRequestContext();
  const budget = context
    ? (context.snapshotImages ??= {
        downloads: MAX_IMAGE_DOWNLOADS_PER_INVOCATION,
        deadline: Date.now() + CAPTURE_BUDGET_MS,
      })
    : { downloads: MAX_IMAGE_DOWNLOADS_PER_INVOCATION, deadline: Date.now() + CAPTURE_BUDGET_MS };
  // What the save's pictures already take, each object once.
  const saveBytes = new Map([...kept.values()].map((row) => [row.r2_key, row.size]));
  let bytesLeft = Math.min(
    MAX_SNAPSHOT_IMAGE_BYTES,
    MAX_SAVE_IMAGE_BYTES - [...saveBytes.values()].reduce((a, b) => a + b, 0),
    // Pictures share the plan's storage with kept originals.
    limits.maxPdfStorageBytes - (await storedFileBytes(env, did))
  );

  const rows: SnapshotImageRow[] = [];
  const written: StoredFileRef[] = [];
  let downloaded = 0;
  let next = 0;
  const work = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const reused = kept.get(url);
      if (reused) {
        rows.push({ ...reused, snapshot_rkey: snapshotRkey });
        continue;
      }
      if (bytesLeft <= 0 || budget.downloads <= 0) continue;
      budget.downloads--;
      const fetched = await fetchImage(url, budget.deadline);
      if (!fetched || fetched.bytes.byteLength > bytesLeft) continue;
      bytesLeft -= fetched.bytes.byteLength;
      const sha256 = await sha256Hex(fetched.bytes);
      try {
        const ref = await store.putImage(
          { did, saveRkey, sha256, mimeType: fetched.contentType },
          fetched.bytes
        );
        written.push(ref);
        downloaded++;
        rows.push({
          snapshot_rkey: snapshotRkey,
          save_rkey: saveRkey,
          url,
          content_type: fetched.contentType,
          sha256,
          size: fetched.bytes.byteLength,
          storage: ref.storage,
          r2_key: ref.r2Key,
          blob_cid: ref.blobCid,
          record_uri: ref.recordUri,
        });
      } catch (error) {
        log.warn('snapshot_image_store_failed', { error: String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  if (rows.length === 0) return 0;

  // Each row takes its save from the snapshot as it stands now: a backed re-save
  // may have moved the snapshot to a new rkey while the pictures downloaded, and
  // one deleted meanwhile (its save, or the cap) inserts nothing.
  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO saved_snapshot_images (user_did, ${ROW_COLUMNS})
     SELECT ?1, rkey, save_rkey, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     FROM saved_snapshots WHERE user_did = ?1 AND rkey = ?10`
  );
  let inserted = 0;
  try {
    const results = await env.DB.batch(
      rows.map((row) =>
        insert.bind(
          did,
          row.url,
          row.content_type,
          row.sha256,
          row.size,
          row.storage,
          row.r2_key,
          row.blob_cid,
          row.record_uri,
          snapshotRkey
        )
      )
    );
    inserted = results.reduce((n, result) => n + (result.meta?.changes ?? 0), 0);
  } finally {
    // Whatever was written but didn't land in a row (the insert failed, or the
    // snapshot is gone) is let go.
    await pruneSnapshotImages(env, did, written);
  }
  log.info('snapshot_images_captured', {
    count: inserted,
    downloaded,
  });
  return inserted;
}

/**
 * Drop the stored pictures among `refs` that no snapshot row references any
 * more. Called after rows are deleted; a picture another capture still shows
 * stays.
 */
export async function pruneSnapshotImages(
  env: Env,
  did: string,
  refs: StoredFileRef[]
): Promise<void> {
  const byKey = new Map(refs.map((ref) => [ref.r2Key, ref]));
  if (byKey.size === 0) return;
  const keys = [...byKey.keys()];
  const referenced = new Set<string>();
  // Pages of 90 keep the lookup under D1's 100 bound parameters.
  for (let i = 0; i < keys.length; i += 90) {
    const page = keys.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT r2_key FROM saved_snapshot_images WHERE user_did = ? AND r2_key IN (${page.map(() => '?').join(', ')})`
    )
      .bind(did, ...page)
      .all<{ r2_key: string }>();
    for (const row of rows.results) referenced.add(row.r2_key);
  }
  for (const [key, ref] of byKey) {
    if (referenced.has(key)) continue;
    try {
      await storeFor(env, ref)?.delete(ref);
    } catch (error) {
      // The rows are gone; an orphaned object costs storage, not correctness.
      log.error('snapshot_image_delete_failed', { error: String(error) });
    }
  }
}

/**
 * Delete the picture rows matching `where` (a snapshot's, or a save's) and
 * return where their bytes are, for pruneSnapshotImages once nothing else
 * that runs first could still reuse them.
 */
export async function deleteSnapshotImageRows(
  env: Env,
  did: string,
  where: { snapshotRkey: string } | { saveRkey: string }
): Promise<StoredFileRef[]> {
  const [column, value] =
    'snapshotRkey' in where ? ['snapshot_rkey', where.snapshotRkey] : ['save_rkey', where.saveRkey];
  const rows = await env.DB.prepare(
    `DELETE FROM saved_snapshot_images WHERE user_did = ? AND ${column} = ?
     RETURNING ${STORED_FILE_COLUMNS}`
  )
    .bind(did, value)
    .all<StoredFileColumns>();
  return rows.results.map(storedFileRef);
}

/** A save's kept copy of the picture at `url`, from its latest capture that has it. */
export async function findSnapshotImage(
  env: Env,
  did: string,
  saveRkey: string,
  url: string
): Promise<{ ref: StoredFileRef; contentType: string } | null> {
  const row = await env.DB.prepare(
    `SELECT ${STORED_FILE_COLUMNS}, content_type FROM saved_snapshot_images
     WHERE user_did = ? AND save_rkey = ? AND url = ?
     ORDER BY snapshot_rkey DESC LIMIT 1`
  )
    .bind(did, saveRkey, url)
    .first<StoredFileColumns & { content_type: string }>();
  return row ? { ref: storedFileRef(row), contentType: row.content_type } : null;
}
