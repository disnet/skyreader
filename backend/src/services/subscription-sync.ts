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
  site_url: string | null;
  category: string | null;
  created_at: number;
  source_type: string | null;
  subject_did: string | null;
  custom_title: string | null;
  custom_icon_url: string | null;
  active: number;
  /** 1 when a local edit has not reached the PDS yet; drives the repair push. */
  pds_dirty: number;
}

/**
 * One plan cap the sync ran into, and what it did about it.
 *
 * The counts are per-call, and a full sync is a client-driven loop of calls, so
 * the client has to add them up before showing a number to the reader. That is
 * why `kind`/`subject`/`count`/`limit` are carried separately: two batches that
 * park feeds merge into one true total instead of two contradicting sentences.
 * `message` is the same fact as prose, kept for callers that only want a string;
 * the reader-facing wording lives in frontend/src/lib/utils/limitCopy.ts.
 */
export interface LimitNotice {
  kind: 'feeds' | 'mirror';
  /** What the count counts — the two syncs park different things. */
  subject: 'feeds' | 'linkblogs';
  count: number;
  limit: number;
  message: string;
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
  /**
   * Plan-limit outcomes (feeds parked over the active cap, records dropped over
   * the mirror cap). Kept apart from `warnings`, which carries things that went
   * *wrong* — the client renders these two differently, and an upgrade prompt
   * attached to a failed PDS write would be both confusing and dishonest.
   *
   * `kind` says which cap was hit, so the client can quote the raise that
   * actually applies instead of guessing from the sentence.
   */
  limitNotices: LimitNotice[];
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
 * Clear the debt after a confirmed PDS write.
 *
 * The matching "mark" has no helper: every mutation route sets `pds_dirty = 1`
 * inside the same INSERT/UPDATE that changes the row, which costs no extra D1
 * write and — more importantly — makes the debt durable in the same statement as
 * the edit, so there is no window where a row is changed but unflagged.
 *
 * Park/activate is deliberately not marked: it only moves local servicing state
 * (`active`/`user_parked`), which is never written to the PDS. Only ever called on a success
 * path: clearing optimistically would reintroduce exactly the silent drift the
 * flag exists to catch.
 */
export async function clearSubscriptionDirty(env: Env, did: string, rkey: string): Promise<void> {
  await clearSubscriptionsDirty(env, did, [rkey]);
}

// D1 caps bound parameters per statement; chunk the IN (...) list well under it.
const SETTLE_CHUNK = 80;

/**
 * Batch form of {@link clearSubscriptionDirty}.
 *
 * Matched on the exact record URI rather than `record_uri LIKE '%/rkey'`: the
 * leading wildcard makes the LIKE unindexable, so a per-rkey statement scanned
 * the table once per settled feed — several hundred scans after a large OPML
 * import. The URI is `at://<user_did>/<collection>/<rkey>` everywhere these rows
 * are written, so it can simply be rebuilt.
 */
export async function clearSubscriptionsDirty(
  env: Env,
  did: string,
  rkeys: string[]
): Promise<void> {
  const unique = [...new Set(rkeys)];
  if (unique.length === 0) return;

  const statements = [];
  for (let i = 0; i < unique.length; i += SETTLE_CHUNK) {
    const chunk = unique.slice(i, i + SETTLE_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    statements.push(
      env.DB.prepare(
        `UPDATE subscriptions_cache SET pds_dirty = 0
         WHERE user_did = ? AND record_uri IN (${placeholders})`
      ).bind(did, ...chunk.map((rkey) => buildRecordUri(did, COLLECTION, rkey)))
    );
  }
  await env.DB.batch(statements);
}

/**
 * How many of the user's subscriptions are still owed to the PDS. Drives the
 * honest "n feeds still waiting" line in settings, which replaced a last-synced
 * timestamp that said nothing about whether the feed list was actually in step.
 */
export async function countDirtySubscriptions(env: Env, did: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ? AND pds_dirty = 1'
  )
    .bind(did)
    .first<{ count: number }>();
  return row?.count || 0;
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
    limitNotices: [],
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
      `SELECT record_uri, feed_url, title, site_url, category, created_at, source_type, subject_did, custom_title, custom_icon_url, active, pds_dirty
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
      siteUrl: string | null;
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
        siteUrl: pdsRecord.value.siteUrl || null,
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
      result.limitNotices.push({
        kind: 'feeds',
        subject: 'feeds',
        count: parkedOnPull,
        limit: maxSubscriptions,
        message:
          `${parkedOnPull} feed${parkedOnPull === 1 ? '' : 's'} over your plan's active limit of ${maxSubscriptions} ` +
          `${parkedOnPull === 1 ? 'was' : 'were'} parked, still saved to your account and just not shown. ` +
          `Reactivate from Manage feeds.`,
      });
    }

    if (droppedOverCap > 0) {
      result.limitNotices.push({
        kind: 'mirror',
        subject: 'feeds',
        count: droppedOverCap,
        limit: maxMirrored,
        message:
          `${droppedOverCap} feed${droppedOverCap === 1 ? '' : 's'} over your plan's mirror limit of ${maxMirrored} ` +
          `${droppedOverCap === 1 ? 'was' : 'were'} not synced to this device. ` +
          `${droppedOverCap === 1 ? 'It is' : 'They are'} still on your PDS.`,
      });
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
					 (user_did, record_uri, feed_url, title, site_url, created_at, source_type, subject_did, custom_title, custom_icon_url, category, active)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          session.did,
          recordUri,
          sub.feedUrl,
          sub.title,
          sub.siteUrl,
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

    // Step 3b: Auto-fill freed active slots from capacity-parked rows. Rows the
    // user explicitly parked are sticky and must never be promoted by sync.
    // Re-query the live active count so concurrent syncs / ignored inserts can't drift it.
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
         WHERE user_did = ? AND active = 0 AND user_parked = 0
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
    // Rows whose debt to the PDS is settled by this run: either a write landed,
    // or the comparison showed the PDS already holds the local values (a push
    // that succeeded after the flag was set, or an edit mirrored back down by
    // the firehose). Cleared in one batch at the end so a failed write leaves
    // the flag standing and the next sync retries.
    const settledRkeys: string[] = [];
    // A write's rkey is normally the local row's own, but a repair aimed at an
    // orphaned record (below) targets the rkey the PDS uses. `pds_dirty` lives on
    // the local row, so remember which row each write settles.
    const settlesLocalRkey = new Map<string, string>();
    // PDS rkeys already claimed for a repair this run, so two local rows for the
    // same feed can't both aim a write at one record.
    const claimedPdsRkeys = new Set<string>();

    for (const localSub of localSubscriptions) {
      const key = subscriptionKey(
        localSub.feed_url,
        localSub.source_type || undefined,
        localSub.subject_did || undefined
      );
      if (!key) continue;

      // A subscription that already exists on the PDS is left alone *unless* it
      // carries an unpaid local edit. Its write-through is fire-and-forget, so a
      // rename whose push failed leaves the PDS stale with nothing to repair it;
      // this loop used to `continue` here and never reach the field comparison
      // below, making that drift permanent. Only rows flagged by the mutation
      // routes are reconsidered — the sync never diffs the two sides to guess at
      // intent, and never deletes.
      if (pdsByKey.has(key) && localSub.pds_dirty !== 1) {
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
        // siteUrl and category are part of the record (and of what the pull maps
        // back into D1), so pushing without them strips them from the PDS — and
        // the next Jetstream mirror of that commit would carry the loss back
        // down. For a linkblog follow siteUrl is the "this is a linkblog" tell.
        siteUrl: localSub.site_url || undefined,
        category: localSub.category || undefined,
        createdAt: new Date(createdAtMs).toISOString(),
        sourceType: localSub.source_type || undefined,
        subjectDid: localSub.subject_did || undefined,
        customTitle: localSub.custom_title || undefined,
        customIconUrl: localSub.custom_icon_url || undefined,
      };

      // Which record on the PDS is this row's counterpart? Normally the one under
      // the same rkey (possibly holding a different feedUrl).
      let existingPdsRecord = pdsByRkey.get(rkey);
      // The rkey this row's write targets. Only differs in the repair case below.
      let targetRkey = rkey;

      // A flagged row whose feed the PDS already holds under a *different* rkey.
      // The usual cause is the bulk-import dedupe, which keeps a local row for a
      // feed another device created. Writing under our own rkey would add a
      // second record for the same feed, so the repair has to land on the record
      // the PDS actually has. Settling instead — as this used to — cleared the
      // flag without paying it: a rename would vanish while the status line said
      // everything was in step, which is the drift the flag exists to end.
      if (!existingPdsRecord) {
        const sameFeedRecord = pdsByKey.get(key);
        const sameFeedRkey = sameFeedRecord ? extractRkey(sameFeedRecord.uri) : undefined;
        if (sameFeedRecord && sameFeedRkey) {
          if (localByRkey.has(sameFeedRkey) || claimedPdsRkeys.has(sameFeedRkey)) {
            // Another local row owns that record and keeps it accurate, so this
            // row really is redundant: settle it and leave the repo untouched.
            settledRkeys.push(rkey);
            continue;
          }
          claimedPdsRkeys.add(sameFeedRkey);
          existingPdsRecord = sameFeedRecord;
          targetRkey = sameFeedRkey;
        }
      }

      if (existingPdsRecord) {
        // Rkey exists - check if it's a no-op (same content)
        const existingValue = existingPdsRecord.value;
        if (
          existingValue.feedUrl === newRecord.feedUrl &&
          (existingValue.title || undefined) === newRecord.title &&
          (existingValue.siteUrl || undefined) === newRecord.siteUrl &&
          (existingValue.category || undefined) === newRecord.category &&
          (existingValue.customTitle || undefined) === newRecord.customTitle &&
          (existingValue.customIconUrl || undefined) === newRecord.customIconUrl
        ) {
          skippedNoOp++;
          if (localSub.pds_dirty === 1) settledRkeys.push(rkey);
          continue;
        }

        // Content differs - use update
        settlesLocalRkey.set(targetRkey, rkey);
        writes.push({
          $type: 'com.atproto.repo.applyWrites#update',
          collection: COLLECTION,
          rkey: targetRkey,
          value: newRecord,
        });
      } else {
        // Rkey doesn't exist - use create
        settlesLocalRkey.set(targetRkey, rkey);
        writes.push({
          $type: 'com.atproto.repo.applyWrites#create',
          collection: COLLECTION,
          rkey: targetRkey,
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
            settledRkeys.push(settlesLocalRkey.get(write.rkey) ?? write.rkey);
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
        for (const write of batch) {
          settledRkeys.push(settlesLocalRkey.get(write.rkey) ?? write.rkey);
        }
        console.log(`[SubscriptionSync] Successfully pushed ${result.pushedToPds} records`);
      }
    }

    if (settledRkeys.length > 0) {
      await clearSubscriptionsDirty(env, session.did, settledRkeys);
      console.log(`[SubscriptionSync] Settled ${settledRkeys.length} pending record(s)`);
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
