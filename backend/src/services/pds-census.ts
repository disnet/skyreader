// A census of what readers' PDS hosts do where implementations differ
// (migrations/0126). Readers' PDSes aren't all Bluesky's, and a fix that leans
// on one implementation's quirks can hammer another's (#810). PDSClient tallies
// what each response showed here, per isolate, and the tallies are added to
// pds_host_traits now and then, so the admin can show which behaviors are out
// there and the fake PDS's profiles (test/helpers/fake-pds.ts) can follow.
//
// It's a sample, not an audit: an isolate that dies before its next flush loses
// what it counted, which is fine for telling one behavior from another.
import type { Env } from '../types';
import { log } from '../utils/logger';

export interface PdsObservation {
  /** A write (POST) the PDS accepted. */
  writeOk?: boolean;
  /** A write the PDS refused with 429. */
  writeRefused?: boolean;
  rateLimitHeaders?: boolean;
  retryAfter?: boolean;
  /** The PDS asked for a DPoP nonce: in the JSON body too, or in the header alone. */
  nonce?: 'body' | 'header-only';
  /** A RecordNotFound, worded as the reference PDS words it or otherwise. */
  notFound?: 'reference' | 'other';
  server?: string | null;
}

interface Tally {
  writesOk: number;
  writesOkRateLimitHeaders: number;
  writesRefused: number;
  writesRefusedRateLimitHeaders: number;
  writesRefusedRetryAfter: number;
  nonceInBody: number;
  nonceHeaderOnly: number;
  notFoundReference: number;
  notFoundOther: number;
  server: string | null;
}

/** Flush once the oldest tally is this old, or the isolate has this many hosts. */
const FLUSH_AFTER_MS = 60_000;
const FLUSH_AT_HOSTS = 20;

const pending = new Map<string, Tally>();
let oldestPendingAt = 0;

function emptyTally(): Tally {
  return {
    writesOk: 0,
    writesOkRateLimitHeaders: 0,
    writesRefused: 0,
    writesRefusedRateLimitHeaders: 0,
    writesRefusedRetryAfter: 0,
    nonceInBody: 0,
    nonceHeaderOnly: 0,
    notFoundReference: 0,
    notFoundOther: 0,
    server: null,
  };
}

/** Count what one PDS response showed. Never throws: it's bookkeeping. */
export function observePds(pdsUrl: string, obs: PdsObservation): void {
  let host: string;
  try {
    host = new URL(pdsUrl).host;
  } catch {
    return;
  }
  let t = pending.get(host);
  if (!t) {
    if (pending.size === 0) oldestPendingAt = Date.now();
    pending.set(host, (t = emptyTally()));
  }
  if (obs.writeOk) {
    t.writesOk++;
    if (obs.rateLimitHeaders) t.writesOkRateLimitHeaders++;
  }
  if (obs.writeRefused) {
    t.writesRefused++;
    if (obs.rateLimitHeaders) t.writesRefusedRateLimitHeaders++;
    if (obs.retryAfter) t.writesRefusedRetryAfter++;
  }
  if (obs.nonce === 'body') t.nonceInBody++;
  if (obs.nonce === 'header-only') t.nonceHeaderOnly++;
  if (obs.notFound === 'reference') t.notFoundReference++;
  if (obs.notFound === 'other') t.notFoundOther++;
  if (obs.server) t.server = obs.server.slice(0, 100);
}

/**
 * Add this isolate's tallies to pds_host_traits, if they're due (or `force`).
 * One upsert per host, in one batch. Call it after the response, under
 * waitUntil; a failure drops the tallies rather than retrying.
 */
export async function flushPdsCensus(env: Env, force = false, now = Date.now()): Promise<void> {
  if (pending.size === 0) return;
  if (!force && pending.size < FLUSH_AT_HOSTS && now - oldestPendingAt < FLUSH_AFTER_MS) return;
  const tallies = [...pending];
  pending.clear();
  const seen = Math.floor(now / 1000);
  try {
    await env.DB.batch(
      tallies.map(([host, t]) =>
        env.DB.prepare(
          `INSERT INTO pds_host_traits
             (host, first_seen_at, last_seen_at, writes_ok, writes_ok_rate_limit_headers,
              writes_refused, writes_refused_rate_limit_headers, writes_refused_retry_after,
              nonce_in_body, nonce_header_only, not_found_reference_message,
              not_found_other_message, server)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(host) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             writes_ok = writes_ok + excluded.writes_ok,
             writes_ok_rate_limit_headers =
               writes_ok_rate_limit_headers + excluded.writes_ok_rate_limit_headers,
             writes_refused = writes_refused + excluded.writes_refused,
             writes_refused_rate_limit_headers =
               writes_refused_rate_limit_headers + excluded.writes_refused_rate_limit_headers,
             writes_refused_retry_after =
               writes_refused_retry_after + excluded.writes_refused_retry_after,
             nonce_in_body = nonce_in_body + excluded.nonce_in_body,
             nonce_header_only = nonce_header_only + excluded.nonce_header_only,
             not_found_reference_message =
               not_found_reference_message + excluded.not_found_reference_message,
             not_found_other_message = not_found_other_message + excluded.not_found_other_message,
             server = COALESCE(excluded.server, server)`
        ).bind(
          host,
          seen,
          seen,
          t.writesOk,
          t.writesOkRateLimitHeaders,
          t.writesRefused,
          t.writesRefusedRateLimitHeaders,
          t.writesRefusedRetryAfter,
          t.nonceInBody,
          t.nonceHeaderOnly,
          t.notFoundReference,
          t.notFoundOther,
          t.server
        )
      )
    );
  } catch (error) {
    log.warn('pds_census_flush_failed', { hosts: tallies.length, error: String(error) });
  }
}

/** For tests: forget anything tallied and not yet flushed. */
export function resetPdsCensus(): void {
  pending.clear();
}
