// Copying saves into a reader's Semble/Margin backing collection in the
// background, at the pace their PDS allows (migrations/0116).
//
// Each save copied is a record or two on the reader's PDS, and a PDS caps how
// many records any app may write an hour and a day (Bluesky's: a few hundred
// saves an hour). A big import is days of that, so the copy can't live in a
// browser tab. The saves to copy wait in backing_copy_pending, and one chain of
// `backing.copy` jobs per reader drains them a chunk at a time, sleeping on the
// queue whenever exportNativeSaves stops to leave the reader room to post.
//
// One chain per reader, one hop at a time: the run row names the live chain's
// token and its next hop's seq, and a hop claims the row (bumping seq) before
// it copies anything. A job from a replaced chain, or a second delivery of the
// same message, finds the row moved on and stops, so no save is copied twice.
// A hop that fails is retried by the chain itself, backing off; after enough
// in a row the copy stops until the reader is back.

import type { Env } from '../../types';
import { getUserSettings } from '../../routes/settings';
import { chunkArray } from '../../routes/reading';
import { SEMBLE_SCOPES, MARGIN_SCOPES } from '../../config/scopes';
import { getBackgroundSession } from '../oauth';
import { grantsScopes } from '../scope-check';
import { enqueueJobs, JOB_CHUNK } from '../jobs';
import { exportNativeSaves } from './enable';
import { log, serializeError } from '../../utils/logger';

/** Longest a queue message can be held back: a longer wait is several hops. */
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

/** A chain whose next hop is this late is taken for lost, and started again. */
const STALE_RUN_MS = 15 * 60_000;

/** Wait after a hop that copied nothing, doubling per failure in a row, capped. */
const FAILED_HOP_BACKOFF_MS = 15 * 60_000;
const MAX_FAILED_HOP_BACKOFF_MS = 6 * 60 * 60_000;

/** Failed hops in a row before the copy stops (about two days of backing off). */
const MAX_FAILED_HOPS = 12;

/** Hops a save may fail in, while others copy fine, before it's dropped. */
const MAX_SAVE_ATTEMPTS = 3;

/** Pending rows written per statement (bound as one JSON array). */
const INSERT_CHUNK = 500;

type Hop = { did: string; token: string; seq: number };

export interface BackingCopyStatus {
  /** saves still to copy */
  pending: number;
  /** epoch ms the copy picks up again, while it waits out the PDS's write limit */
  resumesAt: number | null;
  /** stopped after failing for days (signed out, or the PDS refusing) */
  stalled: boolean;
}

/**
 * Queue saves to be copied into the reader's backing collection: the given
 * rkeys (an import's new saves), or 'library' for every save with a web URL not
 * already in it (turning backing on with "copy my existing saves"). Starts the
 * reader's chain unless one is running, and restarts one that stopped.
 */
export async function queueBackingCopy(
  env: Env,
  did: string,
  saves: string[] | 'library',
  now = Date.now()
): Promise<void> {
  if (saves === 'library') {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO backing_copy_pending (user_did, rkey, queued_at)
       SELECT s.user_did, s.rkey, ? FROM saved_articles s
        WHERE s.user_did = ? AND s.url IS NOT NULL AND s.url != ''
          AND NOT EXISTS (
            SELECT 1 FROM backed_collection_members m
             WHERE m.user_did = s.user_did AND m.url_normalized = s.url_normalized
          )`
    )
      .bind(now, did)
      .run();
  } else {
    for (const part of chunkArray(saves, INSERT_CHUNK)) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO backing_copy_pending (user_did, rkey, queued_at)
         SELECT ?, value, ? FROM json_each(?)`
      )
        .bind(did, now, JSON.stringify(part))
        .run();
    }
  }
  await ensureChain(env, did, now);
}

/** Start the reader's chain unless a live one is scheduled. */
async function ensureChain(env: Env, did: string, now: number): Promise<void> {
  const run = await env.DB.prepare(
    'SELECT next_run_at, stalled FROM backing_copy_runs WHERE user_did = ?'
  )
    .bind(did)
    .first<{ next_run_at: number; stalled: number }>();
  if (run && !run.stalled && run.next_run_at > now - STALE_RUN_MS) return;
  const token = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO backing_copy_runs (user_did, token, seq, next_run_at, failures, stalled)
     VALUES (?, ?, 0, ?, 0, 0)
     ON CONFLICT(user_did) DO UPDATE SET token = excluded.token, seq = 0,
       next_run_at = excluded.next_run_at, failures = 0, stalled = 0`
  )
    .bind(did, token, now)
    .run();
  await enqueueJobs(env, [{ type: 'backing.copy', did, token, seq: 0 }]);
}

/**
 * The cron's pass: start again any chain that went quiet (a lost message, or a
 * hop that died before it could queue the next), oldest first, and any saves
 * left pending with no chain at all. A stopped copy waits for the reader.
 */
export async function restartStaleBackingCopies(env: Env, now = Date.now()): Promise<number> {
  const quiet = await env.DB.prepare(
    `SELECT user_did FROM backing_copy_runs WHERE stalled = 0 AND next_run_at < ?
      ORDER BY next_run_at LIMIT 20`
  )
    .bind(now - STALE_RUN_MS)
    .all<{ user_did: string }>();
  const orphaned = await env.DB.prepare(
    `SELECT DISTINCT p.user_did FROM backing_copy_pending p
      WHERE NOT EXISTS (SELECT 1 FROM backing_copy_runs r WHERE r.user_did = p.user_did)
      LIMIT 20`
  ).all<{ user_did: string }>();
  const stale = { results: [...quiet.results, ...orphaned.results] };
  for (const { user_did } of stale.results) await ensureChain(env, user_did, now);
  return stale.results.length;
}

export async function backingCopyStatus(
  env: Env,
  did: string,
  now = Date.now()
): Promise<BackingCopyStatus | null> {
  const row = await env.DB.prepare(
    `SELECT r.next_run_at AS next_run_at, r.stalled AS stalled,
            (SELECT COUNT(*) FROM backing_copy_pending p WHERE p.user_did = r.user_did) AS pending
       FROM backing_copy_runs r WHERE r.user_did = ?`
  )
    .bind(did)
    .first<{ next_run_at: number; stalled: number; pending: number }>();
  if (!row || row.pending === 0) return null;
  return {
    pending: row.pending,
    resumesAt: !row.stalled && row.next_run_at > now ? row.next_run_at : null,
    stalled: !!row.stalled,
  };
}

/** The reader is back (they opened Settings): give a stopped copy another go. */
export async function resumeStalledBackingCopy(env: Env, did: string): Promise<void> {
  const row = await env.DB.prepare(
    'SELECT 1 FROM backing_copy_runs WHERE user_did = ? AND stalled = 1'
  )
    .bind(did)
    .first();
  if (row) await ensureChain(env, did, Date.now());
}

/** One hop of a reader's chain: claim it, copy a chunk, then queue the next hop. */
export async function runBackingCopy(env: Env, job: Hop, now = Date.now()): Promise<void> {
  const { did, token, seq } = job;
  const run = await env.DB.prepare(
    'SELECT token, seq, next_run_at FROM backing_copy_runs WHERE user_did = ?'
  )
    .bind(did)
    .first<{ token: string; seq: number; next_run_at: number }>();
  if (!run || run.token !== token || run.seq !== seq) return; // done, replaced, or a repeat

  // Still inside a wait longer than one message could be held back.
  const waiting = run.next_run_at > now + 1000;
  const claimed = await env.DB.prepare(
    `UPDATE backing_copy_runs SET seq = seq + 1, next_run_at = ?
      WHERE user_did = ? AND token = ? AND seq = ?`
  )
    .bind(waiting ? run.next_run_at : now, did, token, seq)
    .run();
  if (!claimed.meta.changes) return; // another delivery of this message got here first
  const hop: Hop = { did, token, seq: seq + 1 };

  if (waiting) {
    await schedule(env, hop, run.next_run_at, now);
    return;
  }
  try {
    await copyChunk(env, hop, now);
  } catch (error) {
    await failedHop(env, hop, now, error);
  }
}

async function copyChunk(env: Env, hop: Hop, now: number): Promise<void> {
  const { did, token } = hop;
  const settings = await getUserSettings(env, did);
  if (settings.backing.provider === 'skyreader') {
    // Backing was turned off: nothing to copy into. (disableBacking clears the
    // queue too; this covers a hop already past its claim when it did.)
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM backing_copy_pending WHERE user_did = ?
           AND EXISTS (SELECT 1 FROM backing_copy_runs WHERE user_did = ? AND token = ?)`
      ).bind(did, did, token),
      env.DB.prepare('DELETE FROM backing_copy_runs WHERE user_did = ? AND token = ?').bind(
        did,
        token
      ),
    ]);
    return;
  }
  const backing = settings.backing;

  const chunk = (
    await env.DB.prepare(
      `SELECT rkey FROM backing_copy_pending WHERE user_did = ?
        ORDER BY queued_at, rkey LIMIT ?`
    )
      .bind(did, JOB_CHUNK)
      .all<{ rkey: string }>()
  ).results.map((r) => r.rkey);
  if (chunk.length === 0) {
    // Done, unless an import queued more since the read above: then keep going.
    const ended = await env.DB.prepare(
      `DELETE FROM backing_copy_runs WHERE user_did = ? AND token = ?
         AND NOT EXISTS (SELECT 1 FROM backing_copy_pending WHERE user_did = ?)`
    )
      .bind(did, token, did)
      .run();
    if (!ended.meta.changes) await schedule(env, hop, now, now);
    return;
  }

  const scopes = backing.provider === 'semble' ? SEMBLE_SCOPES : MARGIN_SCOPES;
  const session = await getBackgroundSession(env, did, (granted) => grantsScopes(granted, scopes));
  // Signed out everywhere, or no session with the permission yet.
  if (!session) throw new Error('no session to copy backed saves with');

  const result = await exportNativeSaves(env, session, backing, { rkeys: chunk });
  const failed = new Set(result.failed);
  // Without a pause every save in the chunk was dealt with, including ones
  // deleted since (no row to copy); with one, only those handled before it.
  // A failed one stays to be tried again.
  const done = (result.retryAfter === undefined ? chunk : result.handled).filter(
    (r) => !failed.has(r)
  );
  // Only while this chain still owns the queue: a reader who turned backing off
  // and on again mid-hop has a new queue this hop mustn't touch.
  const owned = `AND EXISTS (SELECT 1 FROM backing_copy_runs WHERE user_did = ? AND token = ?)`;
  if (done.length > 0) {
    await env.DB.prepare(
      `DELETE FROM backing_copy_pending
        WHERE user_did = ? AND rkey IN (SELECT value FROM json_each(?)) ${owned}`
    )
      .bind(did, JSON.stringify(done), did, token)
      .run();
  }
  // Nothing went through and several failed: the PDS is down or refusing us, not
  // these saves. Back off without counting it against them.
  if (result.exported === 0 && failed.size >= 2) throw new Error('every copy in the hop failed');
  if (failed.size > 0) {
    // The rest copied, so these saves are the problem: drop one after a few hops.
    const dropped = await env.DB.batch([
      env.DB.prepare(
        `UPDATE backing_copy_pending SET attempts = attempts + 1
          WHERE user_did = ? AND rkey IN (SELECT value FROM json_each(?)) ${owned}`
      ).bind(did, JSON.stringify([...failed]), did, token),
      env.DB.prepare('DELETE FROM backing_copy_pending WHERE user_did = ? AND attempts >= ?').bind(
        did,
        MAX_SAVE_ATTEMPTS
      ),
    ]);
    const n = dropped[1]?.meta.changes ?? 0;
    if (n > 0) log.warn('backing_copy_saves_dropped', { dropped: n });
  }
  if (result.retryAfter !== undefined) {
    log.info('backing_copy_paused', { exported: result.exported, retryAfter: result.retryAfter });
  }
  await schedule(env, hop, now + (result.retryAfter ?? 0) * 1000, now, { succeeded: true });
}

/** A hop that copied nothing: try again later, or stop after too many in a row. */
async function failedHop(env: Env, hop: Hop, now: number, error: unknown): Promise<void> {
  const row = await env.DB.prepare(
    `UPDATE backing_copy_runs SET failures = failures + 1
      WHERE user_did = ? AND token = ? AND seq = ? RETURNING failures`
  )
    .bind(hop.did, hop.token, hop.seq)
    .first<{ failures: number }>();
  if (!row) return; // replaced meanwhile
  log.warn('backing_copy_hop_failed', { failures: row.failures, ...serializeError(error) });
  if (row.failures >= MAX_FAILED_HOPS) {
    // Stop until the reader is back (resumeStalledBackingCopy, queueBackingCopy).
    await env.DB.prepare(
      'UPDATE backing_copy_runs SET stalled = 1 WHERE user_did = ? AND token = ? AND seq = ?'
    )
      .bind(hop.did, hop.token, hop.seq)
      .run();
    return;
  }
  const wait = Math.min(FAILED_HOP_BACKOFF_MS * 2 ** (row.failures - 1), MAX_FAILED_HOP_BACKOFF_MS);
  await schedule(env, hop, now + wait, now);
}

/** Queue the chain's next hop for `at`, if the chain is still this one. */
async function schedule(
  env: Env,
  hop: Hop,
  at: number,
  now: number,
  { succeeded = false } = {}
): Promise<void> {
  const updated = await env.DB.prepare(
    `UPDATE backing_copy_runs
        SET next_run_at = ?, failures = CASE WHEN ? THEN 0 ELSE failures END
      WHERE user_did = ? AND token = ? AND seq = ?`
  )
    .bind(at, succeeded ? 1 : 0, hop.did, hop.token, hop.seq)
    .run();
  if (!updated.meta.changes) return;
  const delaySeconds = Math.min(Math.max(0, Math.ceil((at - now) / 1000)), MAX_QUEUE_DELAY_SECONDS);
  await enqueueJobs(env, [{ type: 'backing.copy', ...hop }], { delaySeconds });
}
