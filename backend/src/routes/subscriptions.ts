import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { warmFeedIntoArchive, warmFeedsIntoArchive } from './feeds-v2';
import { getUserSettings } from './settings';
import { pushSubscriptionToPds, deleteSubscriptionFromPds } from '../services/subscription-sync';
import {
  linkblogPublicationUri,
  writeAtmosphereSubscription,
  deleteAtmosphereSubscription,
} from '../services/atmosphere-subscription';
import { createPDSClient, type WriteOp } from '../services/pds-client';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import { generateTid } from '../utils/tid';
import { fetchProfiles } from '../services/bsky-appview';
import { getUserTierLimits } from '../services/user-tier';
import {
  getLinkblogTarget,
  getPageHiddenAuthors,
  linkblogBaseUrl,
  publicationUri as defaultLinkblogPublicationUri,
} from '../services/linkblog-sync';

/**
 * Helper to sync subscription to PDS in background (fire and forget)
 * Accepts pdsSyncEnabled to avoid redundant DB lookups
 */
async function maybePushToPds(
  session: Session,
  pdsSyncEnabled: boolean,
  rkey: string,
  feedUrl: string,
  title?: string,
  siteUrl?: string,
  sourceType?: string,
  subjectDid?: string,
  collectionNsid?: string,
  customTitle?: string,
  customIconUrl?: string,
  category?: string
): Promise<void> {
  console.log('[PDS Sync] maybePushToPds called:', {
    pdsSyncEnabled,
    rkey,
    feedUrl,
    sourceType,
    subjectDid,
    hasPdsUrl: !!session.pdsUrl,
    pdsUrl: session.pdsUrl,
    hasAccessToken: !!session.accessToken,
    hasDpopKey: !!session.dpopPrivateKey,
  });

  if (!pdsSyncEnabled) {
    console.log('[PDS Sync] Sync disabled, skipping');
    return;
  }

  try {
    console.log('[PDS Sync] Pushing subscription to PDS...');
    const result = await pushSubscriptionToPds(
      session,
      rkey,
      feedUrl,
      title,
      siteUrl,
      sourceType,
      subjectDid,
      collectionNsid,
      customTitle,
      customIconUrl,
      category
    );
    if (result.success) {
      console.log('[PDS Sync] Successfully pushed subscription to PDS');
    } else {
      console.error(`[PDS Sync] Failed to push subscription: ${result.error}`);
    }
  } catch (error) {
    console.error('[PDS Sync] Error pushing subscription:', error);
  }
}

/**
 * Write/delete the portable "subscribe via the Atmosphere" record
 * (site.standard.graph.subscription) when a subscription is a linkblog follow.
 * Gated behind Atmospheric sync, mirroring how the feed list is treated as the
 * opt-in, publicly-visible part. Best-effort + background: a failure here never
 * blocks the follow itself (the skyreader subscription is the source of truth).
 */
async function maybeSyncAtmosphereSubscription(
  session: Session,
  pdsSyncEnabled: boolean,
  op: 'create' | 'delete',
  sourceType: string | undefined | null,
  feedUrl: string | undefined | null
): Promise<void> {
  if (!pdsSyncEnabled) return;
  const publicationUri = linkblogPublicationUri(sourceType, feedUrl);
  if (!publicationUri) return;

  try {
    const result =
      op === 'create'
        ? await writeAtmosphereSubscription(session, publicationUri)
        : await deleteAtmosphereSubscription(session, publicationUri);
    if (!result.success) {
      console.error(`[Atmosphere] Failed to ${op} subscription record: ${result.error}`);
    }
  } catch (error) {
    console.error(`[Atmosphere] Error during ${op} of subscription record:`, error);
  }
}

/**
 * Helper to delete subscription from PDS.
 *
 * Deletes must be awaited by the HTTP handler. If we only schedule them with waitUntil,
 * a sync that starts immediately after the response can pull the still-existing PDS
 * record back into the local cache, making the unsubscribe appear to do nothing.
 */
async function deleteFromPdsIfEnabled(
  session: Session,
  pdsSyncEnabled: boolean,
  rkey: string
): Promise<void> {
  if (!pdsSyncEnabled) return;

  const result = await deleteSubscriptionFromPds(session, rkey);
  if (!result.success) {
    throw new Error(`Failed to delete subscription from PDS: ${result.error}`);
  }
}

/**
 * Remove the portable Atmosphere subscription (the site.standard.graph.subscription
 * edge) for a deleted linkblog follow. Awaited and fail-loud, unlike the
 * fire-and-forget create path.
 *
 * When Atmospheric subscription sync is on, reconcile reads a still-present graph
 * edge as a live follow and re-imports the publication — so a silently-failed edge
 * removal would resurrect the very sub the user just deleted. Throwing here aborts
 * the local delete before it happens; the subscription then self-heals back to a
 * consistent "still followed" state (the next sync re-pushes the app.skyreader
 * record) and the user can retry. No-op for non-publication subs or when PDS sync
 * is off.
 */
async function deleteAtmosphereSubscriptionIfEnabled(
  session: Session,
  pdsSyncEnabled: boolean,
  sourceType: string | undefined | null,
  feedUrl: string | undefined | null
): Promise<void> {
  if (!pdsSyncEnabled) return;
  const publicationUri = linkblogPublicationUri(sourceType, feedUrl);
  if (!publicationUri) return;

  const result = await deleteAtmosphereSubscription(session, publicationUri);
  if (!result.success) {
    throw new Error(`Failed to delete Atmosphere subscription record: ${result.error}`);
  }
}

/**
 * Helper to bulk push subscriptions to PDS in background (fire and forget)
 * Lists existing PDS records first to build proper create/update/skip operations
 */
async function maybeBulkPushToPds(
  session: Session,
  pdsSyncEnabled: boolean,
  subscriptions: Array<{
    rkey: string;
    feedUrl: string;
    title?: string;
    customTitle?: string;
    customIconUrl?: string;
  }>
): Promise<void> {
  if (!pdsSyncEnabled || subscriptions.length === 0) {
    console.log('[PDS Sync] Bulk sync disabled or no subscriptions, skipping');
    return;
  }

  console.log(`[PDS Sync] Batch pushing ${subscriptions.length} subscriptions to PDS...`);

  const pdsClient = createPDSClient(session);
  const collection = 'app.skyreader.feed.subscription';

  // List existing PDS records to determine create vs update vs skip
  const listResult = await pdsClient.listAllRecords<{
    feedUrl: string;
    title?: string;
    customTitle?: string;
    customIconUrl?: string;
  }>(collection, { maxPages: 20 });

  if (!listResult.success) {
    console.error(`[PDS Sync] Failed to list PDS records: ${listResult.error}`);
    return;
  }

  // Build lookup maps by rkey and feedUrl
  const pdsByRkey = new Map<
    string,
    {
      feedUrl: string;
      title?: string;
      customTitle?: string;
      customIconUrl?: string;
    }
  >();
  const pdsByFeedUrl = new Set<string>();
  for (const record of listResult.data) {
    const rkey = record.uri.split('/').pop();
    if (rkey) {
      pdsByRkey.set(rkey, record.value);
    }
    if (record.value.feedUrl) {
      pdsByFeedUrl.add(record.value.feedUrl);
    }
  }

  // Build write operations
  const writes: WriteOp[] = [];
  let skippedExisting = 0;
  let skippedNoOp = 0;

  for (const sub of subscriptions) {
    // Skip if this feedUrl already exists in PDS (avoid duplicates)
    if (pdsByFeedUrl.has(sub.feedUrl)) {
      skippedExisting++;
      continue;
    }

    const newRecord = {
      $type: collection,
      feedUrl: sub.feedUrl,
      title: sub.title,
      createdAt: new Date().toISOString(),
      customTitle: sub.customTitle,
      customIconUrl: sub.customIconUrl,
    };

    const existingRecord = pdsByRkey.get(sub.rkey);
    if (existingRecord) {
      // Rkey exists - check if no-op
      if (
        existingRecord.feedUrl === sub.feedUrl &&
        (existingRecord.title || undefined) === sub.title &&
        (existingRecord.customTitle || undefined) === sub.customTitle &&
        (existingRecord.customIconUrl || undefined) === sub.customIconUrl
      ) {
        skippedNoOp++;
        continue;
      }
      // Content differs - use update
      writes.push({
        $type: 'com.atproto.repo.applyWrites#update',
        collection,
        rkey: sub.rkey,
        value: newRecord,
      });
    } else {
      // Rkey doesn't exist - use create
      writes.push({
        $type: 'com.atproto.repo.applyWrites#create',
        collection,
        rkey: sub.rkey,
        value: newRecord,
      });
    }
  }

  if (skippedExisting > 0) {
    console.log(`[PDS Sync] Skipped ${skippedExisting} already in PDS (by feedUrl)`);
  }
  if (skippedNoOp > 0) {
    console.log(`[PDS Sync] Skipped ${skippedNoOp} no-op writes`);
  }

  if (writes.length === 0) {
    console.log('[PDS Sync] No writes needed');
    return;
  }

  const creates = writes.filter((w) => w.$type.endsWith('#create')).length;
  const updates = writes.filter((w) => w.$type.endsWith('#update')).length;
  console.log(
    `[PDS Sync] Applying ${writes.length} writes (${creates} creates, ${updates} updates)...`
  );

  const result = await pdsClient.applyWrites(writes);
  if (result.success) {
    console.log(`[PDS Sync] Batch push complete: ${result.data.results.length} succeeded`);
  } else {
    console.error(`[PDS Sync] Batch push failed: ${result.error}`);

    // Fall back to individual puts (limited to avoid subrequest limit)
    const MAX_FALLBACK = 10;
    const fallbackBatch = writes.slice(0, MAX_FALLBACK);
    console.log(
      `[PDS Sync] Falling back to individual puts (${fallbackBatch.length} of ${writes.length})...`
    );
    let succeeded = 0;

    for (const write of fallbackBatch) {
      if (write.$type === 'com.atproto.repo.applyWrites#delete') continue;
      const value = write.value as {
        feedUrl: string;
        title?: string;
        customTitle?: string;
        customIconUrl?: string;
      };

      const putResult = await pdsClient.putRecord(collection, write.rkey, write.value);
      if (putResult.success) {
        succeeded++;
      } else {
        console.error(
          `[PDS Sync] Failed to put ${write.rkey} (${value.feedUrl}): ${putResult.error}`
        );
      }
    }

    const skipped = writes.length - MAX_FALLBACK;
    if (skipped > 0) {
      console.log(
        `[PDS Sync] Fallback complete: ${succeeded}/${fallbackBatch.length} succeeded, ${skipped} skipped (will sync later)`
      );
    } else {
      console.log(`[PDS Sync] Fallback complete: ${succeeded}/${writes.length} succeeded`);
    }
  }
}

/**
 * Helper to bulk delete subscriptions from PDS in background (fire and forget)
 * Uses small batches to stay within PDS and Cloudflare subrequest limits
 */
async function maybeBulkDeleteFromPds(
  session: Session,
  pdsSyncEnabled: boolean,
  rkeys: string[]
): Promise<void> {
  if (!pdsSyncEnabled || rkeys.length === 0) {
    console.log('[PDS Sync] Bulk delete sync disabled or no rkeys, skipping');
    return;
  }

  console.log(`[PDS Sync] Deleting ${rkeys.length} subscriptions from PDS...`);

  const pdsClient = createPDSClient(session);
  const collection = 'app.skyreader.feed.subscription';
  // Use small batch size to stay within limits (Cloudflare has 50 subrequest limit)
  const BATCH_SIZE = 20;
  let totalDeleted = 0;
  let totalFailed = 0;

  // Process in batches
  for (let i = 0; i < rkeys.length; i += BATCH_SIZE) {
    const batch = rkeys.slice(i, i + BATCH_SIZE);
    console.log(
      `[PDS Sync] Batch deleting ${batch.length} records (${i + 1}-${i + batch.length} of ${rkeys.length})...`
    );

    const writes: WriteOp[] = batch.map((rkey) => ({
      $type: 'com.atproto.repo.applyWrites#delete' as const,
      collection,
      rkey,
    }));

    const result = await pdsClient.applyWrites(writes);
    if (result.success) {
      totalDeleted += batch.length;
      console.log(`[PDS Sync] Batch delete complete: ${batch.length} deleted`);
    } else {
      totalFailed += batch.length;
      // Don't fall back to individual deletes - would hit subrequest limit
      // These will be cleaned up on next full sync
      console.error(`[PDS Sync] Batch delete failed: ${result.error} (${batch.length} records)`);
    }
  }

  console.log(
    `[PDS Sync] Delete complete: ${totalDeleted} deleted, ${totalFailed} failed (will retry on next sync)`
  );
}

interface CreateSubscriptionRequest {
  feedUrl?: string;
  title?: string;
  siteUrl?: string;
  category?: string;
  tags?: string[];
  source?: string;
  externalRef?: string;
  sourceType?: string;
  subjectDid?: string;
  collectionNsid?: string;
  customTitle?: string;
  customIconUrl?: string;
}

interface BulkCreateSubscriptionsRequest {
  subscriptions: Array<{
    rkey: string;
    feedUrl: string;
    title?: string;
    siteUrl?: string;
    category?: string;
    source?: string;
    externalRef?: string;
  }>;
}

interface BulkDeleteSubscriptionsRequest {
  rkeys: string[];
}

// Counts only ACTIVE subscriptions — the ones Skyreader services (polls + shows).
// The tier limit governs servicing cost, so parked rows (PDS records mirrored
// locally but over the plan's active capacity) don't count against it.
async function countActiveSubscriptions(env: Env, did: string): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ? AND active = 1'
  )
    .bind(did)
    .first<{ count: number }>();

  return result?.count || 0;
}

// Counts ALL local rows (active + parked). Gates the mirror cap, which bounds how
// many rows we'll materialize per user regardless of how big their PDS set is.
async function countAllSubscriptions(env: Env, did: string): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ?'
  )
    .bind(did)
    .first<{ count: number }>();

  return result?.count || 0;
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// ── Atmosphere subscribe → local reader subscription ─────────────────────────
//
// "Subscribe via the Atmosphere" (atmosphere.ts) writes the portable
// site.standard.graph.subscription to the visitor's PDS. For a signed-in
// Skyreader user we ALSO create the matching local `atproto.documents`
// subscription so the linkblog actually lands in their reader (and the
// "Open in Skyreader" deep link, which resolves a publication URI to a local
// subscription, has something to resolve to). The local row is created
// unconditionally — decoupled from Atmospheric sync — while the optional mirror
// of the app.skyreader.feed.subscription record to the PDS stays gated on
// pds_sync, exactly like an in-app follow.

// The did:… author of an at:// publication URI (at://<did>/<collection>/<rkey>).
function didFromAtUri(uri: string): string | null {
  const match = uri.match(/^at:\/\/([^/]+)\//);
  return match && match[1].startsWith('did:') ? match[1] : null;
}

// The user's existing atproto.documents subscription for a publication, if any.
// Dedup is by (user, subjectDid, publicationUri) — matching subscription-sync's
// key — so two publications owned by one author DID stay distinct, while we never
// double-add a linkblog already followed in-app or via a prior button click.
async function findDocumentSubscription(
  env: Env,
  userDid: string,
  subjectDid: string,
  publicationUri: string
): Promise<{ record_uri: string } | null> {
  return env.DB.prepare(
    `SELECT record_uri FROM subscriptions_cache
     WHERE user_did = ? AND source_type = 'atproto.documents' AND subject_did = ? AND feed_url = ?`
  )
    .bind(userDid, subjectDid, publicationUri)
    .first<{ record_uri: string }>();
}

// Create the local reader subscription for a linkblog publication if the user
// doesn't already follow that author. Idempotent and non-fatal: any failure here
// must not undo the portable subscribe the caller already wrote.
export async function ensureLocalDocumentSubscription(
  env: Env,
  session: Session,
  ctx: ExecutionContext,
  publicationUri: string
): Promise<void> {
  const subjectDid = didFromAtUri(publicationUri);
  if (!subjectDid) return;

  // Already following this publication (button or in-app) — nothing to do.
  const existing = await findDocumentSubscription(env, session.did, subjectDid, publicationUri);
  if (existing) return;

  // Over the plan's active capacity → mirror the follow as PARKED (saved + on the
  // PDS, just not serviced or shown) rather than skipping it. Skipping created no
  // local row at all, so the follow stayed invisible until a later full sync
  // parked it; doing it here surfaces it in Manage feeds → Parked immediately.
  let active = 1;
  try {
    const limits = await getUserTierLimits(env, session.did);
    // Past the mirror ceiling we don't materialize a row at all — the portable
    // subscribe the caller wrote still lives on the PDS and will sync in once the
    // user frees room. Parking is only "unlimited" up to this cap.
    const total = await countAllSubscriptions(env, session.did);
    if (total >= limits.maxMirroredSubscriptions) {
      console.log('[Atmosphere] At mirror cap; skipping local reader subscription');
      return;
    }
    const count = await countActiveSubscriptions(env, session.did);
    if (count >= limits.maxSubscriptions) active = 0;
  } catch (err) {
    console.error('[Atmosphere] Failed to check subscription limit:', err);
  }

  // Derive a human-readable title up front; with a null title the reader UI falls
  // back to showing the raw publication AT-URI. Mirrors the in-app linkblog
  // follow's "<name>'s links" (linkblogDiscovery.subscribe), resolved from the
  // author's public profile. Best-effort: a failed lookup yields a plain label.
  const profile = (await fetchProfiles([subjectDid])).get(subjectDid);
  const owner = profile?.displayName?.trim() || (profile?.handle ? `@${profile.handle}` : '');
  const title = owner ? `${owner}'s links` : 'Linkblog';

  // The author's public linkblog page, stored as the subscription's siteUrl so
  // the reader can tell a linkblog from an ordinary publication: a connected
  // linkblog's rkey is arbitrary, so the URI alone can't say. (The page renders
  // whichever publication the author currently publishes to, so this survives a
  // later switch.) Only when this publication really is their linkblog — this
  // endpoint takes any standard.site publication — and only while that page is
  // actually served: an author who turned it off would leave us persisting a URL
  // that 404s, and the subscription outlives the moment we stored it.
  const [target, pageHidden] = await Promise.all([
    getLinkblogTarget(env, subjectDid),
    getPageHiddenAuthors(env, [subjectDid]).then((h) => h.length > 0),
  ]);
  const isLinkblog =
    publicationUri === target.siteUri ||
    publicationUri === defaultLinkblogPublicationUri(subjectDid);
  const siteUrl = isLinkblog && !pageHidden ? linkblogBaseUrl(env, subjectDid) : null;

  const rkey = generateTid();
  const recordUri = `at://${session.did}/app.skyreader.feed.subscription/${rkey}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO subscriptions_cache
     (user_did, record_uri, feed_url, title, site_url, category, created_at, source_type, subject_did, custom_title, custom_icon_url, active)
     VALUES (?, ?, ?, ?, ?, NULL, unixepoch(), 'atproto.documents', ?, NULL, NULL, ?)`
  )
    .bind(session.did, recordUri, publicationUri, title, siteUrl, subjectDid, active)
    .run();

  // Mirror to the user's PDS subscription list when Atmospheric sync is on, so the
  // reader follow behaves exactly like an in-app one (best-effort, background).
  const settings = await getUserSettings(env, session.did);
  ctx.waitUntil(
    maybePushToPds(
      session,
      settings.pdsSyncEnabled,
      rkey,
      publicationUri,
      title,
      siteUrl ?? undefined,
      'atproto.documents',
      subjectDid
    )
  );
}

// Remove the local reader subscription that mirrors a linkblog follow, keeping the
// public button's subscribe/unsubscribe symmetric. Non-fatal.
export async function removeLocalDocumentSubscription(
  env: Env,
  session: Session,
  publicationUri: string
): Promise<void> {
  const subjectDid = didFromAtUri(publicationUri);
  if (!subjectDid) return;

  const existing = await findDocumentSubscription(env, session.did, subjectDid, publicationUri);
  if (!existing) return;

  const rkey = existing.record_uri.split('/').pop();
  if (!rkey) return;

  // Delete the PDS record first (when sync is on) so a sync can't re-import it,
  // then drop the local row.
  const settings = await getUserSettings(env, session.did);
  try {
    await deleteFromPdsIfEnabled(session, settings.pdsSyncEnabled, rkey);
  } catch (err) {
    console.error('[Atmosphere] Failed to delete reader subscription from PDS:', err);
  }
  await env.DB.prepare('DELETE FROM subscriptions_cache WHERE user_did = ? AND record_uri = ?')
    .bind(session.did, existing.record_uri)
    .run();
}

// POST /api/subscriptions - Create a single subscription
// GET /api/subscriptions — list the user's subscriptions (identifiers only).
// A lightweight read for clients (the browser extension) that need to tell
// whether a discovered feed / standard.site publication is already subscribed,
// with no local cache to consult. Includes parked rows (active=0) so a
// re-subscribe that would silently un-park is surfaced as "already subscribed".
export async function handleListSubscriptions(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(
      'SELECT feed_url, subject_did, source_type, active FROM subscriptions_cache WHERE user_did = ?'
    )
      .bind(session.did)
      .all<{
        feed_url: string;
        subject_did: string | null;
        source_type: string | null;
        active: number;
      }>();

    const subscriptions = result.results.map((row) => ({
      feedUrl: row.feed_url || null,
      subjectDid: row.subject_did || null,
      sourceType: row.source_type || null,
      active: row.active !== 0,
    }));

    return new Response(JSON.stringify({ subscriptions }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to list subscriptions:', error);
    return new Response(JSON.stringify({ error: 'Failed to list subscriptions' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function handleCreateSubscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: CreateSubscriptionRequest & { rkey: string };
  try {
    body = (await request.json()) as CreateSubscriptionRequest & {
      rkey: string;
    };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const {
    rkey,
    feedUrl,
    title,
    siteUrl,
    category,
    tags,
    source,
    externalRef,
    sourceType,
    subjectDid,
    collectionNsid,
    customTitle,
    customIconUrl,
  } = body;

  // Validate required fields
  if (!rkey || typeof rkey !== 'string') {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate rkey format to prevent pattern injection
  if (!isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }

  const isAtProto = sourceType && sourceType.startsWith('atproto.');

  if (isAtProto) {
    // AT Proto subscriptions require subjectDid, not feedUrl
    if (!subjectDid || typeof subjectDid !== 'string' || !subjectDid.startsWith('did:')) {
      return new Response(
        JSON.stringify({
          error: 'subjectDid is required for AT Proto subscriptions and must be a valid DID',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    const validSourceTypes = ['atproto.documents', 'atproto.collection'];
    if (!validSourceTypes.includes(sourceType)) {
      return new Response(
        JSON.stringify({
          error: `Invalid sourceType: ${sourceType}. Must be one of: ${validSourceTypes.join(', ')}`,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  } else {
    // RSS subscriptions require feedUrl
    if (!feedUrl || typeof feedUrl !== 'string') {
      return new Response(JSON.stringify({ error: 'feedUrl is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!isValidUrl(feedUrl)) {
      return new Response(JSON.stringify({ error: 'feedUrl must be a valid URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Check subscription limit
  try {
    const limits = await getUserTierLimits(env, session.did);
    const currentCount = await countActiveSubscriptions(env, session.did);
    if (currentCount >= limits.maxSubscriptions) {
      return new Response(
        JSON.stringify({
          error: 'subscription_limit_reached',
          message: `You have reached the maximum of ${limits.maxSubscriptions} active feeds. Park a feed to free a slot.`,
          limit: limits.maxSubscriptions,
          current: currentCount,
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  } catch (countError) {
    console.error('Failed to check subscription count:', countError);
  }

  try {
    const collection = 'app.skyreader.feed.subscription';
    const recordUri = `at://${session.did}/${collection}/${rkey}`;

    await env.DB.prepare(
      `
			INSERT OR REPLACE INTO subscriptions_cache
			(user_did, record_uri, feed_url, title, site_url, category, created_at, source_type, subject_did, custom_title, custom_icon_url)
			VALUES (?, ?, ?, ?, ?, ?, unixepoch(), ?, ?, ?, ?)
			`
    )
      .bind(
        session.did,
        recordUri,
        feedUrl || '',
        title || null,
        // Persisted (not just mirrored to the PDS) so it survives to any other
        // device via /api/records/list. For a linkblog follow it's the author's
        // public linkblog page, which is what tells the reader this publication
        // is a linkblog once its rkey is no longer `skyreader-links`.
        siteUrl || null,
        category || null,
        sourceType || null,
        subjectDid || null,
        customTitle || null,
        customIconUrl || null
      )
      .run();

    // Crawl the feed once and ingest it into the archive, so the client's first
    // read of this brand-new subscription is a plain D1 query (RSS only).
    if (!isAtProto && feedUrl) {
      const cacheResult = await warmFeedIntoArchive(env, feedUrl);
      if (cacheResult.success) {
        console.log(`Ingested new feed: ${feedUrl} (${cacheResult.itemCount} items)`);
      } else {
        console.error(`Failed to ingest ${feedUrl}: ${cacheResult.error}`);
      }
    }

    // Push to PDS in background if sync is enabled (fire and forget)
    // Fetch settings once here to avoid redundant lookups in the helper
    const settings = await getUserSettings(env, session.did);
    ctx.waitUntil(
      maybePushToPds(
        session,
        settings.pdsSyncEnabled,
        rkey,
        feedUrl || '',
        title,
        siteUrl,
        sourceType,
        subjectDid,
        collectionNsid,
        customTitle,
        customIconUrl,
        category
      )
    );

    // A linkblog follow also writes a portable site.standard.graph.subscription
    // so the follow is visible across the Atmosphere (gated on Atmospheric sync).
    ctx.waitUntil(
      maybeSyncAtmosphereSubscription(
        session,
        settings.pdsSyncEnabled,
        'create',
        sourceType,
        feedUrl
      )
    );

    return new Response(
      JSON.stringify({
        rkey,
        uri: recordUri,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Create subscription error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to create subscription';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// DELETE /api/subscriptions/:rkey - Delete a subscription
export async function handleDeleteSubscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'DELETE') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Extract rkey from URL path
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const rkey = pathParts[pathParts.length - 1];

  if (!rkey || rkey === 'subscriptions') {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate rkey format to prevent pattern injection
  if (!isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }

  try {
    // Look up the row first so we know whether this was a linkblog follow (and
    // thus whether to remove its portable Atmosphere subscription record).
    const row = await env.DB.prepare(
      'SELECT feed_url, source_type FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
    )
      .bind(session.did, `%/${rkey}`)
      .first<{ feed_url: string | null; source_type: string | null }>();

    const settings = await getUserSettings(env, session.did);

    // Remove the portable Atmosphere subscription (graph edge) first. Awaited and
    // fail-loud: if Atmospheric subscription sync is on, reconcile treats a graph
    // edge that's still present as a live follow and would re-import the
    // publication we're unsubscribing from. Removing the edge before the local
    // delete closes that resurrection window; if it fails we abort here (the
    // helper throws) rather than leaving a zombie follow behind. Non-publication /
    // sync-off deletes are a no-op.
    await deleteAtmosphereSubscriptionIfEnabled(
      session,
      settings.pdsSyncEnabled,
      row?.source_type,
      row?.feed_url
    );

    // Delete from PDS before removing the local cache/returning so the next sync cannot
    // re-import the record.
    await deleteFromPdsIfEnabled(session, settings.pdsSyncEnabled, rkey);

    await env.DB.prepare('DELETE FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?')
      .bind(session.did, `%/${rkey}`)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Delete subscription error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to delete subscription';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// PATCH /api/subscriptions/:rkey - Update subscription custom fields
export async function handleUpdateSubscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Extract rkey from URL path
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const rkey = pathParts[pathParts.length - 1];

  if (!rkey || rkey === 'subscriptions') {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }

  let body: {
    customTitle?: string | null;
    customIconUrl?: string | null;
    category?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Read existing row to get full record for PDS push
    const existing = await env.DB.prepare(
      `SELECT feed_url, title, source_type, subject_did, custom_title, custom_icon_url, category
       FROM subscriptions_cache
       WHERE user_did = ? AND record_uri LIKE ?`
    )
      .bind(session.did, `%/${rkey}`)
      .first<{
        feed_url: string;
        title: string | null;
        source_type: string | null;
        subject_did: string | null;
        custom_title: string | null;
        custom_icon_url: string | null;
        category: string | null;
      }>();

    if (!existing) {
      return new Response(JSON.stringify({ error: 'Subscription not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update D1 with new custom fields
    const newCustomTitle =
      body.customTitle === null ? null : (body.customTitle ?? existing.custom_title);
    const newCustomIconUrl =
      body.customIconUrl === null ? null : (body.customIconUrl ?? existing.custom_icon_url);
    const newCategory = body.category === null ? null : (body.category ?? existing.category);

    await env.DB.prepare(
      `UPDATE subscriptions_cache SET custom_title = ?, custom_icon_url = ?, category = ?
       WHERE user_did = ? AND record_uri LIKE ?`
    )
      .bind(newCustomTitle, newCustomIconUrl, newCategory, session.did, `%/${rkey}`)
      .run();

    // Push full record to PDS in background
    const settings = await getUserSettings(env, session.did);
    ctx.waitUntil(
      maybePushToPds(
        session,
        settings.pdsSyncEnabled,
        rkey,
        existing.feed_url,
        existing.title || undefined,
        undefined,
        existing.source_type || undefined,
        existing.subject_did || undefined,
        undefined,
        newCustomTitle || undefined,
        newCustomIconUrl || undefined,
        newCategory || undefined
      )
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Update subscription error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to update subscription';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST /api/subscriptions/bulk - Bulk create subscriptions (for OPML import)
export async function handleBulkCreateSubscriptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: BulkCreateSubscriptionsRequest;
  try {
    body = (await request.json()) as BulkCreateSubscriptionsRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { subscriptions } = body;

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    return new Response(JSON.stringify({ error: 'subscriptions array is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate all subscriptions
  for (const sub of subscriptions) {
    if (!sub.rkey || typeof sub.rkey !== 'string') {
      return new Response(JSON.stringify({ error: 'Each subscription must have an rkey' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Validate rkey format to prevent pattern injection
    if (!isValidRkey(sub.rkey)) {
      return new Response(JSON.stringify({ error: `Invalid rkey format: ${sub.rkey}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!sub.feedUrl || typeof sub.feedUrl !== 'string') {
      return new Response(JSON.stringify({ error: 'Each subscription must have a feedUrl' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!isValidUrl(sub.feedUrl)) {
      return new Response(JSON.stringify({ error: `Invalid feedUrl: ${sub.feedUrl}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Tier-aware import: rather than rejecting an over-limit batch wholesale, fill
  // the remaining active slots (in import order) and PARK the overflow — saved +
  // mirrored to the PDS, just not serviced — so we never drop feeds the user chose
  // to import. `activeBudget` is how many of this batch can be active; the rest
  // come in parked (active=0). On a count failure, fall back to all-active.
  let activeBudget = subscriptions.length;
  // How many of this batch we can mirror at all (active + parked) before hitting
  // the plan's mirror ceiling. The overflow past this is dropped — not stored
  // locally — though it still lives on the user's PDS. Falls back to "all" on a
  // count failure so a transient error never silently drops a user's import.
  let mirrorBudget = subscriptions.length;
  try {
    const limits = await getUserTierLimits(env, session.did);
    const currentActive = await countActiveSubscriptions(env, session.did);
    const currentTotal = await countAllSubscriptions(env, session.did);
    activeBudget = Math.max(0, limits.maxSubscriptions - currentActive);
    mirrorBudget = Math.max(0, limits.maxMirroredSubscriptions - currentTotal);
  } catch (countError) {
    console.error('Failed to check subscription count:', countError);
  }

  // Dedupe against feeds the user already has — ACTIVE or PARKED. The reader's
  // client list only knows active subs, so a re-import could otherwise create a
  // second (parked) row for a feed that's already parked. Skip any incoming feed
  // whose URL already exists; the existing row and its PDS record stay untouched.
  const existingFeedUrls = new Set<string>();
  try {
    const existing = await env.DB.prepare(
      'SELECT feed_url FROM subscriptions_cache WHERE user_did = ?'
    )
      .bind(session.did)
      .all<{ feed_url: string }>();
    for (const row of existing.results || []) {
      if (row.feed_url) existingFeedUrls.add(row.feed_url.toLowerCase());
    }
  } catch (dedupeError) {
    console.error('Failed to load existing feeds for dedupe:', dedupeError);
  }

  try {
    const collection = 'app.skyreader.feed.subscription';
    const batchStatements: ReturnType<typeof env.DB.prepare>[] = [];
    const feedsToFetch: string[] = [];
    const results: Array<{ rkey: string; uri: string }> = [];
    // rkeys parked because the batch exceeded the plan's active capacity. Returned
    // to the client so it doesn't add them to the reader's local cache as active.
    const parked: string[] = [];
    // rkeys skipped as duplicates of a feed the user already has (active or parked).
    const skipped: string[] = [];
    // rkeys dropped because the batch would exceed the plan's mirror ceiling —
    // not stored locally or pushed to the PDS by this import (but if the feed was
    // already on the PDS it stays there). Returned so the client can report them.
    const dropped: string[] = [];
    // Inserted subs (active + parked, minus skipped dupes) — only these get pushed
    // to the PDS, so a re-import doesn't create duplicate PDS records.
    const inserted: Array<{ rkey: string; feedUrl: string; title?: string }> = [];

    let activeAdded = 0;
    let mirroredAdded = 0;
    for (const sub of subscriptions) {
      const feedKey = sub.feedUrl.toLowerCase();
      // Already have it (active or parked), or a dupe within this same batch.
      if (existingFeedUrls.has(feedKey)) {
        skipped.push(sub.rkey);
        continue;
      }
      existingFeedUrls.add(feedKey);

      // Past the mirror ceiling — don't materialize a row for it at all.
      if (mirroredAdded >= mirrorBudget) {
        dropped.push(sub.rkey);
        continue;
      }
      mirroredAdded++;

      const active = activeAdded < activeBudget ? 1 : 0;
      const recordUri = `at://${session.did}/${collection}/${sub.rkey}`;
      results.push({ rkey: sub.rkey, uri: recordUri });
      inserted.push({ rkey: sub.rkey, feedUrl: sub.feedUrl, title: sub.title });

      batchStatements.push(
        env.DB.prepare(
          `
					INSERT OR REPLACE INTO subscriptions_cache
					(user_did, record_uri, feed_url, title, category, created_at, active)
					VALUES (?, ?, ?, ?, ?, unixepoch(), ?)
					`
        ).bind(session.did, recordUri, sub.feedUrl, sub.title || null, sub.category || null, active)
      );

      // Only warm feeds we'll actually service/show; parked feeds stay cold.
      if (active) {
        feedsToFetch.push(sub.feedUrl);
        activeAdded++;
      } else {
        parked.push(sub.rkey);
      }
    }

    // Execute all D1 operations in a single batch
    if (batchStatements.length > 0) {
      await env.DB.batch(batchStatements);
    }

    // Crawl + ingest the first few new subscriptions (batch is efficient) so the
    // client's backfill reads them straight from the archive.
    const MAX_FEEDS_TO_WARM = 10;
    const feedsToWarmNow = feedsToFetch.slice(0, MAX_FEEDS_TO_WARM);
    if (feedsToWarmNow.length > 0) {
      const cacheResults = await warmFeedsIntoArchive(env, feedsToWarmNow);
      for (const [feedUrl, result] of Object.entries(cacheResults)) {
        if (result.success) {
          console.log(`Ingested new feed: ${feedUrl} (${result.itemCount} items)`);
        } else {
          console.error(`Failed to ingest ${feedUrl}: ${result.error}`);
        }
      }
    }
    if (feedsToFetch.length > MAX_FEEDS_TO_WARM) {
      console.log(`${feedsToFetch.length - MAX_FEEDS_TO_WARM} feeds will be warmed by cron`);
    }

    // Push to PDS in background if sync is enabled — inserted rows only, so a
    // re-import of an already-owned feed can't write a duplicate PDS record.
    const settings = await getUserSettings(env, session.did);
    ctx.waitUntil(maybeBulkPushToPds(session, settings.pdsSyncEnabled, inserted));

    return new Response(JSON.stringify({ results, parked, skipped, dropped }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Bulk create subscriptions error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to create subscriptions';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST /api/subscriptions/bulk-update - Bulk update subscription fields
export async function handleBulkUpdateSubscriptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: {
    rkeys: string[];
    updates: {
      customTitle?: string | null;
      customIconUrl?: string | null;
      category?: string | null;
    };
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { rkeys, updates } = body;

  if (!Array.isArray(rkeys) || rkeys.length === 0) {
    return new Response(JSON.stringify({ error: 'rkeys array is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!updates || typeof updates !== 'object') {
    return new Response(JSON.stringify({ error: 'updates object is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  for (const rkey of rkeys) {
    if (!isValidRkey(rkey)) {
      return new Response(JSON.stringify({ error: `Invalid rkey format: ${rkey}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  try {
    // Build SET clause from provided updates
    const setClauses: string[] = [];
    const setValues: (string | null)[] = [];

    if (updates.customTitle !== undefined) {
      setClauses.push('custom_title = ?');
      setValues.push(updates.customTitle);
    }
    if (updates.customIconUrl !== undefined) {
      setClauses.push('custom_icon_url = ?');
      setValues.push(updates.customIconUrl);
    }
    if (updates.category !== undefined) {
      setClauses.push('category = ?');
      setValues.push(updates.category);
    }

    if (setClauses.length === 0) {
      return new Response(JSON.stringify({ success: true, updated: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const batchStatements = rkeys.map((rkey) =>
      env.DB.prepare(
        `UPDATE subscriptions_cache SET ${setClauses.join(', ')}
         WHERE user_did = ? AND record_uri LIKE ?`
      ).bind(...setValues, session.did, `%/${rkey}`)
    );

    await env.DB.batch(batchStatements);

    // Push updated records to PDS in background
    const settings = await getUserSettings(env, session.did);
    if (settings.pdsSyncEnabled) {
      const rows = await env.DB.prepare(
        `SELECT record_uri, feed_url, title, source_type, subject_did, custom_title, custom_icon_url, category
         FROM subscriptions_cache
         WHERE user_did = ? AND (${rkeys.map(() => 'record_uri LIKE ?').join(' OR ')})`
      )
        .bind(session.did, ...rkeys.map((rk) => `%/${rk}`))
        .all<{
          record_uri: string;
          feed_url: string;
          title: string | null;
          source_type: string | null;
          subject_did: string | null;
          custom_title: string | null;
          custom_icon_url: string | null;
          category: string | null;
        }>();

      for (const row of rows.results) {
        const rkey = row.record_uri.split('/').pop()!;
        ctx.waitUntil(
          maybePushToPds(
            session,
            true,
            rkey,
            row.feed_url,
            row.title || undefined,
            undefined,
            row.source_type || undefined,
            row.subject_did || undefined,
            undefined,
            row.custom_title || undefined,
            row.custom_icon_url || undefined,
            row.category || undefined
          )
        );
      }
    }

    return new Response(JSON.stringify({ success: true, updated: rkeys.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Bulk update subscriptions error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to update subscriptions';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST /api/subscriptions/bulk-delete - Bulk delete subscriptions
export async function handleBulkDeleteSubscriptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: BulkDeleteSubscriptionsRequest;
  try {
    body = (await request.json()) as BulkDeleteSubscriptionsRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { rkeys } = body;

  if (!Array.isArray(rkeys) || rkeys.length === 0) {
    return new Response(JSON.stringify({ error: 'rkeys array is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate all rkeys to prevent pattern injection
  for (const rkey of rkeys) {
    if (!isValidRkey(rkey)) {
      return new Response(JSON.stringify({ error: `Invalid rkey format: ${rkey}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  try {
    const batchStatements = rkeys.map((rkey) =>
      env.DB.prepare(
        'DELETE FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
      ).bind(session.did, `%/${rkey}`)
    );

    if (batchStatements.length > 0) {
      await env.DB.batch(batchStatements);
    }

    // Delete from PDS in background if sync is enabled
    const settings = await getUserSettings(env, session.did);
    ctx.waitUntil(maybeBulkDeleteFromPds(session, settings.pdsSyncEnabled, rkeys));

    return new Response(JSON.stringify({ success: true, deleted: rkeys.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Bulk delete subscriptions error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to delete subscriptions';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// GET /api/subscriptions/parked - List parked (inactive) subscriptions.
//
// These are PDS records mirrored locally but held over the user's active
// capacity — present and portable, just not serviced. The reader's normal list
// (/api/records/list) returns active subs only; this endpoint backs the manage
// surface where the user sees and reactivates parked feeds.
export async function handleListParkedSubscriptions(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(
      `SELECT record_uri, feed_url, title, created_at, source_type, subject_did, custom_title, custom_icon_url, category
       FROM subscriptions_cache
       WHERE user_did = ? AND active = 0
       ORDER BY created_at ASC`
    )
      .bind(session.did)
      .all<{
        record_uri: string;
        feed_url: string;
        title: string | null;
        created_at: number;
        source_type: string | null;
        subject_did: string | null;
        custom_title: string | null;
        custom_icon_url: string | null;
        category: string | null;
      }>();

    const records = (result.results || []).map((row) => {
      // created_at is unix seconds, but a prior Jetstream bug stored ms; detect both.
      const createdAtMs = row.created_at > 10_000_000_000 ? row.created_at : row.created_at * 1000;
      return {
        uri: row.record_uri,
        cid: '',
        value: {
          $type: 'app.skyreader.feed.subscription',
          feedUrl: row.feed_url,
          title: row.title,
          createdAt: new Date(createdAtMs).toISOString(),
          sourceType: row.source_type || undefined,
          subjectDid: row.subject_did || undefined,
          customTitle: row.custom_title || undefined,
          customIconUrl: row.custom_icon_url || undefined,
          category: row.category || undefined,
        },
      };
    });

    return new Response(JSON.stringify({ records }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('List parked subscriptions error:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to list parked subscriptions';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST /api/subscriptions/:rkey/activate - Reactivate a parked subscription.
// POST /api/subscriptions/:rkey/park     - Park an active subscription.
//
// Parking/activating only flips local servicing state; the PDS record is never
// touched (active is not a PDS field). Activating enforces the tier's active cap
// so the reader can't be pushed past what the plan services — the user parks one
// feed to make room for another. Idempotent: a no-op flip just returns success.
export async function handleSetSubscriptionActive(
  request: Request,
  env: Env,
  active: boolean
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Path is /api/subscriptions/:rkey/(activate|park) — rkey is the second-to-last segment.
  const pathParts = new URL(request.url).pathname.split('/');
  const rkey = pathParts[pathParts.length - 2];

  if (!rkey || !isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }

  try {
    const existing = await env.DB.prepare(
      'SELECT active FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
    )
      .bind(session.did, `%/${rkey}`)
      .first<{ active: number }>();

    if (!existing) {
      return new Response(JSON.stringify({ error: 'Subscription not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Already in the desired state — parking still records explicit user intent
    // for rows that were previously parked automatically due to capacity.
    if (!!existing.active === active) {
      if (!active) {
        await env.DB.prepare(
          'UPDATE subscriptions_cache SET user_parked = 1 WHERE user_did = ? AND record_uri LIKE ?'
        )
          .bind(session.did, `%/${rkey}`)
          .run();
      }
      return new Response(JSON.stringify({ success: true, active }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Activating: don't push the reader past the plan's active capacity.
    if (active) {
      const limits = await getUserTierLimits(env, session.did);
      const currentCount = await countActiveSubscriptions(env, session.did);
      if (currentCount >= limits.maxSubscriptions) {
        return new Response(
          JSON.stringify({
            error: 'subscription_limit_reached',
            message: `You have reached the maximum of ${limits.maxSubscriptions} active feeds. Park a feed to free a slot.`,
            limit: limits.maxSubscriptions,
            current: currentCount,
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    await env.DB.prepare(
      'UPDATE subscriptions_cache SET active = ?, user_parked = ? WHERE user_did = ? AND record_uri LIKE ?'
    )
      .bind(active ? 1 : 0, active ? 0 : 1, session.did, `%/${rkey}`)
      .run();

    return new Response(JSON.stringify({ success: true, active }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Set subscription active error:', error);
    const errorMessage =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Failed to update subscription';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
