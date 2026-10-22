import type { Env } from '../types';
import { sha256Hex } from '../utils/sha256';
import { FileRejected, checkedFile } from './checked-file';
import { EpubError, epubTooLargeMessage, openEpubFromSite, type RangedFile } from './epub';
import { putStream } from './saved-file-store';

/**
 * The bytes of an EPUB saved by link, kept from the read that extracted it.
 *
 * A save by link is two requests: /api/extract reads the book, then the save
 * lands. The book was already in hand at the first, so it's put in R2 there
 * under a key derived from the reader and the URL, and the save adopts that
 * object as its kept original (routes/saved-pdf.ts storeLinkedOriginal) instead
 * of downloading the book again. An object no save adopts within a day is swept
 * by the hourly cron (sweepStagedOriginals).
 *
 * This is scratch for one save, always in R2, wherever the save's original then
 * goes: adopting copies it into the save's store (services/saved-file-store.ts).
 */

const STAGED_PREFIX = 'staged/';
/** How long a staged book waits for its save before the sweep removes it. */
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;

/** Where a reader's read of the book at `url` is staged. */
export async function stagedOriginalKey(did: string, url: string): Promise<string> {
  return `${STAGED_PREFIX}epub/${did}/${await sha256Hex(new TextEncoder().encode(url))}.epub`;
}

/** A linked book staged in R2, open a range at a time. */
export interface StagedBook {
  file: RangedFile;
  /** Drop it, when the read then failed. */
  discard(): Promise<void>;
}

/**
 * Stream a linked book from its site into its staging place, checked on the way
 * (services/checked-file.ts), so it's read from R2 a range at a time
 * (services/epub.ts parseEpub) and never held whole in the Worker; the save
 * that follows then keeps it rather than downloading it again. A book an
 * earlier read staged is replaced, so the save keeps what this read saw.
 */
export async function stageLinkedBook(
  bucket: R2Bucket,
  did: string,
  url: string,
  maxBytes: number
): Promise<StagedBook> {
  const key = await stagedOriginalKey(did, url);
  const ranged = (size: number): RangedFile => ({
    size: async () => size,
    read: async (offset, length) => {
      const object = await bucket.get(key, { range: { offset, length } });
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
  });
  const { body } = await openEpubFromSite(url, maxBytes);
  const checked = checkedFile(body, 'epub', maxBytes);
  try {
    await putStream(bucket, key, checked.stream, {
      httpMetadata: { contentType: 'application/epub+zip' },
      customMetadata: { did },
    });
  } catch (err) {
    if (!(err instanceof FileRejected)) {
      throw new EpubError("Couldn't fetch the EPUB from its site.");
    }
    throw new EpubError(
      err.reason === 'too_large' ? epubTooLargeMessage(maxBytes) : "This file isn't an EPUB."
    );
  }
  const { size } = await checked.done();
  return {
    file: ranged(size),
    discard: () => bucket.delete(key).catch(() => {}),
  };
}

/** A staged book: its bytes, and a way to let go of it. */
export interface StagedOriginal {
  body: ReadableStream<Uint8Array>;
  size: number;
  /** Drop the staged object, once its bytes are kept (or not wanted). */
  remove(): Promise<void>;
}

/**
 * The book staged for a reader's save of `url`, or null when none is. The
 * caller reads or cancels `body`.
 */
export async function readStagedOriginal(
  env: Env,
  did: string,
  url: string
): Promise<StagedOriginal | null> {
  const bucket = env.SAVED_FILES;
  if (!bucket) return null;
  const key = await stagedOriginalKey(did, url);
  const staged = await bucket.get(key);
  if (!staged) return null;
  return {
    body: staged.body,
    size: staged.size,
    remove: () => bucket.delete(key),
  };
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
