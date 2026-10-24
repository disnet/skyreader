// Background jobs: work a request hands off to the JOBS queue rather than doing
// inline, because it is too slow or too large for one request (a Worker request
// has a subrequest cap) or has to outlive the request (a foreign PDS write that
// may need retrying). Each job is one queue message, and the consumer (`runJobs`,
// the Worker's `queue` handler) runs it, retrying a failure with backoff until
// MAX_ATTEMPTS, then reporting it.
//
// A job must be idempotent: a message can be delivered more than once, and a
// retry re-runs the whole job. Keep each one small (tens of subrequests), since
// the consumer shares one invocation's subrequest cap across its batch.
//
// To add a job: a variant on `Job`, a case in `runJob`.

import type { Env } from '../types';
import { deleteSnapshots } from './archive/snapshots';
import { removeMember } from './backing/write';
import { TOMBSTONE_TTL_MS } from './backing/sync';
import { getBackgroundSession } from './oauth';
import { createPDSClient } from './pds-client';
import { grantsScopes } from './scope-check';
import { storeFor, type StoredFileRef } from './saved-file-store';
import { parseAtUri } from '../utils/canonical-url';
import { log, serializeError } from '../utils/logger';
import { reportError } from '../observability/sentry';

export type Job =
  /**
   * What deleted saves leave behind: their snapshots, and the bytes of their
   * kept originals (whose saved_files rows the delete already removed).
   */
  | {
      type: 'saved.cleanup';
      did: string;
      rkeys: string[];
      files: { rkey: string; ref: StoredFileRef }[];
    }
  /** A backed Library's deleted saves: their membership records in the foreign collection. */
  | {
      type: 'backing.removeMembers';
      did: string;
      provider: 'semble' | 'margin';
      collectionUri: string;
      members: { linkUri: string; urlNormalized: string }[];
    };

/** How many saves (or records) one job covers: a few subrequests each. */
export const JOB_CHUNK = 25;

/** Tries before a failing job is reported and dropped (matches max_retries + 1). */
export const MAX_ATTEMPTS = 6;

/** How long a request's jobs wait, so they run after its own writes have landed. */
export const JOB_DELAY_SECONDS = 10;

/** Longest a job may still be retrying: its backoff (30 s doubling) with room to spare. */
const TOMBSTONE_HOLD_MS = 60 * 60_000;

/**
 * The `created_at` that keeps an unsave tombstone for TOMBSTONE_HOLD_MS rather
 * than the poll's TOMBSTONE_TTL_MS (it purges by age), so a backed save's
 * tombstone outlasts every retry of the job deleting its foreign record. The
 * poll still clears it as soon as a snapshot shows the record gone.
 */
export function tombstoneStamp(now = Date.now()): number {
  return now + TOMBSTONE_HOLD_MS - TOMBSTONE_TTL_MS;
}

/** Most bytes one send carries: the queue takes 256 KB a batch, 100 messages. */
const SEND_BYTES = 200_000;

/** Queue the jobs, in as few sends as the queue allows. */
export async function enqueueJobs(
  env: Env,
  jobs: Job[],
  opts: { delaySeconds?: number } = {}
): Promise<void> {
  let batch: MessageSendRequest<Job>[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length > 0) await env.JOBS.sendBatch(batch, opts);
    batch = [];
    bytes = 0;
  };
  for (const body of jobs) {
    const size = JSON.stringify(body).length + 100;
    if (batch.length === 100 || bytes + size > SEND_BYTES) await flush();
    batch.push({ body });
    bytes += size;
  }
  await flush();
}

/** The Worker's queue consumer. */
export async function runJobs(batch: MessageBatch<Job>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runJob(env, message.body);
      message.ack();
    } catch (error) {
      if (message.attempts >= MAX_ATTEMPTS) {
        log.error('job_failed', { type: message.body.type, ...serializeError(error) });
        reportError(error, { tags: { source: 'queue', job: message.body.type } });
        message.ack();
      } else {
        log.warn('job_retry', {
          type: message.body.type,
          attempts: message.attempts,
          ...serializeError(error),
        });
        message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 3600) });
      }
    }
  }
}

export async function runJob(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case 'saved.cleanup':
      return cleanUpDeletedSaves(env, job);
    case 'backing.removeMembers':
      return removeBackedMembers(env, job);
    default:
      // One sent by a newer deploy than this, mid-rollout: a retry lands on it.
      throw new Error(`unknown job: ${(job as { type?: unknown }).type}`);
  }
}

async function cleanUpDeletedSaves(
  env: Env,
  job: Extract<Job, { type: 'saved.cleanup' }>
): Promise<void> {
  // Only saves that are still gone: storage is never taken from a live save (the
  // jobs are queued before the delete, which may yet have failed).
  const live = await env.DB.prepare(
    `SELECT rkey FROM saved_articles
      WHERE user_did = ? AND rkey IN (SELECT value FROM json_each(?))`
  )
    .bind(job.did, JSON.stringify(job.rkeys))
    .all<{ rkey: string }>();
  const kept = new Set((live.results ?? []).map((r) => r.rkey));
  const gone = job.rkeys.filter((r) => !kept.has(r));

  for (const { rkey, ref } of job.files) {
    if (kept.has(rkey)) continue;
    // Deleting an object that's already gone succeeds, so a retry is safe.
    const store = storeFor(env, ref);
    if (store) await store.delete(ref);
    else log.warn('saved_file_store_unreachable', { rkey, storage: ref.storage });
  }

  // Only the ones that have snapshots: most saves have none, and asking one at a
  // time would spend the batch's subrequests on finding that out.
  const snapped = await env.DB.prepare(
    `SELECT DISTINCT save_rkey FROM saved_snapshots
      WHERE user_did = ? AND save_rkey IN (SELECT value FROM json_each(?))`
  )
    .bind(job.did, JSON.stringify(gone))
    .all<{ save_rkey: string }>();
  await deleteSnapshots(
    env,
    job.did,
    (snapped.results ?? []).map((r) => r.save_rkey)
  );
}

async function removeBackedMembers(
  env: Env,
  job: Extract<Job, { type: 'backing.removeMembers' }>
): Promise<void> {
  // Renew the unsave tombstones on every try (see tombstoneStamp), so a job held
  // up behind a backlog can't outlive them.
  await env.DB.prepare(
    `UPDATE backed_unsave_tombstones SET created_at = MAX(created_at, ?)
      WHERE user_did = ? AND external_collection = ?
        AND url_normalized IN (SELECT value FROM json_each(?))`
  )
    .bind(
      tombstoneStamp(),
      job.did,
      job.collectionUri,
      JSON.stringify(job.members.map((m) => m.urlNormalized))
    )
    .run();

  // A record uri that doesn't parse can never be deleted: skip it rather than
  // fail the rest of the job on it every try.
  const refs = job.members.flatMap((m) => {
    const ref = parseAtUri(m.linkUri);
    if (!ref) log.warn('backed_member_bad_uri', { linkUri: m.linkUri });
    return ref ? [{ uri: m.linkUri, ref }] : [];
  });
  if (refs.length === 0) return;
  const scopes = [...new Set(refs.map(({ ref }) => `repo:${ref.collection}`))];
  const session = await getBackgroundSession(env, job.did, (granted) =>
    grantsScopes(granted, scopes)
  );
  // Signed out everywhere, mid-refresh, or no session with the permission: try
  // again later.
  if (!session) throw new Error('no session to remove backed members with');
  const pds = createPDSClient(session);
  // Each one tried, so one that fails doesn't hold back the rest. Deleting a
  // record that's already gone succeeds, so the retry of a partial run is safe.
  let failure: unknown = null;
  for (const { uri } of refs) {
    await removeMember(pds, job.provider, { linkUri: uri }).catch((error) => {
      failure ??= error;
    });
  }
  if (failure) throw failure;
}
