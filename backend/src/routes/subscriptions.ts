import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { warmProxyCache, warmProxyCacheBatch } from './feeds-v2';
import { backfillDocumentsForUser, backfillSharesForUser } from './social';
import { getUserSettings } from './settings';
import { pushSubscriptionToPds, deleteSubscriptionFromPds } from '../services/subscription-sync';
import { createPDSClient, type WriteOp } from '../services/pds-client';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import { getUserTierLimits } from '../services/user-tier';
import { normalizeFeedUrl } from '../lib/feed-url';

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

  // Build lookup maps by rkey and feedUrl. Normalize feedUrls so we catch
  // existing PDS records with trivial URL variants (case, trailing slash).
  const pdsByRkey = new Map<
    string,
    { feedUrl: string; title?: string; customTitle?: string; customIconUrl?: string }
  >();
  const pdsByFeedUrl = new Set<string>();
  for (const record of listResult.data) {
    const rkey = record.uri.split('/').pop();
    if (rkey) {
      pdsByRkey.set(rkey, record.value);
    }
    if (record.value.feedUrl) {
      try {
        pdsByFeedUrl.add(normalizeFeedUrl(record.value.feedUrl));
      } catch {
        pdsByFeedUrl.add(record.value.feedUrl);
      }
    }
  }

  // Build write operations
  const writes: WriteOp[] = [];
  let skippedExisting = 0;
  let skippedNoOp = 0;

  for (const sub of subscriptions) {
    // Skip if this feedUrl already exists in PDS (avoid duplicates)
    const subNormalized = (() => {
      try {
        return normalizeFeedUrl(sub.feedUrl);
      } catch {
        return sub.feedUrl;
      }
    })();
    if (pdsByFeedUrl.has(subNormalized)) {
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

async function countUserSubscriptions(env: Env, did: string): Promise<number> {
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

// POST /api/subscriptions - Create a single subscription
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
    body = (await request.json()) as CreateSubscriptionRequest & { rkey: string };
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
    const validSourceTypes = ['atproto.shares', 'atproto.documents', 'atproto.collection'];
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

  // Normalize the feed URL so we dedup against trivial variants
  // (case, trailing slash, default port, fragment).
  const normalizedFeedUrl = feedUrl ? normalizeFeedUrl(feedUrl) : '';

  // Check subscription limit
  try {
    const limits = await getUserTierLimits(env, session.did);
    const currentCount = await countUserSubscriptions(env, session.did);
    if (currentCount >= limits.maxSubscriptions) {
      return new Response(
        JSON.stringify({
          error: 'subscription_limit_reached',
          message: `You have reached the maximum of ${limits.maxSubscriptions} feed subscriptions.`,
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

    // Atomic, idempotent insert. The partial UNIQUE indexes installed by
    // 0052_subscription_dedup.sql make a duplicate insert a silent no-op:
    //   - RSS: (user_did, feed_url) when source_type IS NULL OR = 'rss'
    //   - AT Proto: (user_did, source_type, subject_did)
    // On conflict we return the EXISTING row so the caller — including a
    // racing concurrent POST — gets the original rkey/uri back. This makes
    // double-submit a no-op end-to-end and avoids creating an orphan PDS
    // record on the losing side of the race.
    const insertResult = await env.DB.prepare(
      `
			INSERT INTO subscriptions_cache
			(user_did, record_uri, feed_url, title, category, created_at, source_type, subject_did, custom_title, custom_icon_url)
			VALUES (?, ?, ?, ?, ?, unixepoch(), ?, ?, ?, ?)
			ON CONFLICT(user_did, feed_url) WHERE source_type IS NULL OR source_type = 'rss' DO NOTHING
			ON CONFLICT(user_did, source_type, subject_did) WHERE source_type LIKE 'atproto.%' AND subject_did IS NOT NULL DO NOTHING
			ON CONFLICT(record_uri) DO NOTHING
			RETURNING record_uri
			`
    )
      .bind(
        session.did,
        recordUri,
        normalizedFeedUrl,
        title || null,
        category || null,
        sourceType || null,
        subjectDid || null,
        customTitle || null,
        customIconUrl || null
      )
      .first<{ record_uri: string }>();

    if (!insertResult) {
      // A row already exists for this logical feed. Return the existing
      // subscription's rkey/uri instead of creating a second PDS record.
      const existing = isAtProto
        ? await env.DB.prepare(
            `SELECT record_uri FROM subscriptions_cache
             WHERE user_did = ? AND source_type = ? AND subject_did = ?`
          )
            .bind(session.did, sourceType, subjectDid)
            .first<{ record_uri: string }>()
        : await env.DB.prepare(
            `SELECT record_uri FROM subscriptions_cache
             WHERE user_did = ? AND feed_url = ?
               AND (source_type IS NULL OR source_type = 'rss')`
          )
            .bind(session.did, normalizedFeedUrl)
            .first<{ record_uri: string }>();

      if (existing) {
        const existingRkey = existing.record_uri.split('/').pop() || rkey;
        return new Response(
          JSON.stringify({
            rkey: existingRkey,
            uri: existing.record_uri,
            existing: true,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Fall through — extremely unlikely race between conflict and lookup.
    }

    // Warm up proxy cache for RSS subscriptions only
    if (!isAtProto && normalizedFeedUrl) {
      const cacheResult = await warmProxyCache(env, normalizedFeedUrl);
      if (cacheResult.success) {
        console.log(`Warmed proxy cache: ${normalizedFeedUrl} (${cacheResult.itemCount} items)`);
      } else {
        console.error(`Failed to warm cache for ${normalizedFeedUrl}: ${cacheResult.error}`);
      }
    }

    // Backfill content for AT Proto subscriptions
    if (subjectDid) {
      if (sourceType === 'atproto.documents') {
        ctx.waitUntil(backfillDocumentsForUser(env, subjectDid));
      } else if (sourceType === 'atproto.shares') {
        ctx.waitUntil(backfillSharesForUser(env, subjectDid));
      }
    }

    // Push to PDS in background if sync is enabled (fire and forget).
    // Only reached when the D1 insert won — losing concurrent requests
    // returned early above, so we never create an orphan PDS record.
    const settings = await getUserSettings(env, session.did);
    ctx.waitUntil(
      maybePushToPds(
        session,
        settings.pdsSyncEnabled,
        rkey,
        normalizedFeedUrl,
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
    // Delete from PDS before removing the local cache/returning so the next sync cannot
    // re-import the record.
    const settings = await getUserSettings(env, session.did);
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

  // Validate + normalize all subscriptions.
  // We also dedupe within the input on (user_did, normalizedFeedUrl) so that
  // an OPML file containing the same feed twice doesn't generate two writes
  // — the partial UNIQUE index would catch the second, but at the cost of an
  // extra round-trip and a confusing PDS push retry.
  const seenUrls = new Set<string>();
  const normalizedSubscriptions: Array<{
    rkey: string;
    feedUrl: string;
    title?: string;
    siteUrl?: string;
    category?: string;
    source?: string;
    externalRef?: string;
  }> = [];
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

    const normalized = normalizeFeedUrl(sub.feedUrl);
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    normalizedSubscriptions.push({ ...sub, feedUrl: normalized });
  }

  // Check subscription limit
  try {
    const limits = await getUserTierLimits(env, session.did);
    const currentCount = await countUserSubscriptions(env, session.did);
    const totalAfterImport = currentCount + normalizedSubscriptions.length;

    if (totalAfterImport > limits.maxSubscriptions) {
      const available = Math.max(0, limits.maxSubscriptions - currentCount);
      return new Response(
        JSON.stringify({
          error: 'subscription_limit_exceeded',
          message: `Adding ${normalizedSubscriptions.length} feeds would exceed the maximum of ${limits.maxSubscriptions}.`,
          limit: limits.maxSubscriptions,
          current: currentCount,
          requested: normalizedSubscriptions.length,
          available,
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
    const batchStatements: ReturnType<typeof env.DB.prepare>[] = [];
    const feedsToFetch: string[] = [];
    const results: Array<{ rkey: string; uri: string }> = [];

    for (const sub of normalizedSubscriptions) {
      const recordUri = `at://${session.did}/${collection}/${sub.rkey}`;
      results.push({ rkey: sub.rkey, uri: recordUri });

      // Idempotent insert: a duplicate of an existing feed silently no-ops
      // via the partial UNIQUE index installed in 0052_subscription_dedup.
      batchStatements.push(
        env.DB.prepare(
          `
					INSERT INTO subscriptions_cache
					(user_did, record_uri, feed_url, title, category, created_at)
					VALUES (?, ?, ?, ?, ?, unixepoch())
					ON CONFLICT(user_did, feed_url) WHERE source_type IS NULL OR source_type = 'rss' DO NOTHING
					ON CONFLICT(record_uri) DO NOTHING
					`
        ).bind(session.did, recordUri, sub.feedUrl, sub.title || null, sub.category || null)
      );

      feedsToFetch.push(sub.feedUrl);
    }

    // Execute all D1 operations in a single batch
    if (batchStatements.length > 0) {
      await env.DB.batch(batchStatements);
    }

    // Warm up proxy cache for new subscriptions (batch is efficient)
    const MAX_FEEDS_TO_WARM = 10;
    const feedsToWarmNow = feedsToFetch.slice(0, MAX_FEEDS_TO_WARM);
    if (feedsToWarmNow.length > 0) {
      const cacheResults = await warmProxyCacheBatch(env, feedsToWarmNow);
      for (const [feedUrl, result] of Object.entries(cacheResults)) {
        if (result.success) {
          console.log(`Warmed proxy cache: ${feedUrl} (${result.itemCount} items)`);
        } else {
          console.error(`Failed to warm cache for ${feedUrl}: ${result.error}`);
        }
      }
    }
    if (feedsToFetch.length > MAX_FEEDS_TO_WARM) {
      console.log(`${feedsToFetch.length - MAX_FEEDS_TO_WARM} feeds will be warmed by cron`);
    }

    // Push to PDS in background if sync is enabled. maybeBulkPushToPds
    // already lists existing PDS records and skips duplicates by feedUrl.
    const settings = await getUserSettings(env, session.did);
    ctx.waitUntil(
      maybeBulkPushToPds(
        session,
        settings.pdsSyncEnabled,
        normalizedSubscriptions.map((sub) => ({
          rkey: sub.rkey,
          feedUrl: sub.feedUrl,
          title: sub.title,
        }))
      )
    );

    return new Response(JSON.stringify({ results }), {
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
