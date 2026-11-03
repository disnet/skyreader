// standard.site follows made anywhere in the Atmosphere (Leaflet, a
// standard.site reader, another Atmospheric app) become Skyreader subscriptions
// on their own, for every reader, Atmospheric sync or not.
//
// The two-way reconcile (atmosphere-subscription-sync.ts) only runs inside
// `/api/sync/full`, which needs sync on and a reader pressing a button, so a
// follow made in Leaflet never reached the reader, or a sync client like
// FreshRSS that lists Skyreader's subscriptions. This is the read-only half,
// always on:
//
//  - the JetstreamPoller's subscriptions stream carries every
//    `site.standard.graph.subscription` commit, and queues a scan of the
//    reader's graph for each reader it sees one from, so a follow lands within
//    a minute or so;
//  - a cron pass lists each reader's graph from their PDS (never-listed readers
//    first, then weekly), for follows made before this existed and anything the
//    firehose missed while we weren't watching.
//
// Nothing here writes to the graph. That keeps it honest for a reader with sync
// off, and it is why each graph record is imported only the first time we see
// it (atmosphere_graph_edges): an unsubscribe in Skyreader can't delete the
// follow from their graph, so re-importing whatever the graph holds would undo
// it. An unfollow elsewhere removes the subscription only when this import
// created it; a feed the reader already followed here is theirs to keep.

import type { Env } from '../types';
import { getUserTierLimits } from './user-tier';
import { resolvePdsUrl } from '../utils/did-resolver';
import { generateTid } from '../utils/tid';
import {
  SUBSCRIPTION_COLLECTION,
  isPublicationUri,
  subscriptionRkey,
} from './atmosphere-subscription';
import { resolvePublicationMeta, titleFor } from './atmosphere-subscription-sync';
import { deleteSubscriptionFromPds } from './subscription-sync';
import { JOB_DELAY_SECONDS, enqueueAuthorBackfills, enqueueJobs, type Job } from './jobs';
import { getBackgroundSession } from './oauth';
import { grantsScopes } from './scope-check';
import { log } from '../utils/logger';

const SUBSCRIPTION_NSID = 'app.skyreader.feed.subscription';

/** A reader's graph is listed again this often, to catch what the firehose missed. */
export const GRAPH_RESCAN_INTERVAL_S = 7 * 24 * 60 * 60;
/** A queued scan that hasn't reported back by now is queued again. */
const GRAPH_SCAN_REQUEUE_S = 30 * 60;
/** Readers whose scan the cron queues per minute. */
export const GRAPH_SCANS_PER_CRON = 5;
/** listRecords pages one scan reads (100 records each). */
const MAX_SCAN_PAGES = 10;
/**
 * New graph records one scan job applies. An import costs a handful of
 * subrequests (the publication's DID document and record, a profile for a
 * fallback title, the inserts), so this keeps a job inside the "tens of
 * subrequests" jobs.ts asks of each. A reader with more is picked up again by
 * the next cron pass, since their scan isn't marked done.
 */
const MAX_SCAN_OPS = 8;
const FETCH_TIMEOUT_MS = 10_000;
/** A scan that couldn't reach the reader's PDS is tried again after this. */
const UNREACHABLE_RETRY_S = 24 * 60 * 60;

export type GraphEdgeCreateOutcome =
  /** A new subscription, active. */
  | 'imported'
  /** A new subscription, parked because the plan's active limit is full. */
  | 'parked'
  /** The reader already follows this publication here. */
  | 'claimed'
  /** This graph record was seen before. */
  | 'known'
  /** Not imported: the plan's mirror cap is full. Not recorded, so a later scan retries. */
  | 'over-cap'
  /** Not a publication follow, or one a publication switch is replacing. */
  | 'skipped';

export type GraphEdgeDeleteOutcome =
  /** The subscription this follow imported was removed. */
  | 'removed'
  /** Forgotten, but no subscription to remove (or not ours to remove). */
  | 'kept'
  /** Not a graph record we know. */
  | 'unknown'
  /**
   * Sync is on and its PDS record couldn't be taken down (no background session,
   * or the delete failed). Left for the two-way reconcile, which removes it on the
   * reader's next sync.
   */
  | 'deferred';

/**
 * A graph record was created (or seen in a listing). Imports the publication it
 * follows as an `atproto.documents` subscription, the way the two-way reconcile
 * does, unless this record was seen before.
 *
 * `syncEnabled` marks the new row `pds_dirty`, so the reader's next sync mirrors
 * it to their app.skyreader subscription list like any other feed.
 */
export async function applyGraphEdgeCreate(
  env: Env,
  did: string,
  rkey: string,
  publicationUri: unknown,
  opts: { syncEnabled: boolean }
): Promise<GraphEdgeCreateOutcome> {
  if (typeof publicationUri !== 'string' || !isPublicationUri(publicationUri) || !rkey) {
    return 'skipped';
  }
  const pubUri = publicationUri;

  const known = await env.DB.prepare(
    'SELECT publication_uri FROM atmosphere_graph_edges WHERE user_did = ? AND rkey = ?'
  )
    .bind(did, rkey)
    .first<{ publication_uri: string }>();
  if (known?.publication_uri === pubUri) return 'known';
  // The record was edited to follow another publication: an unfollow of the old
  // one, then a follow of the new.
  if (known) await applyGraphEdgeDelete(env, did, rkey, opts);

  // A record Skyreader wrote itself, for an in-app follow with sync on. The
  // reader's subscription list is the truth for those; importing one would undo
  // an unsubscribe made after sync was turned off, which leaves the record behind.
  const ownEdge = (await subscriptionRkey(pubUri)) === rkey;

  const local = await env.DB.prepare(
    `SELECT record_uri, atmosphere_synced,
            (SELECT 1 FROM subscriptions_cache p
              WHERE p.user_did = ? AND p.atmosphere_previous_feed_url = ?) AS superseded
       FROM (SELECT 1) LEFT JOIN subscriptions_cache sc
         ON sc.user_did = ? AND sc.source_type = 'atproto.documents' AND sc.feed_url = ?`
  )
    .bind(did, pubUri, did, pubUri)
    .first<{
      record_uri: string | null;
      atmosphere_synced: number | null;
      superseded: number | null;
    }>();

  // A publication switch is deleting this edge (the reconcile owns that), so
  // importing it would bring the old follow back. Recorded like a claim, so it
  // isn't looked at again.
  if (local?.record_uri || local?.superseded || ownEdge) {
    const statements = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO atmosphere_graph_edges (user_did, rkey, publication_uri, record_uri)
         VALUES (?, ?, ?, NULL)`
      ).bind(did, rkey, pubUri),
    ];
    // With sync on, present in both places is "synced", as the reconcile marks it.
    if (opts.syncEnabled && local?.record_uri && local.atmosphere_synced === null) {
      statements.push(
        env.DB.prepare(
          'UPDATE subscriptions_cache SET atmosphere_synced = unixepoch() WHERE record_uri = ?'
        ).bind(local.record_uri)
      );
    }
    await env.DB.batch(statements);
    return local?.record_uri ? 'claimed' : 'skipped';
  }

  const limits = await getUserTierLimits(env, did);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(active = 1), 0) AS active
       FROM subscriptions_cache WHERE user_did = ?`
  )
    .bind(did)
    .first<{ total: number; active: number }>();
  if ((counts?.total ?? 0) >= limits.maxMirroredSubscriptions) return 'over-cap';
  // Over the active limit the follow is parked, as the reconcile does: kept and
  // shown in Manage feeds for reactivation, not serviced.
  const active = (counts?.active ?? 0) < limits.maxSubscriptions ? 1 : 0;

  // Never null for a URI isPublicationUri accepted and that parses; one that
  // doesn't parse is skipped for good.
  const meta = await resolvePublicationMeta(pubUri);
  if (!meta) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO atmosphere_graph_edges (user_did, rkey, publication_uri, record_uri)
       VALUES (?, ?, ?, NULL)`
    )
      .bind(did, rkey, pubUri)
      .run();
    return 'skipped';
  }
  const title = await titleFor(meta);

  const recordUri = `at://${did}/${SUBSCRIPTION_NSID}/${generateTid()}`;
  // One batch, so the edge row says whether *this* insert made the subscription:
  // when another path inserted it first (the unique feed index makes ours a
  // no-op), the edge records NULL and an unfollow leaves that row alone.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, category, created_at, source_type, subject_did,
          custom_title, custom_icon_url, atmosphere_synced, active, pds_dirty)
       VALUES (?, ?, ?, ?, NULL, unixepoch(), 'atproto.documents', ?, NULL, NULL, unixepoch(), ?, ?)`
    ).bind(did, recordUri, pubUri, title, meta.subjectDid, active, opts.syncEnabled ? 1 : 0),
    env.DB.prepare(
      `INSERT OR IGNORE INTO atmosphere_graph_edges (user_did, rkey, publication_uri, record_uri)
       SELECT ?, ?, ?, (SELECT record_uri FROM subscriptions_cache WHERE record_uri = ?)`
    ).bind(did, rkey, pubUri, recordUri),
  ]);

  const created = await env.DB.prepare('SELECT 1 FROM subscriptions_cache WHERE record_uri = ?')
    .bind(recordUri)
    .first();
  if (!created) return 'claimed';

  // A new follow needs its author's back catalogue, like any other subscription.
  await enqueueAuthorBackfills(env, [meta.subjectDid]);
  log.info('atmosphere_graph_imported', { did, publication: pubUri, active: active === 1 });
  return active ? 'imported' : 'parked';
}

/**
 * A graph record was deleted (or is gone from a full listing). Removes the
 * subscription its import created, if the reader still has it.
 */
export async function applyGraphEdgeDelete(
  env: Env,
  did: string,
  rkey: string,
  opts: { syncEnabled: boolean }
): Promise<GraphEdgeDeleteOutcome> {
  // `other_edge` is another record still following the subscription, under the
  // publication this edge was for or the one the row follows now (a publication
  // switch moves the row's feed_url and leaves the edge as it was).
  const edge = await env.DB.prepare(
    `SELECT e.publication_uri, e.record_uri, sc.record_uri AS sub,
            (SELECT o.rkey FROM atmosphere_graph_edges o
              WHERE o.user_did = e.user_did AND o.rkey != e.rkey
                AND o.publication_uri IN (e.publication_uri, sc.feed_url)
              LIMIT 1) AS other_edge
       FROM atmosphere_graph_edges e
       LEFT JOIN subscriptions_cache sc ON sc.record_uri = e.record_uri
      WHERE e.user_did = ? AND e.rkey = ?`
  )
    .bind(did, rkey)
    .first<{
      publication_uri: string;
      record_uri: string | null;
      sub: string | null;
      other_edge: string | null;
    }>();
  if (!edge) return 'unknown';

  const forget = env.DB.prepare(
    'DELETE FROM atmosphere_graph_edges WHERE user_did = ? AND rkey = ?'
  ).bind(did, rkey);

  // Not ours to remove, or already unsubscribed here.
  if (!edge.record_uri || !edge.sub) {
    await forget.run();
    return 'kept';
  }
  // Still followed through another record (two apps each wrote one). That record
  // takes over the subscription, so the last unfollow still removes it.
  if (edge.other_edge) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE atmosphere_graph_edges SET record_uri = ?
          WHERE user_did = ? AND rkey = ? AND record_uri IS NULL`
      ).bind(edge.record_uri, did, edge.other_edge),
      forget,
    ]);
    return 'kept';
  }

  // With sync on the row has (or will have) a record in the reader's
  // app.skyreader subscription list, and the next sync would pull it straight
  // back, so that record goes first.
  if (opts.syncEnabled) {
    const session = await getBackgroundSession(env, did, (granted) =>
      grantsScopes(granted, [`repo:${SUBSCRIPTION_NSID}`])
    );
    if (!session) return 'deferred';
    const subRkey = edge.record_uri.split('/').pop() ?? '';
    const del = await deleteSubscriptionFromPds(session, subRkey);
    if (!del.success) {
      log.warn('atmosphere_graph_unfollow_deferred', { did, error: del.error });
      return 'deferred';
    }
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM subscriptions_cache WHERE record_uri = ?').bind(edge.record_uri),
    forget,
  ]);
  log.info('atmosphere_graph_unfollowed', { did, publication: edge.publication_uri });
  return 'removed';
}

/**
 * Queue graph scans for the readers who are due: never listed first, then the
 * stalest past GRAPH_RESCAN_INTERVAL_S. Returns how many were queued.
 */
export async function enqueueDueGraphScans(env: Env, limit: number): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(
    `SELECT u.did FROM users u
       LEFT JOIN atmosphere_graph_scans s ON s.user_did = u.did
      WHERE u.registered_at IS NOT NULL
        AND (s.scanned_at IS NULL OR s.scanned_at < ?)
        AND (s.queued_at IS NULL OR s.queued_at < ?)
      ORDER BY s.scanned_at IS NOT NULL, s.scanned_at
      LIMIT ?`
  )
    .bind(now - GRAPH_RESCAN_INTERVAL_S, now - GRAPH_SCAN_REQUEUE_S, limit)
    .all<{ did: string }>();
  const dids = (due.results ?? []).map((r) => r.did);
  if (dids.length === 0) return 0;

  await enqueueJobs(
    env,
    dids.map((did): Job => ({ type: 'atmosphere.graphScan', did }))
  );
  await env.DB.batch(
    dids.map((did) =>
      env.DB.prepare(
        `INSERT INTO atmosphere_graph_scans (user_did, queued_at) VALUES (?, ?)
         ON CONFLICT(user_did) DO UPDATE SET queued_at = excluded.queued_at`
      ).bind(did, now)
    )
  );
  return dids.length;
}

/**
 * Scan these readers' graphs soon, because the firehose saw them follow or
 * unfollow. The poller hands the work here rather than applying the commit
 * itself: an import fetches from the publication's PDS, which its author
 * controls, and that has no place inside the poll cycle every reader shares. A
 * listing is also order-proof, where a follow and an unfollow in one burst
 * could be applied the wrong way round.
 */
export async function requestGraphScans(env: Env, dids: Iterable<string>): Promise<void> {
  const jobs = [...new Set(dids)].map((did): Job => ({ type: 'atmosphere.graphScan', did }));
  if (jobs.length > 0) await enqueueJobs(env, jobs, { delaySeconds: JOB_DELAY_SECONDS });
}

interface GraphListing {
  records: Array<{ rkey: string; publication: unknown }>;
  /** True when the listing reached the end of the collection. */
  exhaustive: boolean;
}

/** The reader's graph records, read from their PDS. Public, so no session needed. */
async function listGraph(did: string): Promise<GraphListing | null> {
  const pdsUrl = await resolvePdsUrl(did);
  if (!pdsUrl) return null;
  const records: GraphListing['records'] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const params = new URLSearchParams({
      repo: did,
      collection: SUBSCRIPTION_COLLECTION,
      limit: '100',
    });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      records?: Array<{ uri?: unknown; value?: { publication?: unknown } }>;
      cursor?: string;
    };
    const pageRecords = data.records ?? [];
    for (const rec of pageRecords) {
      const rkey = typeof rec.uri === 'string' ? rec.uri.split('/').pop() : undefined;
      if (rkey) records.push({ rkey, publication: rec.value?.publication });
    }
    if (!data.cursor || pageRecords.length === 0) return { records, exhaustive: true };
    cursor = data.cursor;
  }
  return { records, exhaustive: false };
}

/**
 * One reader's graph scan (the `atmosphere.graphScan` job). When the listing is
 * complete, records we know of that are gone are unfollows; then the records we
 * haven't seen are imported. A scan that runs out of imports is marked not done,
 * so the cron picks it up again next minute and carries on from where it got to.
 */
export async function scanGraphFollows(env: Env, did: string): Promise<void> {
  const listing = await listGraph(did);
  const now = Math.floor(Date.now() / 1000);
  const markScanned = (scannedAt: number | null) =>
    env.DB.prepare(
      `INSERT INTO atmosphere_graph_scans (user_did, scanned_at, queued_at) VALUES (?, ?, NULL)
       ON CONFLICT(user_did) DO UPDATE SET scanned_at = excluded.scanned_at, queued_at = NULL`
    )
      .bind(did, scannedAt)
      .run();

  if (!listing) {
    // An unreachable PDS or a gone account: tried again in a day, not every
    // half hour, so dead accounts can't crowd out the living.
    log.warn('atmosphere_graph_scan_unreachable', { did });
    await markScanned(now - GRAPH_RESCAN_INTERVAL_S + UNREACHABLE_RETRY_S);
    return;
  }

  const [knownRows, settings] = await Promise.all([
    env.DB.prepare('SELECT rkey, publication_uri FROM atmosphere_graph_edges WHERE user_did = ?')
      .bind(did)
      .all<{ rkey: string; publication_uri: string }>(),
    env.DB.prepare('SELECT pds_sync_enabled FROM user_settings WHERE user_did = ?')
      .bind(did)
      .first<{ pds_sync_enabled: number }>(),
  ]);
  const opts = { syncEnabled: settings?.pds_sync_enabled === 1 };
  const known = new Map((knownRows.results ?? []).map((r) => [r.rkey, r.publication_uri]));
  const listed = new Set(listing.records.map((r) => r.rkey));

  // Absence only means deletion when the whole graph was read. Deletes first, so
  // a backlog of imports can't hold an unfollow back.
  let ops = 0;
  if (listing.exhaustive) {
    for (const rkey of known.keys()) {
      if (listed.has(rkey)) continue;
      if (ops >= MAX_SCAN_OPS) break;
      const outcome = await applyGraphEdgeDelete(env, did, rkey, opts);
      if (outcome === 'removed') ops++;
      // No session to delete with: every other one would defer too.
      if (outcome === 'deferred') break;
    }
  }

  let leftOver = false;
  for (const rec of listing.records) {
    if (typeof rec.publication !== 'string' || !isPublicationUri(rec.publication)) continue;
    if (known.get(rec.rkey) === rec.publication) continue;
    // Only an import spends much (the publication's PDS, a profile); the other
    // outcomes are a statement or two and don't count.
    if (ops >= MAX_SCAN_OPS) {
      leftOver = true;
      break;
    }
    const outcome = await applyGraphEdgeCreate(env, did, rec.rkey, rec.publication, opts);
    if (outcome === 'imported' || outcome === 'parked') ops++;
    // The plan's mirror cap is full, so nothing else would import either. Not
    // recorded, so a later scan imports them once there's room.
    if (outcome === 'over-cap') break;
  }

  // A listing cut off at the page cap is as much as we'll ever read: done.
  await markScanned(leftOver ? null : now);
}
