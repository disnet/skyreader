// Snapshots: what a save's body was when it was captured.
//
// saved_articles.content is the body the reader reads, and a later capture can
// replace it (the extension's live-DOM upgrade of a paywall stub). A snapshot is
// the capture itself, kept as it was: the body in R2 (SAVED_FILES), plus its
// hash, the page it came from, when, and how. Each capture of a body that differs
// from the save's latest one is a new snapshot, so a save can hold several.
//
// Rows are shaped as the future app.skyreader.archive.snapshot record
// (records.ts, docs/plans/ARCHIVE_RECORDS.md). A capture never fails the save that
// carries it: callers run it under waitUntil, and errors are logged here.

import type { Env } from '../../types';
import { generateTid } from '../../utils/tid';
import { sha256Hex } from '../../utils/sha256';
import { log } from '../../utils/logger';
import { reportError } from '../../observability/sentry';
import type { SnapshotRow } from './records';

export const SNAPSHOT_METHODS = ['live-dom', 'server', 'feed', 'record', 'upload'] as const;
export type SnapshotMethod = (typeof SNAPSHOT_METHODS)[number];

export function isSnapshotMethod(value: unknown): value is SnapshotMethod {
  return typeof value === 'string' && (SNAPSHOT_METHODS as readonly string[]).includes(value);
}

// The note a save stores in place of an article nobody could fetch (backend
// emptyExtractionNote, frontend failedSaveBody, the extension's noTextNote). It
// is not a capture of the page, so it is never kept as one.
const FAILED_CAPTURE_MARKER = 'data-skyreader-note="fetch-failed"';

// Captures kept per save. Re-saving with new text skips the monthly save limit,
// so without a ceiling one save could grow without bound. The first captures are
// the ones worth keeping (the page as it was), so at the cap the newest capture
// replaces the previous newest: the snapshot list always ends with the body the
// reader is reading.
export const MAX_SNAPSHOTS_PER_SAVE = 20;

export function snapshotR2Key(did: string, saveRkey: string, rkey: string): string {
  return `snapshots/${did}/${saveRkey}/${rkey}.html`;
}

export interface CaptureInput {
  did: string;
  saveRkey: string;
  url: string;
  body: string | null | undefined;
  method: SnapshotMethod | null;
}

/**
 * Keep `body` as a snapshot of the save. Skips an empty body, the failed-fetch
 * note, and a body identical to the save's latest snapshot. Returns the new row,
 * or null when nothing was stored.
 */
export async function captureSnapshot(env: Env, input: CaptureInput): Promise<SnapshotRow | null> {
  const { did, saveRkey, url, body, method } = input;
  if (!body || !body.trim() || body.includes(FAILED_CAPTURE_MARKER)) return null;
  if (!env.SAVED_FILES) return null;
  try {
    const bytes = new TextEncoder().encode(body);
    const sha256 = await sha256Hex(bytes);
    const latest = await env.DB.prepare(
      `SELECT sha256, (SELECT COUNT(*) FROM saved_snapshots WHERE user_did = ?1 AND save_rkey = ?2) AS n
       FROM saved_snapshots WHERE user_did = ?1 AND save_rkey = ?2
       ORDER BY captured_at DESC, rkey DESC LIMIT 1`
    )
      .bind(did, saveRkey)
      .first<{ sha256: string; n: number }>();
    if (latest?.sha256 === sha256) return null;
    if (latest && latest.n >= MAX_SNAPSHOTS_PER_SAVE) {
      log.warn('snapshot_cap_reached', { method });
      const newest = await env.DB.prepare(
        `DELETE FROM saved_snapshots WHERE user_did = ?1 AND rkey = (
           SELECT rkey FROM saved_snapshots WHERE user_did = ?1 AND save_rkey = ?2
           ORDER BY captured_at DESC, rkey DESC LIMIT 1)
         RETURNING r2_key`
      )
        .bind(did, saveRkey)
        .first<{ r2_key: string }>();
      if (newest) await env.SAVED_FILES.delete(newest.r2_key);
    }

    const rkey = generateTid();
    const row: SnapshotRow = {
      rkey,
      save_rkey: saveRkey,
      captured_at: Date.now(),
      url,
      content_type: 'text/html',
      sha256,
      size: bytes.byteLength,
      r2_key: snapshotR2Key(did, saveRkey, rkey),
      method,
    };
    await env.SAVED_FILES.put(row.r2_key, bytes, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
      customMetadata: { did, save: saveRkey, sha256 },
    });
    try {
      await env.DB.prepare(
        `INSERT INTO saved_snapshots
           (user_did, rkey, save_rkey, captured_at, url, content_type, sha256, size, r2_key, method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          did,
          row.rkey,
          row.save_rkey,
          row.captured_at,
          row.url,
          row.content_type,
          row.sha256,
          row.size,
          row.r2_key,
          row.method
        )
        .run();
    } catch (err) {
      await env.SAVED_FILES.delete(row.r2_key).catch(() => {});
      throw err;
    }
    // The save may have been deleted while this ran (a capture runs after the
    // response). Its snapshots went with it, so this one must too.
    const save = await env.DB.prepare(
      'SELECT 1 AS x FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(did, saveRkey)
      .first();
    if (!save) {
      await deleteSnapshots(env, did, [saveRkey]);
      return null;
    }
    log.info('snapshot_captured', { method, size: row.size });
    return row;
  } catch (error) {
    log.error('snapshot_capture_failed', { method, error: String(error) });
    reportError(error, { tags: { op: 'snapshot_capture' } });
    return null;
  }
}

/** A save's snapshots, oldest first. */
export async function listSnapshots(
  env: Env,
  did: string,
  saveRkey: string
): Promise<SnapshotRow[]> {
  const rows = await env.DB.prepare(
    `SELECT rkey, save_rkey, captured_at, url, content_type, sha256, size, r2_key, method
     FROM saved_snapshots WHERE user_did = ? AND save_rkey = ?
     ORDER BY captured_at ASC, rkey ASC`
  )
    .bind(did, saveRkey)
    .all<SnapshotRow>();
  return rows.results;
}

/** Drop every snapshot of these saves. Called after the saves' rows are deleted. */
export async function deleteSnapshots(env: Env, did: string, saveRkeys: string[]): Promise<void> {
  for (const saveRkey of saveRkeys) {
    const rows = await env.DB.prepare(
      'SELECT r2_key FROM saved_snapshots WHERE user_did = ? AND save_rkey = ?'
    )
      .bind(did, saveRkey)
      .all<{ r2_key: string }>();
    if (rows.results.length === 0) continue;
    await env.DB.prepare('DELETE FROM saved_snapshots WHERE user_did = ? AND save_rkey = ?')
      .bind(did, saveRkey)
      .run();
    try {
      await env.SAVED_FILES?.delete(rows.results.map((r) => r.r2_key));
    } catch (error) {
      // The rows are gone; an orphaned object costs storage, not correctness.
      log.error('snapshot_delete_failed', { error: String(error) });
      reportError(error, { tags: { op: 'snapshot_delete' } });
    }
  }
}
