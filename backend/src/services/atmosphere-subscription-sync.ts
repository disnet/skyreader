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
  isPublicationUri,
  writeAtmosphereSubscription,
} from './atmosphere-subscription';
import { pushSubscriptionToPds, deleteSubscriptionFromPds } from './subscription-sync';
import { backfillDocumentsForUser } from '../routes/social';

const SUBSCRIPTION_NSID = 'app.skyreader.feed.subscription';

// Limit PDS listing pages (1 subrequest per 100 records), matching subscription-sync.
const MAX_LIST_PAGES = 20;

// Cap the number of PDS-mutating operations (imports + edge writes + deletes)
// per run to stay well under the Worker subrequest budget. When more remain,
// `hasMore` is set so the caller loops — exactly like syncSubscriptions batching.
const MAX_OPS = 20;

// Cap how many author feeds we eagerly warm per run. Each backfill fetches up to
// ~10 pages plus per-document URL resolution, all charged to this request's
// subrequest budget; firing one per import (up to MAX_OPS) could blow it. The
// rest load lazily on first open — the warning surfaces what was deferred.
const MAX_BACKFILLS = 8;

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
  /** More work remains — call reconcile again. */
  hasMore?: boolean;
}

interface LocalDocSub {
  record_uri: string;
  feed_url: string;
  atmosphere_synced: number | null;
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
  ctx: ExecutionContext
): Promise<AtmosphereSyncResult> {
  const result: AtmosphereSyncResult = {
    success: true,
    imported: 0,
    removed: 0,
    pushed: 0,
    skipped: 0,
    warnings: [],
  };

  const pdsClient = createPDSClient(session);
  let ops = 0;

  try {
    // Step 1: the user's graph edges → set of followed publication URIs.
    const graphResult = await pdsClient.listAllRecords<{ publication?: string }>(
      SUBSCRIPTION_COLLECTION,
      { maxPages: MAX_LIST_PAGES }
    );
    if (!graphResult.success) {
      return { ...result, success: false, error: `Failed to list graph: ${graphResult.error}` };
    }
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
      `SELECT record_uri, feed_url, atmosphere_synced
         FROM subscriptions_cache
        WHERE user_did = ? AND source_type = 'atproto.documents'`
    )
      .bind(session.did)
      .all<LocalDocSub>();
    const localSubs = localResult.results || [];
    const localByPub = new Map<string, LocalDocSub>();
    for (const sub of localSubs) {
      if (isPublicationUri(sub.feed_url)) localByPub.set(sub.feed_url, sub);
    }

    // Tier-aware headroom for imports.
    const limits = await getUserTierLimits(env, session.did);
    const totalSubsRow = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ?'
    )
      .bind(session.did)
      .first<{ count: number }>();
    let liveCount = totalSubsRow?.count || 0;

    // Step 3: import graph edges that aren't local yet. Authors to warm are
    // collected (deduped) and backfilled after the loop, bounded by MAX_BACKFILLS.
    const authorsToBackfill = new Set<string>();
    for (const pubUri of graphPubs) {
      if (localByPub.has(pubUri)) continue;
      if (ops >= MAX_OPS) {
        result.hasMore = true;
        break;
      }
      if (liveCount >= limits.maxSubscriptions) {
        result.skipped++;
        continue;
      }

      const meta = await resolvePublicationMeta(pubUri);
      if (!meta) continue; // unparseable URI — skip
      const title = await titleFor(meta);

      const rkey = generateTid();
      const recordUri = `at://${session.did}/${SUBSCRIPTION_NSID}/${rkey}`;
      const insert = await env.DB.prepare(
        `INSERT OR IGNORE INTO subscriptions_cache
           (user_did, record_uri, feed_url, title, category, created_at, source_type, subject_did, custom_title, custom_icon_url, atmosphere_synced)
         VALUES (?, ?, ?, ?, NULL, unixepoch(), 'atproto.documents', ?, NULL, NULL, unixepoch())`
      )
        .bind(session.did, recordUri, pubUri, title, meta.subjectDid)
        .run();

      // A concurrent reconcile (other tab/device) may have inserted this same
      // publication first; the unique (user, source_type, feed_url) index makes
      // our insert a no-op. Skip the follow-up work so we don't double-count or
      // write a second, orphaned PDS record under our throwaway rkey.
      if (insert.meta && insert.meta.changes === 0) continue;

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
      authorsToBackfill.add(meta.subjectDid);

      liveCount++;
      result.imported++;
      ops++;
    }

    // Warm the imported feeds so they aren't empty on first open — deduped by
    // author (one backfill covers all of an author's publications) and capped so
    // a large first import can't exhaust the request's subrequest budget.
    let backfilled = 0;
    for (const did of authorsToBackfill) {
      if (backfilled >= MAX_BACKFILLS) break;
      ctx.waitUntil(backfillDocumentsForUser(env, did));
      backfilled++;
    }
    if (authorsToBackfill.size > backfilled) {
      result.warnings.push(
        `Deferred feed warm-up for ${authorsToBackfill.size - backfilled} author(s); their posts load on first open.`
      );
    }

    // Step 4: reconcile each local pub-sub against the graph.
    for (const [pubUri, sub] of localByPub) {
      if (graphPubs.has(pubUri)) {
        // Present both places — claim it if not yet marked (e.g. an in-app follow).
        if (sub.atmosphere_synced === null) {
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
