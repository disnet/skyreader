// Two-way reconcile between a user's standard.site follows
// (`site.standard.graph.subscription` on their PDS) and their Skyreader
// `atproto.documents` subscriptions.
//
// This is the read half of the portable follow edge that
// atmosphere-subscription.ts already writes: when a user follows a publication
// in Skyreader we write a graph edge; here we pull edges made anywhere in the
// Atmosphere back into the reader, and propagate deletions both ways.
//
// The disambiguation hinges on one shadow marker: subscriptions_cache.
// atmosphere_synced (the unixepoch a row was last confirmed present in the
// graph). It lets us tell a *newly added* local sub (edge not yet written)
// apart from one that was *deleted elsewhere* (edge was there, now gone):
//
//   in graph │ local │ synced │ action
//   ─────────┼───────┼────────┼───────────────────────────────────────────────
//      ✓     │   ✗   │   —    │ import into Skyreader, mark synced
//      ✓     │   ✓   │  null  │ claim (mark synced) — usually an in-app follow
//      ✓     │   ✓   │  set   │ no-op
//      ✗     │   ✓   │  set   │ deleted elsewhere → remove local sub + PDS record
//      ✗     │   ✓   │  null  │ local-only → write the graph edge, mark synced
//
// Gated by the caller on pds_sync_enabled (Atmospheric sync) — there's no
// separate opt-in; reconcile always runs while that switch is on.
// Only effective for `atproto.documents` subs whose feedUrl is a publication
// URI — RSS and collection subs have no graph equivalent and are never touched.

import type { Env, Session } from '../types';
import { createPDSClient } from './pds-client';
import { getUserTierLimits } from './user-tier';
import { fetchProfiles } from './bsky-appview';
import { resolvePdsUrl } from '../utils/did-resolver';
import { generateTid } from '../utils/tid';
import {
  SUBSCRIPTION_COLLECTION,
  deleteAtmosphereSubscription,
  isPublicationUri,
  writeAtmosphereSubscription,
} from './atmosphere-subscription';
import { pushSubscriptionToPds, deleteSubscriptionFromPds } from './subscription-sync';
import type { LimitNotice } from './subscription-sync';
import { log } from '../utils/logger';
import {
  chargeQueries,
  createBackfillScheduler,
  MAX_SYNC_BACKFILLS,
  type QueryLedger,
} from './document-store';

const SUBSCRIPTION_NSID = 'app.skyreader.feed.subscription';

// Limit PDS listing pages (1 subrequest per 100 records), matching subscription-sync.
const MAX_LIST_PAGES = 20;

// Cap the number of PDS-mutating operations (imports + edge writes + deletes)
// per run to stay well under the Worker subrequest budget. When more remain,
// `hasMore` is set so the caller loops — exactly like syncSubscriptions batching.
const MAX_OPS = 20;

/**
 * Subrequests one reconcile op costs, charged flat against the invocation's ledger.
 * Sized on the largest of them — an import: the publication's DID document and its
 * record, the owner's profile for a fallback title, the local insert, and the mirror
 * record pushed to the user's PDS. A delete or an edge write is a PDS write plus a
 * statement, comfortably under it.
 *
 * `MAX_OPS` of these is the dominant term of this half of a sync request, and until
 * it was charged it was hidden inside `/api/sync`'s flat reserve — where it could
 * quietly account for the whole of it, leaving the reserve to cover nothing.
 */
const SUBREQUESTS_PER_ATMOSPHERE_OP = 8;

/**
 * Subrequests the graph listing spent, derived from what it returned: a page is 100
 * records, and a listing that stopped on the page cap spent every page it was
 * allowed. A server that returns short pages costs more calls than this counts, so
 * treat it as the listing's floor — it exists so the term is present in the ledger
 * at all, which for a full graph is the difference between 1 and 20.
 */
function graphListSubrequests(records: number, truncated: boolean): number {
  if (truncated) return MAX_LIST_PAGES;
  return Math.max(1, Math.ceil(records / 100));
}

export interface AtmosphereSyncResult {
  success: boolean;
  error?: string;
  /** Pulled from the graph into Skyreader. */
  imported: number;
  /** Removed locally because the graph edge was deleted elsewhere. */
  removed: number;
  /** Local-only subs whose graph edge we wrote back. */
  pushed: number;
  /** Not imported because the tier subscription limit was reached. */
  skipped: number;
  warnings: string[];
  /**
   * Plan-limit outcomes (follows parked over the active cap, follows not
   * imported over the mirror cap). Separate from `warnings` for the same reason
   * as in subscription-sync.ts: the client pairs these with an upgrade prompt,
   * and a failed graph write must never be dressed up as one.
   */
  limitNotices: LimitNotice[];
  /** More work remains — call reconcile again. */
  hasMore?: boolean;
}

interface LocalDocSub {
  record_uri: string;
  feed_url: string;
  atmosphere_synced: number | null;
  atmosphere_previous_feed_url: string | null;
}

interface PublicationMeta {
  subjectDid: string;
  /** Publication display name, or '' if it couldn't be resolved. */
  name: string;
  /** Canonical site URL, if the publication record exposes one. */
  siteUrl?: string;
}

function extractRkey(uri: string): string {
  const parts = uri.split('/');
  return parts[parts.length - 1];
}

function parsePublicationUri(
  uri: string
): { did: string; collection: string; rkey: string } | null {
  const m = uri.match(/^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { did: m[1], collection: m[2], rkey: m[3] };
}

// Resolve a publication's display name + site URL from the author's PDS. Public
// `getRecord`, best-effort: on failure we still return the author DID so the
// publication can be imported with a fallback title.
async function resolvePublicationMeta(pubUri: string): Promise<PublicationMeta | null> {
  const parsed = parsePublicationUri(pubUri);
  if (!parsed) return null;

  const pdsUrl = await resolvePdsUrl(parsed.did);
  if (!pdsUrl) return { subjectDid: parsed.did, name: '' };

  try {
    const params = new URLSearchParams({
      repo: parsed.did,
      collection: parsed.collection,
      rkey: parsed.rkey,
    });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (!res.ok) return { subjectDid: parsed.did, name: '' };
    const data = (await res.json()) as { value?: { name?: string; url?: string } };
    return {
      subjectDid: parsed.did,
      name: data.value?.name?.trim() || '',
      siteUrl: data.value?.url,
    };
  } catch {
    return { subjectDid: parsed.did, name: '' };
  }
}

// A human-readable title for an imported publication. Prefer the publication's
// own name; otherwise fall back to "<owner>'s links" from the author's profile
// (mirroring an in-app linkblog follow), then a plain label.
async function titleFor(meta: PublicationMeta): Promise<string> {
  if (meta.name) return meta.name;
  try {
    const profile = (await fetchProfiles([meta.subjectDid])).get(meta.subjectDid);
    const owner = profile?.displayName?.trim() || (profile?.handle ? `@${profile.handle}` : '');
    if (owner) return `${owner}'s links`;
  } catch {
    // best-effort
  }
  return 'Linkblog';
}

export async function reconcileAtmosphereSubscriptions(
  session: Session,
  env: Env,
  ctx: ExecutionContext,
  // The invocation's subrequest ledger. On `/api/sync` this is the same one the
  // subscription sync just charged its pull to, so the walks scheduled here are
  // admitted against everything the request has spent — both halves of it.
  ledger?: QueryLedger
): Promise<AtmosphereSyncResult> {
  const result: AtmosphereSyncResult = {
    success: true,
    imported: 0,
    removed: 0,
    pushed: 0,
    skipped: 0,
    warnings: [],
    limitNotices: [],
  };

  const pdsClient = createPDSClient(session);
  let ops = 0;
  // Every op this reconcile performs comes out of the same invocation as the
  // subscription pull and the back-catalogue walks. Charging them is what lets
  // `/api/sync` reserve for what it does *not* charge rather than for this.
  const charge = (subrequests: number) => {
    if (ledger) chargeQueries(ledger, subrequests);
  };
  const chargeOp = () => charge(SUBREQUESTS_PER_ATMOSPHERE_OP);
  // Imports fan out into this one invocation, so the back-catalogue walks they
  // trigger are bounded the way the poller's are (see `MAX_SYNC_BACKFILLS`).
  const scheduleBackfill = createBackfillScheduler(env, (p) => ctx.waitUntil(p), { ledger });
  let deferredBackfills = 0;

  try {
    // Step 1: the user's graph edges → set of followed publication URIs.
    const graphResult = await pdsClient.listAllRecords<{ publication?: string }>(
      SUBSCRIPTION_COLLECTION,
      { maxPages: MAX_LIST_PAGES }
    );
    if (!graphResult.success) {
      return { ...result, success: false, error: `Failed to list graph: ${graphResult.error}` };
    }
    charge(graphListSubrequests(graphResult.data.length, graphResult.truncated === true));
    const graphPubs = new Set<string>();
    for (const rec of graphResult.data) {
      if (isPublicationUri(rec.value.publication)) graphPubs.add(rec.value.publication);
    }
    // When the graph listing hit a page cap, `graphPubs` is incomplete — an edge
    // sitting on an unread page would look "deleted elsewhere". We can still
    // safely import and push edges, but must not delete local subs this run.
    const graphTruncated = graphResult.truncated === true;
    if (graphTruncated) {
      result.warnings.push(
        'Atmosphere subscription list was too large to read fully; skipping unfollow propagation this sync.'
      );
    }

    // Step 2: local atproto.documents subs, keyed by publication URI (feedUrl).
    const localResult = await env.DB.prepare(
      `SELECT record_uri, feed_url, atmosphere_synced, atmosphere_previous_feed_url
         FROM subscriptions_cache
        WHERE user_did = ? AND source_type = 'atproto.documents'`
    )
      .bind(session.did)
      .all<LocalDocSub>();
    const localSubs = localResult.results || [];
    const localByPub = new Map<string, LocalDocSub>();
    const supersededGraphPubs = new Set<string>();
    for (const sub of localSubs) {
      if (isPublicationUri(sub.feed_url)) localByPub.set(sub.feed_url, sub);
      if (isPublicationUri(sub.atmosphere_previous_feed_url)) {
        supersededGraphPubs.add(sub.atmosphere_previous_feed_url);
      }
    }

    // Tier-aware headroom for imports — counts ACTIVE subs only, since the limit
    // governs servicing (parked rows are unlimited mirrors). `liveCount` tracks
    // active subscriptions as we import.
    const limits = await getUserTierLimits(env, session.did);
    const activeSubsRow = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ? AND active = 1'
    )
      .bind(session.did)
      .first<{ count: number }>();
    let liveCount = activeSubsRow?.count || 0;

    // Total mirrored rows (active + parked) for the mirror cap — parking is only
    // unlimited up to this ceiling; past it we stop importing graph edges entirely
    // (they stay on the PDS and re-import once the user frees room).
    const totalSubsRow = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ?'
    )
      .bind(session.did)
      .first<{ count: number }>();
    let totalCount = totalSubsRow?.count || 0;
    const maxMirrored = limits.maxMirroredSubscriptions;

    // Step 3: import graph edges that aren't local yet.
    let parkedOnImport = 0;
    let droppedOverCap = 0;
    for (const pubUri of graphPubs) {
      if (localByPub.has(pubUri)) continue;
      // A publication switch deliberately superseded this edge. Its destination
      // row below owns deleting it; importing it here would resurrect the old
      // follower scope and prevent the migration from converging.
      if (supersededGraphPubs.has(pubUri)) continue;
      if (ops >= MAX_OPS) {
        result.hasMore = true;
        break;
      }

      // Hard mirror cap — stop materializing rows past the plan's ceiling. More
      // edges may remain, so flag hasMore for a future reconcile if room frees up.
      if (totalCount >= maxMirrored) {
        droppedOverCap++;
        result.hasMore = true;
        continue;
      }

      // Charged before the work, not after: an import that bails part way (an
      // unparseable URI, a concurrent reconcile that inserted the row first) has
      // still spent the fetches it made by then.
      chargeOp();
      const meta = await resolvePublicationMeta(pubUri);
      if (!meta) continue; // unparseable URI — skip
      const title = await titleFor(meta);

      // Over the plan's active capacity → import the follow PARKED (saved +
      // mirrored, not serviced) rather than skipping it. Skipping left the graph
      // edge with no local row, so every reconcile re-examined it; parking once
      // records it and surfaces it in Manage feeds for reactivation.
      const active = liveCount < limits.maxSubscriptions ? 1 : 0;

      const rkey = generateTid();
      const recordUri = `at://${session.did}/${SUBSCRIPTION_NSID}/${rkey}`;
      const insert = await env.DB.prepare(
        `INSERT OR IGNORE INTO subscriptions_cache
           (user_did, record_uri, feed_url, title, category, created_at, source_type, subject_did, custom_title, custom_icon_url, atmosphere_synced, active)
         VALUES (?, ?, ?, ?, NULL, unixepoch(), 'atproto.documents', ?, NULL, NULL, unixepoch(), ?)`
      )
        .bind(session.did, recordUri, pubUri, title, meta.subjectDid, active)
        .run();

      // A concurrent reconcile (other tab/device) may have inserted this same
      // publication first; the unique (user, source_type, feed_url) index makes
      // our insert a no-op. Skip the follow-up work so we don't double-count or
      // write a second, orphaned PDS record under our throwaway rkey.
      if (insert.meta && insert.meta.changes === 0) continue;

      // An imported follow needs the author's back catalogue pulled in like any
      // other new subscription — otherwise the reader shows an error for this
      // linkblog until the reconcile happens to reach that author. Past the bound,
      // the reconcile is exactly where it goes: an author with no
      // `document_authors` row sorts to the front of that queue.
      if (!scheduleBackfill(meta.subjectDid)) deferredBackfills++;

      // Mirror to the user's app.skyreader subscription list on the PDS, so an
      // imported follow looks identical to an in-app one. Best-effort.
      ctx.waitUntil(
        pushSubscriptionToPds(
          session,
          rkey,
          pubUri,
          title,
          meta.siteUrl,
          'atproto.documents',
          meta.subjectDid
        ).then(() => {})
      );

      totalCount++;
      if (active) {
        liveCount++;
      } else {
        parkedOnImport++;
      }
      result.imported++;
      ops++;
    }

    if (parkedOnImport > 0) {
      result.limitNotices.push({
        kind: 'feeds',
        subject: 'linkblogs',
        count: parkedOnImport,
        limit: limits.maxSubscriptions,
        message:
          `${parkedOnImport} followed linkblog${parkedOnImport === 1 ? '' : 's'} over your plan's ` +
          `active limit of ${limits.maxSubscriptions} ${parkedOnImport === 1 ? 'was' : 'were'} parked. ` +
          `Reactivate from Manage feeds.`,
      });
    }

    if (droppedOverCap > 0) {
      result.limitNotices.push({
        kind: 'mirror',
        subject: 'linkblogs',
        count: droppedOverCap,
        limit: maxMirrored,
        message:
          `${droppedOverCap} followed linkblog${droppedOverCap === 1 ? '' : 's'} over your plan's ` +
          `mirror limit of ${maxMirrored} ${droppedOverCap === 1 ? 'was' : 'were'} not imported. ` +
          `${droppedOverCap === 1 ? 'It stays' : 'They stay'} in your Atmosphere graph.`,
      });
    }

    // Imports warm themselves: the loop above schedules up to MAX_SYNC_BACKFILLS
    // back-catalogue walks (documents are read from D1 now, so an unlisted author
    // has nothing to serve). Anything past that bound waits for the reconcile.
    if (deferredBackfills > 0) {
      log.info('atmosphere_import_backfills_deferred', {
        deferred: deferredBackfills,
        scheduled: MAX_SYNC_BACKFILLS,
      });
    }

    // Step 4: reconcile each local pub-sub against the graph.
    for (const [pubUri, sub] of localByPub) {
      if (sub.atmosphere_previous_feed_url) {
        const previousPubUri = sub.atmosphere_previous_feed_url;
        if (graphPubs.has(previousPubUri)) {
          if (ops >= MAX_OPS) {
            result.hasMore = true;
            break;
          }
          chargeOp();
          const removeOld = await deleteAtmosphereSubscription(session, previousPubUri);
          if (!removeOld.success) {
            result.warnings.push(
              `Failed to replace old publication follow ${previousPubUri}: ${removeOld.error}`
            );
            continue;
          }
          graphPubs.delete(previousPubUri);
          ops++;
        }

        if (!graphPubs.has(pubUri)) {
          if (ops >= MAX_OPS) {
            result.hasMore = true;
            break;
          }
          chargeOp();
          const writeNew = await writeAtmosphereSubscription(session, pubUri);
          if (!writeNew.success) {
            result.warnings.push(
              `Failed to push replacement edge for ${pubUri}: ${writeNew.error}`
            );
            continue;
          }
          graphPubs.add(pubUri);
          result.pushed++;
          ops++;
        }

        // Not gated by `MAX_OPS` — it is one statement per local row, so the loop
        // as a whole is bounded only by the mirror cap. Charged for that reason.
        charge(1);
        await env.DB.prepare(
          `UPDATE subscriptions_cache
           SET atmosphere_synced = unixepoch(), atmosphere_previous_feed_url = NULL
           WHERE record_uri = ?`
        )
          .bind(sub.record_uri)
          .run();
        continue;
      }

      if (graphPubs.has(pubUri)) {
        // Present both places — claim it if not yet marked (e.g. an in-app follow).
        if (sub.atmosphere_synced === null) {
          charge(1);
          await env.DB.prepare(
            `UPDATE subscriptions_cache SET atmosphere_synced = unixepoch() WHERE record_uri = ?`
          )
            .bind(sub.record_uri)
            .run();
        }
        continue;
      }

      // Not in the graph.
      if (ops >= MAX_OPS) {
        result.hasMore = true;
        break;
      }

      if (sub.atmosphere_synced !== null) {
        // Was mirrored, now gone → unfollowed elsewhere. But if the graph listing
        // was truncated, "gone" is unreliable (the edge may be on an unread page),
        // so don't risk deleting a still-valid follow — leave it for a full read.
        if (graphTruncated) continue;
        // Delete the PDS record first (so a subscription sync can't re-import it),
        // then the local row.
        chargeOp();
        const rkey = extractRkey(sub.record_uri);
        const del = await deleteSubscriptionFromPds(session, rkey);
        if (!del.success) {
          result.warnings.push(`Failed to remove ${pubUri} from PDS: ${del.error}`);
          continue; // leave the row; retry next run
        }
        await env.DB.prepare('DELETE FROM subscriptions_cache WHERE record_uri = ?')
          .bind(sub.record_uri)
          .run();
        result.removed++;
        ops++;
      } else {
        // Local-only (edge write hasn't landed) → write it back, then mark synced.
        chargeOp();
        const write = await writeAtmosphereSubscription(session, pubUri);
        if (!write.success) {
          result.warnings.push(`Failed to push edge for ${pubUri}: ${write.error}`);
          continue;
        }
        await env.DB.prepare(
          `UPDATE subscriptions_cache SET atmosphere_synced = unixepoch() WHERE record_uri = ?`
        )
          .bind(sub.record_uri)
          .run();
        result.pushed++;
        ops++;
      }
    }

    return result;
  } catch (error) {
    console.error('[AtmosphereSubSync] reconcile error:', error);
    return {
      ...result,
      success: false,
      error: error instanceof Error ? error.message : 'Reconcile failed',
    };
  }
}
