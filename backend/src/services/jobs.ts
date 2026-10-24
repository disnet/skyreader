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
import { deleteSavedFile } from '../routes/saved-pdf';
import { deleteSnapshots } from './archive/snapshots';
import { removeMember } from './backing/write';
import { getBackgroundSession } from './oauth';
import { createPDSClient } from './pds-client';
import { grantsScopes } from './scope-check';
import { parseAtUri } from '../utils/canonical-url';
import { log, serializeError } from '../utils/logger';
import { reportError } from '../observability/sentry';

export type Job =
  /** The storage a deleted save leaves behind: its uploaded file and snapshots. */
  | { type: 'saved.cleanup'; did: string; rkeys: string[] }
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

/** Queue the jobs, in as few sends as the queue allows (100 messages a send). */
export async function enqueueJobs(env: Env, jobs: Job[]): Promise<void> {
  for (let i = 0; i < jobs.length; i += 100) {
    await env.JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
  }
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
      return cleanUpDeletedSaves(env, job.did, job.rkeys);
    case 'backing.removeMembers':
      return removeBackedMembers(env, job);
    default:
      // One sent by a newer deploy than this, mid-rollout: a retry lands on it.
      throw new Error(`unknown job: ${(job as { type?: unknown }).type}`);
  }
}

async function cleanUpDeletedSaves(env: Env, did: string, rkeys: string[]): Promise<void> {
  // Only saves that are still gone: storage is never taken from a live save.
  const live = await env.DB.prepare(
    `SELECT rkey FROM saved_articles
      WHERE user_did = ? AND rkey IN (SELECT value FROM json_each(?))`
  )
    .bind(did, JSON.stringify(rkeys))
    .all<{ rkey: string }>();
  const kept = new Set((live.results ?? []).map((r) => r.rkey));
  const gone = rkeys.filter((r) => !kept.has(r));
  for (const rkey of gone) await deleteSavedFile(env, did, rkey);
  await deleteSnapshots(env, did, gone);
}

async function removeBackedMembers(
  env: Env,
  job: Extract<Job, { type: 'backing.removeMembers' }>
): Promise<void> {
  // The unsave tombstones keep these saves out of the Library until a snapshot
  // shows the foreign records gone, but only for TOMBSTONE_TTL_MS. Renewed on
  // every try, so they outlast the retries; a job that finally fails lets them
  // lapse, and the Library shows the foreign collection as it really is.
  await env.DB.prepare(
    `UPDATE backed_unsave_tombstones SET created_at = ?
      WHERE user_did = ? AND external_collection = ?
        AND url_normalized IN (SELECT value FROM json_each(?))`
  )
    .bind(
      Date.now(),
      job.did,
      job.collectionUri,
      JSON.stringify(job.members.map((m) => m.urlNormalized))
    )
    .run();

  const refs = job.members.map((m) => ({ uri: m.linkUri, ref: parseAtUri(m.linkUri) }));
  const scopes = [...new Set(refs.flatMap(({ ref }) => (ref ? [`repo:${ref.collection}`] : [])))];
  const session = await getBackgroundSession(env, job.did, (granted) =>
    grantsScopes(granted, scopes)
  );
  // Signed out everywhere, mid-refresh, or no session with the permission: try
  // again later.
  if (!session) throw new Error('no session to remove backed members with');
  const pds = createPDSClient(session);
  // Deleting a record that's already gone succeeds, so a retry is safe.
  for (const { uri } of refs) await removeMember(pds, job.provider, { linkUri: uri });
}
