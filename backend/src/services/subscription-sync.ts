import type { Env, Session } from '../types';
import { createPDSClient, type PDSResult, type WriteOp } from './pds-client';
import { getUserTierLimits } from './user-tier';

const COLLECTION = 'app.skyreader.feed.subscription';

/**
 * PDS subscription record schema
 */
interface PDSSubscriptionRecord {
  feedUrl?: string;
  title?: string;
  siteUrl?: string;
  category?: string;
  tags?: string[];
  createdAt: string;
  $type?: string;
  sourceType?: string;
  subjectDid?: string;
  collectionNsid?: string;
  customTitle?: string;
  customIconUrl?: string;
}

/**
 * Local subscription cache row
 */
interface LocalSubscription {
  record_uri: string;
  feed_url: string;
  title: string | null;
  created_at: number;
  source_type: string | null;
  subject_did: string | null;
  custom_title: string | null;
  custom_icon_url: string | null;
  active: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  success: boolean;
  error?: string;
  pulledFromPds: number;
  pushedToPds: number;
  skipped: number;
  /** Parked rows promoted back to active because the active limit had headroom */
  reactivated: number;
  warnings: string[];
  /** If true, there are more records to push - call sync again */
  hasMore?: boolean;
  /**
   * Set when the PDS host moved (migration) but the existing tokens were
   * rejected by the new host — the user must reconnect their account.
   */
  needsReauth?: boolean;
}

// Batch size for applyWrites - 200 is the documented limit but large batches
// can fail with 500 errors, possibly due to request body size. Using 50 as safe default.
const MAX_BATCH_SIZE = 50;
// Limit PDS listing to avoid using too many subrequests (1 per 100 records)
const MAX_LIST_PAGES = 20;

/**
 * Extract rkey from a record URI
 * Format: at://did:plc:xxx/collection/rkey
 */
function extractRkey(uri: string): string {
  const parts = uri.split('/');
  return parts[parts.length - 1];
}

/**
 * Build a record URI from components
 */
function buildRecordUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`;
}

/**
 * Sync subscriptions between local D1 cache and user's PDS
 *
 * Pull and Merge Algorithm:
 * 1. Fetch all from PDS (with pagination)
 * 2. Fetch all from local D1 subscriptions_cache
 * 3. For each PDS record not in local: add if under 100 limit
 * 4. For each local record not in PDS: push to PDS
 * 5. For conflicts: keep both (merge by feedUrl)
 */
export async function syncSubscriptions(
  session: Session,
  env: Env,
  sessionId?: string
): Promise<SyncResult> {
  const result: SyncResult = {
    success: true,
    pulledFromPds: 0,
    pushedToPds: 0,
    skipped: 0,
    reactivated: 0,
    warnings: [],
  };

  // With a sessionId, the client can self-heal a stale PDS host (PDS migration)
  // by re-resolving from the DID doc and persisting the new host to the session.
  const pdsClient = createPDSClient(session, sessionId ? { env, sessionId } : undefined);

  try {
    // Step 1: Fetch records from PDS (limited to avoid subrequest limit)
    console.log('[SubscriptionSync] Fetching records from PDS...');
    const pdsResult = await pdsClient.listAllRecords<PDSSubscriptionRecord>(COLLECTION, {
      maxPages: MAX_LIST_PAGES,
    });
    if (!pdsResult.success) {
      console.error('[SubscriptionSync] Failed to fetch from PDS:', pdsResult.error);
      return {
        ...result,
        success: false,
        error: `Failed to fetch from PDS: ${pdsResult.error}`,
        needsReauth: pdsResult.needsReauth,
      };
    }

    const pdsRecords = pdsResult.data;
    console.log(`[SubscriptionSync] Found ${pdsRecords.length} records in PDS`);
    for (const rec of pdsRecords) {
      console.log(`[SubscriptionSync] PDS record: ${rec.uri} -> ${rec.value.feedUrl}`);
    }

    // Get tier-aware limits
    const limits = await getUserTierLimits(env, session.did);
    const maxSubscriptions = limits.maxSubscriptions;
    const maxMirrored = limits.maxMirroredSubscriptions;

    // Pull the FULL PDS set — never drop records the user owns. Oldest-first so
    // that when the set exceeds the plan's active capacity, the oldest feeds fill
    // the active slots and the newest overflow is parked (mirrored locally but not
    // serviced). createdAt order keeps which-feeds-are-active stable across syncs.
    const sortedPdsRecords = [...pdsRecords].sort((a, b) => {
      const dateA = new Date(a.value.createdAt || 0).getTime();
      const dateB = new Date(b.value.createdAt || 0).getTime();
      return dateA - dateB;
    });

    // Step 2: Fetch all local subscriptions
    const localResult = await env.DB.prepare(
      `SELECT record_uri, feed_url, title, created_at, source_type, subject_did, custom_title, custom_icon_url, active
			 FROM subscriptions_cache
			 WHERE user_did = ?`
    )
      .bind(session.did)
      .all<LocalSubscription>();

    const localSubscriptions = localResult.results || [];
    console.log(`[SubscriptionSync] Found ${localSubscriptions.length} local subscriptions`);

    // Build a unique key for deduplication. RSS dedups by feedUrl; AT Proto by
    // sourceType + subjectDid + feedUrl, where feedUrl is the publication AT-URI —
    // so two publications owned by the same author DID are distinct subscriptions.
    function subscriptionKey(feedUrl?: string, sourceType?: string, subjectDid?: string): string {
      if (sourceType && sourceType.startsWith('atproto.') && subjectDid) {
        return `${sourceType}:${subjectDid}:${feedUrl || ''}`;
      }
      return feedUrl || '';
    }

    // Create lookup maps
    const pdsByKey = new Map<string, (typeof sortedPdsRecords)[0]>();
    const pdsByRkey = new Map<string, (typeof sortedPdsRecords)[0]>();
    for (const record of sortedPdsRecords) {
      const key = subscriptionKey(
        record.value.feedUrl,
        record.value.sourceType,
        record.value.subjectDid
      );
      if (key) {
        pdsByKey.set(key, record);
        pdsByRkey.set(extractRkey(record.uri), record);
      }
    }

    const localByKey = new Map<string, LocalSubscription>();
    const localByRkey = new Map<string, LocalSubscription>();
    for (const sub of localSubscriptions) {
      const key = subscriptionKey(
        sub.feed_url,
        sub.source_type || undefined,
        sub.subject_did || undefined
      );
      if (key) {
        localByKey.set(key, sub);
      }
      const rkey = extractRkey(sub.record_uri);
      if (rkey) {
        localByRkey.set(rkey, sub);
      }
    }

    // Step 3: Pull from PDS - add records that don't exist locally
    const toAddLocally: Array<{
      rkey: string;
      feedUrl: string;
      title: string | null;
      createdAt: number;
      sourceType: string | null;
      subjectDid: string | null;
      customTitle: string | null;
      customIconUrl: string | null;
      category: string | null;
      active: number;
    }> = [];

    // Active-capacity bookkeeping. Existing active local rows already consume
    // slots; new pulls fill the remainder oldest-first, then overflow is parked
    // (active=0): saved locally + still on the PDS, just not serviced or shown.
    let activeCount = localSubscriptions.filter((s) => s.active === 1).length;
    let parkedOnPull = 0;
    // Mirror-cap bookkeeping. Parking is unlimited only up to the plan's mirror
    // ceiling; past it we stop materializing rows entirely (the record still lives
    // on the PDS and re-appears if the user frees room or upgrades). Oldest-first
    // ordering means the dropped overflow is always the newest records.
    let totalLocal = localSubscriptions.length;
    let droppedOverCap = 0;

    for (const pdsRecord of sortedPdsRecords) {
      const key = subscriptionKey(
        pdsRecord.value.feedUrl,
        pdsRecord.value.sourceType,
        pdsRecord.value.subjectDid
      );
      if (!key) continue;

      // Already have this subscription locally — leave its active state untouched
      // (never silently demote something the reader is already showing).
      if (localByKey.has(key)) continue;

      // Hard mirror cap — don't materialize more than the plan's ceiling.
      if (totalLocal >= maxMirrored) {
        droppedOverCap++;
        result.skipped++;
        continue;
      }

      const active = activeCount < maxSubscriptions ? 1 : 0;
      if (active) {
        activeCount++;
      } else {
        parkedOnPull++;
      }
      totalLocal++;

      const rkey = extractRkey(pdsRecord.uri);
      toAddLocally.push({
        rkey,
        feedUrl: pdsRecord.value.feedUrl || '',
        title: pdsRecord.value.title || null,
        createdAt: pdsRecord.value.createdAt
          ? Math.floor(new Date(pdsRecord.value.createdAt).getTime() / 1000)
          : Math.floor(Date.now() / 1000),
        sourceType: pdsRecord.value.sourceType || null,
        subjectDid: pdsRecord.value.subjectDid || null,
        customTitle: pdsRecord.value.customTitle || null,
        customIconUrl: pdsRecord.value.customIconUrl || null,
        category: pdsRecord.value.category || null,
        active,
      });
    }

    if (parkedOnPull > 0) {
      result.warnings.push(
        `${parkedOnPull} feed${parkedOnPull === 1 ? '' : 's'} over your plan's active limit of ${maxSubscriptions} ` +
          `${parkedOnPull === 1 ? 'was' : 'were'} parked — still saved to your account, just not shown. ` +
          `Reactivate from Manage feeds.`
      );
    }

    if (droppedOverCap > 0) {
      result.warnings.push(
        `${droppedOverCap} feed${droppedOverCap === 1 ? '' : 's'} over your plan's mirror limit of ${maxMirrored} ` +
          `${droppedOverCap === 1 ? 'was' : 'were'} not synced to this device. ` +
          `${droppedOverCap === 1 ? 'It is' : 'They are'} still on your PDS.`
      );
    }

    // Insert pulled records into local D1
    console.log(
      `[SubscriptionSync] Will add ${toAddLocally.length} subscriptions from PDS to local`
    );
    if (toAddLocally.length > 0) {
      for (const sub of toAddLocally) {
        console.log(`[SubscriptionSync] Adding from PDS: ${sub.feedUrl}`);
      }
      const statements = toAddLocally.map((sub) => {
        const recordUri = buildRecordUri(session.did, COLLECTION, sub.rkey);
        return env.DB.prepare(
          `INSERT OR IGNORE INTO subscriptions_cache
					 (user_did, record_uri, feed_url, title, created_at, source_type, subject_did, custom_title, custom_icon_url, category, active)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          session.did,
          recordUri,
          sub.feedUrl,
          sub.title,
          sub.createdAt,
          sub.sourceType,
          sub.subjectDid,
          sub.customTitle,
          sub.customIconUrl,
          sub.category,
          sub.active
        );
      });

      await env.DB.batch(statements);
      result.pulledFromPds = toAddLocally.length;
      console.log(`[SubscriptionSync] Successfully inserted ${toAddLocally.length} subscriptions`);
    }

    // Step 3b: Auto-fill freed active slots. Parking is sticky, but capacity does
    // change — a tier upgrade raises maxSubscriptions, and removing/parking active
    // feeds frees slots. Rather than leaving those slots empty until the user
    // manually reactivates, promote the oldest parked rows (createdAt order, the
    // same order parking fills) back to active to fill the headroom. Re-query the
    // live active count so concurrent syncs / ignored inserts can't drift it.
    const activeRow = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ? AND active = 1'
    )
      .bind(session.did)
      .first<{ count: number }>();
    const liveActive = activeRow?.count || 0;
    if (liveActive < maxSubscriptions) {
      const slack = maxSubscriptions - liveActive;
      const parkedRows = await env.DB.prepare(
        `SELECT record_uri FROM subscriptions_cache
         WHERE user_did = ? AND active = 0
         ORDER BY created_at ASC, record_uri ASC
         LIMIT ?`
      )
        .bind(session.did, slack)
        .all<{ record_uri: string }>();
      const toPromote = parkedRows.results || [];
      if (toPromote.length > 0) {
        await env.DB.batch(
          toPromote.map((row) =>
            env.DB.prepare(
              'UPDATE subscriptions_cache SET active = 1 WHERE user_did = ? AND record_uri = ?'
            ).bind(session.did, row.record_uri)
          )
        );
        result.reactivated = toPromote.length;
        console.log(`[SubscriptionSync] Reactivated ${toPromote.length} parked subscription(s)`);
      }
    }

    // Step 4: Push to PDS - add local records that don't exist in PDS (by feedUrl)
    // We check by rkey to determine create vs update, and skip no-ops
    const writes: WriteOp[] = [];
    let skippedNoOp = 0;

    for (const localSub of localSubscriptions) {
      // Skip if this subscription already exists in PDS (by key)
      const key = subscriptionKey(
        localSub.feed_url,
        localSub.source_type || undefined,
        localSub.subject_did || undefined
      );
      if (!key || pdsByKey.has(key)) {
        continue;
      }

      const rkey = extractRkey(localSub.record_uri);
      if (!rkey) continue;

      // created_at should be unix seconds, but a previous bug stored milliseconds
      // via Jetstream. Detect and handle both: values > 10_000_000_000 are likely ms.
      const createdAtMs =
        localSub.created_at > 10_000_000_000 ? localSub.created_at : localSub.created_at * 1000;
      const newRecord: PDSSubscriptionRecord = {
        $type: COLLECTION,
        feedUrl: localSub.feed_url || undefined,
        title: localSub.title || undefined,
        createdAt: new Date(createdAtMs).toISOString(),
        sourceType: localSub.source_type || undefined,
        subjectDid: localSub.subject_did || undefined,
        customTitle: localSub.custom_title || undefined,
        customIconUrl: localSub.custom_icon_url || undefined,
      };

      // Check if this rkey exists on PDS (possibly with different feedUrl)
      const existingPdsRecord = pdsByRkey.get(rkey);

      if (existingPdsRecord) {
        // Rkey exists - check if it's a no-op (same content)
        const existingValue = existingPdsRecord.value;
        if (
          existingValue.feedUrl === newRecord.feedUrl &&
          (existingValue.title || undefined) === newRecord.title &&
          (existingValue.customTitle || undefined) === newRecord.customTitle &&
          (existingValue.customIconUrl || undefined) === newRecord.customIconUrl
        ) {
          skippedNoOp++;
          continue;
        }

        // Content differs - use update
        writes.push({
          $type: 'com.atproto.repo.applyWrites#update',
          collection: COLLECTION,
          rkey,
          value: newRecord,
        });
      } else {
        // Rkey doesn't exist - use create
        writes.push({
          $type: 'com.atproto.repo.applyWrites#create',
          collection: COLLECTION,
          rkey,
          value: newRecord,
        });
      }
    }

    if (skippedNoOp > 0) {
      console.log(`[SubscriptionSync] Skipped ${skippedNoOp} no-op writes`);
    }

    // Push records to PDS using batch writes
    if (writes.length > 0) {
      // Limit batch size
      const batch = writes.slice(0, MAX_BATCH_SIZE);
      if (writes.length > MAX_BATCH_SIZE) {
        result.hasMore = true;
        console.log(
          `[SubscriptionSync] Batch limit reached, ${writes.length - MAX_BATCH_SIZE} remaining`
        );
      }

      const creates = batch.filter((w) => w.$type.endsWith('#create')).length;
      const updates = batch.filter((w) => w.$type.endsWith('#update')).length;
      console.log(
        `[SubscriptionSync] Batch pushing ${batch.length} records to PDS (${creates} creates, ${updates} updates)...`
      );

      // Log what we're sending for debugging
      for (const write of batch) {
        if (write.$type !== 'com.atproto.repo.applyWrites#delete') {
          const value = write.value as PDSSubscriptionRecord;
          console.log(
            `[SubscriptionSync] ${write.$type.split('#')[1]}: ${write.rkey} -> ${value.feedUrl}`
          );
        }
      }

      const batchResult = await pdsClient.applyWrites(batch);
      if (!batchResult.success) {
        console.error('[SubscriptionSync] Batch push failed:', batchResult.error);

        // Fall back to individual puts (limited to avoid subrequest limit)
        const MAX_FALLBACK = 10;
        const fallbackBatch = batch.slice(0, MAX_FALLBACK);
        console.log(
          `[SubscriptionSync] Falling back to individual puts (${fallbackBatch.length} of ${batch.length})...`
        );
        let succeeded = 0;
        const errors: string[] = [];

        for (const write of fallbackBatch) {
          if (write.$type === 'com.atproto.repo.applyWrites#delete') continue;
          const value = write.value as PDSSubscriptionRecord;

          const putResult = await pdsClient.putRecord(COLLECTION, write.rkey, value);
          if (putResult.success) {
            succeeded++;
          } else {
            console.error(`[SubscriptionSync] Failed to put ${write.rkey}: ${putResult.error}`);
            errors.push(`${write.rkey}: ${putResult.error}`);
          }
        }

        if (succeeded > 0) {
          result.pushedToPds = succeeded;
          console.log(
            `[SubscriptionSync] Fallback succeeded: ${succeeded}/${fallbackBatch.length}`
          );
        }
        if (errors.length > 0 || batch.length > MAX_FALLBACK) {
          const remaining = batch.length - MAX_FALLBACK;
          const msg =
            remaining > 0
              ? `${errors.length} failed, ${remaining} skipped (will retry on next sync)`
              : errors.join('; ');
          result.warnings.push(`Some records failed: ${msg}`);
        }
      } else {
        result.pushedToPds = batchResult.data.results.length;
        console.log(`[SubscriptionSync] Successfully pushed ${result.pushedToPds} records`);
      }
    }

    return result;
  } catch (error) {
    console.error('Subscription sync error:', error);
    return {
      ...result,
      success: false,
      error: error instanceof Error ? error.message : 'Sync failed',
    };
  }
}

/**
 * Push a single subscription to PDS (for use with waitUntil on create)
 */
export async function pushSubscriptionToPds(
  session: Session,
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
): Promise<PDSResult<void>> {
  const pdsClient = createPDSClient(session);

  const record: PDSSubscriptionRecord = {
    $type: COLLECTION,
    feedUrl: feedUrl || undefined,
    title,
    siteUrl,
    category,
    createdAt: new Date().toISOString(),
    sourceType,
    subjectDid,
    collectionNsid,
    customTitle,
    customIconUrl,
  };

  const result = await pdsClient.putRecord(COLLECTION, rkey, record);
  if (result.success) {
    return { success: true, data: undefined };
  }
  return result;
}

/**
 * Delete a subscription from PDS (for use with waitUntil on delete)
 */
export async function deleteSubscriptionFromPds(
  session: Session,
  rkey: string
): Promise<PDSResult<void>> {
  const pdsClient = createPDSClient(session);
  return pdsClient.deleteRecord(COLLECTION, rkey);
}
