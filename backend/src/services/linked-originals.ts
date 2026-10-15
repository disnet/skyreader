import type { Env } from '../types';
import { log } from '../utils/logger';

/**
 * The bytes of an EPUB saved by link, kept from the read that extracted it.
 *
 * A save by link is two requests: /api/extract reads the book, then the save
 * lands. The book was already in hand at the first, so it's put in R2 there
 * under a key derived from the reader and the URL, and the save adopts that
 * object as its kept original (routes/saved-pdf.ts storeLinkedOriginal) instead
 * of downloading the book again. An object no save adopts within a day is swept
 * by the hourly cron (sweepStagedOriginals).
 */

const STAGED_PREFIX = 'staged/';
/** How long a staged book waits for its save before the sweep removes it. */
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Where a reader's read of the book at `url` is staged. */
export async function stagedOriginalKey(did: string, url: string): Promise<string> {
  return `${STAGED_PREFIX}epub/${did}/${await sha256Hex(new TextEncoder().encode(url))}.epub`;
}

/**
 * Keep a linked book's bytes for the save that follows. Best effort: a failure
 * only means the save fetches the book itself. An object already there (an
 * earlier read, or a save's kept original) is left alone.
 */
export async function stageLinkedOriginal(
  env: Env,
  did: string,
  url: string,
  bytes: Uint8Array
): Promise<void> {
  if (!env.SAVED_FILES) return;
  try {
    const key = await stagedOriginalKey(did, url);
    if (await env.SAVED_FILES.head(key)) return;
    await env.SAVED_FILES.put(key, bytes, {
      httpMetadata: { contentType: 'application/epub+zip' },
      customMetadata: { did, sha256: await sha256Hex(bytes) },
    });
  } catch (error) {
    log.warn('epub_stage_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Remove staged books no save adopted (no saved_files row points at them). */
export async function sweepStagedOriginals(env: Env, now = Date.now()): Promise<number> {
  if (!env.SAVED_FILES) return 0;
  let deleted = 0;
  let cursor: string | undefined;
  // Pages of 90 keep the lookup under D1's 100 bound parameters. A few pages an
  // hour is plenty: staging happens once per linked book read.
  for (let page = 0; page < 10; page++) {
    const listing = await env.SAVED_FILES.list({ prefix: STAGED_PREFIX, cursor, limit: 90 });
    const stale = listing.objects
      .filter((o) => now - o.uploaded.getTime() > STAGED_TTL_MS)
      .map((o) => o.key);
    if (stale.length) {
      const placeholders = stale.map(() => '?').join(', ');
      const adopted = await env.DB.prepare(
        `SELECT r2_key FROM saved_files WHERE r2_key IN (${placeholders})`
      )
        .bind(...stale)
        .all<{ r2_key: string }>();
      const keep = new Set(adopted.results.map((r) => r.r2_key));
      const orphans = stale.filter((k) => !keep.has(k));
      if (orphans.length) {
        await env.SAVED_FILES.delete(orphans);
        deleted += orphans.length;
      }
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
  return deleted;
}
