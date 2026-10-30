// Background jobs: work a request hands off to the JOBS queue rather than doing
// inline, because it is too slow or too large for one request (a Worker request
// has a subrequest cap) or has to outlive the request (a foreign PDS write that
// may need retrying). Each job is one queue message, and the consumer (`runJobs`,
// the Worker's `queue` handler) runs it, retrying a failure with backoff until
// MAX_ATTEMPTS, then reporting it.
//
// A job must be idempotent: a message can be delivered more than once, and a
// retry re-runs the whole job. Keep each one small (tens of subrequests), since
// the consumer shares one invocation's subrequest cap across its batch. The one
// exception is a document back-catalogue walk (up to BACKFILL_QUERY_COST), which
// draws on a ledger shared by the batch and is retried when that runs out.
//
// To add a job: a variant on `Job`, a case in `runJob`.

import type { Env } from '../types';
import { deleteSnapshots } from './archive/snapshots';
import {
  backfillAuthorDocuments,
  chargeQueries,
  createDocumentApplyContext,
  createQueryLedger,
  ensureAuthorDocuments,
  staleDocumentAuthors,
  D1_QUERIES_PER_INVOCATION,
  type BackfillResult,
  type DocumentApplyContext,
} from './document-store';
import { readDocumentFlags } from './document-flags';
import { isValidDid } from './standard-site';
import { removeMember } from './backing/write';
import { runBackingCopy } from './backing/copy-queue';
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
    }
  /**
   * Pull an author's back catalogue of documents into D1. Normally the walk is
   * skipped when they were listed recently or are inside their retry backoff, so
   * ten readers subscribing to one linkblog cost one walk. `reconcile` (the cron's
   * stale-author pass) re-lists them whatever their freshness, unless a walk has
   * listed them, or failed to, since `queuedAt`: the cron picks the same stalest
   * author every minute until one has run.
   */
  | { type: 'documents.backfill'; did: string; reconcile?: true; queuedAt?: number }
  /**
   * One hop of a reader's copy into their Semble/Margin backing collection
   * (services/backing/copy-queue.ts). `token` names the chain and `seq` the hop;
   * a job from a replaced chain, or a repeat delivery, stops.
   */
  | { type: 'backing.copy'; did: string; token: string; seq: number };

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

/** Most back-catalogue walks one request hands off; the rest wait for the cron's reconcile. */
export const MAX_BACKFILLS_PER_REQUEST = 100;

/**
 * Hand authors' back-catalogue walks to the queue. Each walk then runs in a
 * consumer invocation with its own D1 budget, rather than sharing the caller's.
 * Never throws: a failure to queue is logged, and the cron's reconcile, which
 * takes never-listed authors first, picks them up.
 */
export async function enqueueAuthorBackfills(env: Env, dids: Iterable<string>): Promise<boolean> {
  const unique = [...new Set(dids)].filter((did) => isValidDid(did));
  if (unique.length === 0) return true;
  if (unique.length > MAX_BACKFILLS_PER_REQUEST) {
    log.info('documents_backfills_deferred', {
      deferred: unique.length - MAX_BACKFILLS_PER_REQUEST,
    });
  }
  const jobs = unique
    .slice(0, MAX_BACKFILLS_PER_REQUEST)
    .map((did): Job => ({ type: 'documents.backfill', did }));
  try {
    await enqueueJobs(env, jobs);
    return true;
  } catch (error) {
    log.warn('documents_backfill_enqueue_failed', {
      authors: jobs.length,
      ...serializeError(error),
    });
    return false;
  }
}

/**
 * Queue a re-list of the `limit` stalest authors: the reconcile that closes the
 * holes the firehose leaves. Returns how many were queued.
 */
export async function enqueueStaleAuthors(env: Env, limit: number): Promise<number> {
  const dids = await staleDocumentAuthors(env, limit);
  const queuedAt = Date.now();
  await enqueueJobs(
    env,
    dids.map((did): Job => ({ type: 'documents.backfill', did, reconcile: true, queuedAt }))
  );
  return dids.length;
}

/**
 * Subrequests held back from a batch's document walks for each other job in it.
 * The other jobs are a few dozen subrequests each (JOB_CHUNK items), and they share
 * the invocation's ceiling with the walks.
 */
const OTHER_JOB_RESERVE = 100;

/** The Worker's queue consumer. */
export async function runJobs(batch: MessageBatch<Job>, env: Env): Promise<void> {
  // One ledger for every walk in the batch: the D1 ceiling is per invocation, so
  // walks sized one at a time would add up past it.
  const others = batch.messages.filter((m) => m.body.type !== 'documents.backfill').length;
  const documents = createDocumentApplyContext(
    createQueryLedger(D1_QUERIES_PER_INVOCATION - others * OTHER_JOB_RESERVE)
  );
  for (const message of batch.messages) {
    try {
      await runJob(env, message.body, documents);
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

export async function runJob(
  env: Env,
  job: Job,
  documents: DocumentApplyContext = createDocumentApplyContext()
): Promise<void> {
  switch (job.type) {
    case 'saved.cleanup':
      return cleanUpDeletedSaves(env, job);
    case 'backing.removeMembers':
      return removeBackedMembers(env, job);
    case 'documents.backfill':
      return backfillAuthor(env, job, documents);
    case 'backing.copy':
      return runBackingCopy(env, job);
    default:
      // One sent by a newer deploy than this, mid-rollout: a retry lands on it.
      throw new Error(`unknown job: ${(job as { type?: unknown }).type}`);
  }
}

async function backfillAuthor(
  env: Env,
  job: Extract<Job, { type: 'documents.backfill' }>,
  documents: DocumentApplyContext
): Promise<void> {
  if (job.reconcile) {
    // The reconcile pauses with the ingest kill switch, including the walks it had
    // already queued; the cron queues them again once ingest resumes.
    if (!(await readDocumentFlags(env)).ingestEnabled) return;
    if (job.queuedAt && (await touchedSince(env, job.did, job.queuedAt, documents))) return;
  }
  let result: BackfillResult | null;
  try {
    result = job.reconcile
      ? await backfillAuthorDocuments(env, job.did, documents)
      : await ensureAuthorDocuments(env, job.did, Date.now(), documents);
  } catch (error) {
    // Not retried on the queue: an author left unstamped is still at the front of
    // the reconcile, which re-tries them a minute later, as it always has.
    log.warn('documents_backfill_failed', { authorDid: job.did, ...serializeError(error) });
    reportError(error, { tags: { source: 'queue', job: job.type } });
    return;
  }
  // The batch's ledger had no room left: nothing was written, so a retry runs it
  // in a later batch. A failed list is not retried here either; it is recorded on
  // the author row, whose backoff the reconcile honours.
  if (result?.deferred) throw new Error('query budget exhausted for this batch');
}

/** Whether a walk has listed the author, or failed to, since `since`. */
async function touchedSince(
  env: Env,
  did: string,
  since: number,
  documents: DocumentApplyContext
): Promise<boolean> {
  chargeQueries(documents.ledger, 1);
  const row = await env.DB.prepare(
    'SELECT last_listed_at, last_error_at FROM document_authors WHERE author_did = ?'
  )
    .bind(did)
    .first<{ last_listed_at: number | null; last_error_at: number | null }>();
  return (row?.last_listed_at ?? 0) >= since || (row?.last_error_at ?? 0) >= since;
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
