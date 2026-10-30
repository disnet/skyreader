// Copying saves into a reader's Semble/Margin backing collection in the
// background, at the pace their PDS allows (migrations/0115).
//
// Each save copied is a record or two on the reader's PDS, and a PDS caps how
// many records any app may write an hour and a day (Bluesky's: a few hundred
// saves an hour). A big import is days of that, so the copy can't live in a
// browser tab. The saves to copy wait in backing_copy_pending, and one chain of
// `backing.copy` jobs per reader drains them a chunk at a time, sleeping on the
// queue whenever exportNativeSaves stops to leave the reader room to post.
//
// One chain per reader: a run row names the live chain's token, and a job
// carrying any other token stops. Starting a chain (queueBackingCopy, or the
// cron finding one that went quiet) writes a new token, so a duplicate or lost
// message can't fork or end it.

import type { Env } from '../../types';
import { getUserSettings } from '../../routes/settings';
import { SEMBLE_SCOPES, MARGIN_SCOPES } from '../../config/scopes';
import { getBackgroundSession } from '../oauth';
import { grantsScopes } from '../scope-check';
import { enqueueJobs, JOB_CHUNK } from '../jobs';
import { exportNativeSaves } from './enable';
import { log } from '../../utils/logger';

/** Longest a queue message can be held back: a longer wait is several hops. */
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

/** A chain whose next job is this late is taken for lost, and started again. */
const STALE_RUN_MS = 15 * 60_000;

/** Pending rows written per statement (bound as one JSON array). */
const INSERT_CHUNK = 500;

export interface BackingCopyStatus {
  /** saves still to copy */
  pending: number;
  /** epoch ms the copy picks up again, while it waits out the PDS's write limit */
  resumesAt: number | null;
}

/**
 * Queue saves to be copied into the reader's backing collection: the given
 * rkeys (an import's new saves), or 'library' for every save with a web URL
 * (turning backing on with "copy my existing saves"). Starts the reader's chain
 * unless one is already running.
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
       SELECT user_did, rkey, ? FROM saved_articles
        WHERE user_did = ? AND url IS NOT NULL AND url != ''`
    )
      .bind(now, did)
      .run();
  } else {
    for (let i = 0; i < saves.length; i += INSERT_CHUNK) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO backing_copy_pending (user_did, rkey, queued_at)
         SELECT ?, value, ? FROM json_each(?)`
      )
        .bind(did, now, JSON.stringify(saves.slice(i, i + INSERT_CHUNK)))
        .run();
    }
  }
  await ensureChain(env, did, now);
}

/** Start the reader's chain unless a live one is scheduled. */
async function ensureChain(env: Env, did: string, now: number): Promise<void> {
  const run = await env.DB.prepare('SELECT next_run_at FROM backing_copy_runs WHERE user_did = ?')
    .bind(did)
    .first<{ next_run_at: number }>();
  if (run && run.next_run_at > now - STALE_RUN_MS) return;
  const token = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO backing_copy_runs (user_did, token, next_run_at) VALUES (?, ?, ?)
     ON CONFLICT(user_did) DO UPDATE SET token = excluded.token, next_run_at = excluded.next_run_at`
  )
    .bind(did, token, now)
    .run();
  await enqueueJobs(env, [{ type: 'backing.copy', did, token }]);
}

/** The cron's pass: start again any chain that went quiet (a lost or dropped message). */
export async function restartStaleBackingCopies(env: Env, now = Date.now()): Promise<number> {
  const stale = await env.DB.prepare(
    'SELECT user_did FROM backing_copy_runs WHERE next_run_at < ? LIMIT 20'
  )
    .bind(now - STALE_RUN_MS)
    .all<{ user_did: string }>();
  for (const { user_did } of stale.results) await ensureChain(env, user_did, now);
  return stale.results.length;
}

export async function backingCopyStatus(env: Env, did: string): Promise<BackingCopyStatus | null> {
  const row = await env.DB.prepare(
    `SELECT r.next_run_at AS next_run_at,
            (SELECT COUNT(*) FROM backing_copy_pending p WHERE p.user_did = r.user_did) AS pending
       FROM backing_copy_runs r WHERE r.user_did = ?`
  )
    .bind(did)
    .first<{ next_run_at: number; pending: number }>();
  if (!row || row.pending === 0) return null;
  return {
    pending: row.pending,
    resumesAt: row.next_run_at > Date.now() ? row.next_run_at : null,
  };
}

/** One hop of a reader's chain: copy a chunk, then queue the next hop. */
export async function runBackingCopy(
  env: Env,
  job: { did: string; token: string },
  now = Date.now()
): Promise<void> {
  const { did, token } = job;
  const run = await env.DB.prepare(
    'SELECT token, next_run_at FROM backing_copy_runs WHERE user_did = ?'
  )
    .bind(did)
    .first<{ token: string; next_run_at: number }>();
  if (!run || run.token !== token) return; // finished, or another chain took over

  // Still inside a wait longer than one message could be held back.
  if (run.next_run_at > now + 1000) {
    await schedule(env, did, token, run.next_run_at, now);
    return;
  }

  const settings = await getUserSettings(env, did);
  if (settings.backing.provider === 'skyreader') {
    // Backing was turned off: nothing to copy into.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM backing_copy_pending WHERE user_did = ?').bind(did),
      env.DB.prepare('DELETE FROM backing_copy_runs WHERE user_did = ?').bind(did),
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
    if (!ended.meta.changes) await schedule(env, did, token, now, now);
    return;
  }

  const scopes = backing.provider === 'semble' ? SEMBLE_SCOPES : MARGIN_SCOPES;
  const session = await getBackgroundSession(env, did, (granted) => grantsScopes(granted, scopes));
  // Signed out everywhere, or no session with the permission: the queue's
  // retries try again later, and the cron starts the chain over after that.
  if (!session) throw new Error('no session to copy backed saves with');

  const result = await exportNativeSaves(env, session, backing, { rkeys: chunk });
  // Without a pause every save in the chunk was dealt with, including ones that
  // were deleted (no row to copy). With one, only those handled before it.
  const done = result.retryAfter === undefined ? chunk : result.handled;
  if (done.length > 0) {
    await env.DB.prepare(
      `DELETE FROM backing_copy_pending
        WHERE user_did = ? AND rkey IN (SELECT value FROM json_each(?))`
    )
      .bind(did, JSON.stringify(done))
      .run();
  }
  if (result.retryAfter !== undefined) {
    log.info('backing_copy_paused', { exported: result.exported, retryAfter: result.retryAfter });
  }
  await schedule(env, did, token, now + (result.retryAfter ?? 0) * 1000, now);
}

async function schedule(
  env: Env,
  did: string,
  token: string,
  at: number,
  now: number
): Promise<void> {
  await env.DB.prepare(
    'UPDATE backing_copy_runs SET next_run_at = ? WHERE user_did = ? AND token = ?'
  )
    .bind(at, did, token)
    .run();
  const delaySeconds = Math.min(Math.max(0, Math.ceil((at - now) / 1000)), MAX_QUEUE_DELAY_SECONDS);
  await enqueueJobs(env, [{ type: 'backing.copy', did, token }], { delaySeconds });
}
