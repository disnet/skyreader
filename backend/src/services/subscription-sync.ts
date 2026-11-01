import type { Env, Session } from '../types';
import { feedUrlKey, sameFeedUrl } from './feed-url-key';
import { createPDSClient, type PDSResult, type WriteOp } from './pds-client';
import { getUserTierLimits } from './user-tier';
import { isLocalOnlySubscription } from './local-only-sources';
import { chargeQueries, type QueryLedger } from './document-store';
import { enqueueAuthorBackfills } from './jobs';
import { log } from '../utils/logger';

const COLLECTION = 'app.skyreader.feed.subscription';

/**
 * A pull this size is worth a line in the logs: the insert batch is one query per
 * row against a 1,000-per-invocation ceiling, so a restore of this order is the
 * shape of request that can exhaust it on its own. Nothing here caps it — the mirror
 * cap does, at 1000/5000 rows — but an operator reading a 500 from `/api/sync`
 * should be able to find the reason.
 */
const LARGE_PULL_BATCH = 400;

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
  keep_private: number;
  /** 1 when the reader parked the feed (sticky; sync never promotes it). */
  user_parked?: number;
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
  /** Feeds held twice (at http and https, say) folded into one by this call. */
  mergedDuplicates?: number;
  /** If true, there are more records to push - call sync again */
  hasMore?: boolean;
  /**
   * Set when the PDS host moved (migration) but the existing tokens were
   * rejected by the new host — the user must reconnect their account.
   */
  needsReauth?: boolean;
}

// Build a unique key for deduplication. RSS dedups by feedUrl; AT Proto by
// sourceType + subjectDid + feedUrl, where feedUrl is the publication AT-URI —
// so two publications owned by the same author DID are distinct subscriptions.
function subscriptionKey(feedUrl?: string, sourceType?: string, subjectDid?: string): string {
  if (sourceType && sourceType.startsWith('atproto.') && subjectDid) {
    return `${sourceType}:${subjectDid}:${feedUrl || ''}`;
  }
  return feedUrl ? feedUrlKey(feedUrl) : '';
}

/**
 * The fields Skyreader keeps in D1 for a subscription. On an edit these are
 * authoritative: D1's value is written, and a value D1 no longer has is removed
 * (a hidden linkblog page clears siteUrl, say), exactly as a full rewrite would.
 */
const SKYREADER_OWNED_FIELDS = [
  'feedUrl',
  'title',
  'siteUrl',
  'category',
  'sourceType',
  'subjectDid',
  'customTitle',
  'customIconUrl',
] as const;

/**
 * Skyreader's fields, laid over the record already on the PDS rather than
 * replacing it. The fields Skyreader owns (SKYREADER_OWNED_FIELDS) come from
 * `next`, set or removed. Everything else on the record (fields another
 * Atmospheric app wrote, `source`, `tags`, `collectionNsid` when D1 doesn't
 * know it) and its original `createdAt` survive the edit, and an `updatedAt` it
 * keeps moves to now.
 */
export function mergeSubscriptionRecord(
  existing: Record<string, unknown> | PDSSubscriptionRecord | undefined,
  next: PDSSubscriptionRecord
): PDSSubscriptionRecord {
  if (!existing) return next;
  const merged: Record<string, unknown> = { ...existing };
  const incoming = next as unknown as Record<string, unknown>;
  for (const field of SKYREADER_OWNED_FIELDS) {
    if (incoming[field] !== undefined) merged[field] = incoming[field];
    else delete merged[field];
  }
  if (next.collectionNsid !== undefined) merged.collectionNsid = next.collectionNsid;
  merged.$type = COLLECTION;
  if (typeof merged.createdAt !== 'string') merged.createdAt = next.createdAt;
  // An app that keeps updatedAt may resolve conflicts by it, so an edit here
  // has to move it, or that app would take the record as unchanged.
  if ('updatedAt' in merged) merged.updatedAt = new Date().toISOString();
  return merged as unknown as PDSSubscriptionRecord;
}

type ListedSubscription = { uri: string; value: PDSSubscriptionRecord };

/**
 * Plan the PDS writes that settle `rowsToPush`: a create for a row the PDS
 * doesn't hold, an update (merged onto the record already there, see
 * mergeSubscriptionRecord) for a flagged row, aimed at the record the PDS
 * actually holds for that feed, and a delete for a kept-private row that got
 * published anyway. Shared by the full sync and the edit routes' push, so an
 * edit lands exactly where the sync would put it.
 */
function planPushWrites(
  rowsToPush: LocalSubscription[],
  localByRkey: Map<string, LocalSubscription>,
  pdsByKey: Map<string, ListedSubscription>,
  pdsByRkey: Map<string, ListedSubscription>
): {
  writes: WriteOp[];
  settledRkeys: string[];
  settlesLocalRkey: Map<string, string>;
  skippedNoOp: number;
} {
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
  // Folders the PDS record lacks for clean rows (see the loop), written after it.
  const folderFills: Array<{ rkey: string; value: PDSSubscriptionRecord; folder: string }> = [];

  for (const localSub of rowsToPush) {
    const key = subscriptionKey(
      localSub.feed_url,
      localSub.source_type || undefined,
      localSub.subject_did || undefined
    );
    if (!key) continue;

    // Newsletters and Bluesky likes/bookmarks are private and local-only: never pushed.
    if (isLocalOnlySubscription(localSub.feed_url, localSub.source_type)) continue;
    // Nor is a feed the reader chose to keep off their PDS. If its record is
    // there anyway (a push that raced the choice, or a best-effort delete
    // that failed while sync was off) take it down: the choice only holds if
    // the sync, which runs again and again, enforces it.
    if (localSub.keep_private === 1) {
      const ownRkey = extractRkey(localSub.record_uri);
      const published = (ownRkey && pdsByRkey.get(ownRkey)) || pdsByKey.get(key);
      const publishedRkey = published ? extractRkey(published.uri) : undefined;
      if (
        published &&
        publishedRkey &&
        sameFeedUrl(published.value.feedUrl, localSub.feed_url) &&
        // Another local row owns that record: it's that row's to keep.
        (publishedRkey === ownRkey || !localByRkey.has(publishedRkey))
      ) {
        writes.push({
          $type: 'com.atproto.repo.applyWrites#delete',
          collection: COLLECTION,
          rkey: publishedRkey,
        });
      }
      continue;
    }

    // A subscription that already exists on the PDS is left alone *unless* it
    // carries an unpaid local edit. Its write-through is fire-and-forget, so a
    // rename whose push failed leaves the PDS stale with nothing to repair it;
    // this loop used to `continue` here and never reach the field comparison
    // below, making that drift permanent. Only rows flagged by the mutation
    // routes are reconsidered — the sync never diffs the two sides to guess at
    // intent, and never deletes.
    //
    // One exception: a folder the PDS record lacks. Before the import pushed
    // folders, and wherever another app wrote the record, a feed can sit in a
    // folder here with none on the PDS and no flag to say so. That is a gap,
    // not a disagreement, so the sync fills it, adding only the folder and
    // leaving the rest of that record as it is.
    if (pdsByKey.has(key) && localSub.pds_dirty !== 1) {
      const folder = localSub.category?.trim() ? localSub.category : undefined;
      const ownRkey = extractRkey(localSub.record_uri);
      // The row's own record when it holds this feed, else the one the PDS
      // holds for it, as the keep-private branch above picks.
      const own = ownRkey ? pdsByRkey.get(ownRkey) : undefined;
      const published =
        own && sameFeedUrl(own.value.feedUrl, localSub.feed_url) ? own : pdsByKey.get(key);
      const publishedRkey = published ? extractRkey(published.uri) : undefined;
      if (
        folder &&
        published &&
        publishedRkey &&
        !published.value.category &&
        // Another local row owns that record: its folder is that row's to give.
        (publishedRkey === ownRkey || !localByRkey.has(publishedRkey)) &&
        // The row's own record comes back through the Jetstream mirror, which
        // copies the record's names onto the row. Where they differ (edited
        // while sync was off) the fill would undo the reader's rename, so leave
        // that row alone.
        (publishedRkey !== ownRkey ||
          ((published.value.title || null) === (localSub.title || null) &&
            (published.value.customTitle || null) === (localSub.custom_title || null) &&
            (published.value.customIconUrl || null) === (localSub.custom_icon_url || null)))
      ) {
        folderFills.push({ rkey: publishedRkey, value: published.value, folder });
      }
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
      // Laid over the record only when it holds this same feed: a record under
      // this rkey for another feed has nothing worth keeping, and its leftovers
      // (a linkblog's sourceType, subjectDid, siteUrl) would misdescribe this one.
      // The same feed at an address differing only in scheme or case keeps the
      // record's own address: often the other app's https where ours is http.
      const merged = sameFeedUrl(existingValue.feedUrl, newRecord.feedUrl)
        ? mergeSubscriptionRecord(existingValue, {
            ...newRecord,
            feedUrl: existingValue.feedUrl,
          })
        : newRecord;
      if (
        existingValue.feedUrl === merged.feedUrl &&
        (existingValue.title || undefined) === merged.title &&
        (existingValue.siteUrl || undefined) === merged.siteUrl &&
        (existingValue.category || undefined) === merged.category &&
        (existingValue.customTitle || undefined) === merged.customTitle &&
        (existingValue.customIconUrl || undefined) === merged.customIconUrl
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
        value: merged,
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

  // Folder fills go last, onto records no edit above claimed: an unpaid edit
  // for the same feed owns that record's contents, folder included.
  for (const fill of folderFills) {
    if (claimedPdsRkeys.has(fill.rkey) || writes.some((w) => w.rkey === fill.rkey)) continue;
    claimedPdsRkeys.add(fill.rkey);
    const value: Record<string, unknown> = {
      ...fill.value,
      $type: COLLECTION,
      category: fill.folder,
    };
    if ('updatedAt' in value) value.updatedAt = new Date().toISOString();
    // Settles nothing: the row was clean when read, and an edit made since
    // must keep its flag.
    settlesLocalRkey.set(fill.rkey, '');
    writes.push({
      $type: 'com.atproto.repo.applyWrites#update',
      collection: COLLECTION,
      rkey: fill.rkey,
      value,
    });
  }

  return { writes, settledRkeys, settlesLocalRkey, skippedNoOp };
}

/**
 * One feed held more than once, and how the sync folds it back into one.
 *
 * `keepRow` is the local row that survives (the one in a folder, else the
 * active, else the oldest), re-pointed at `targetRkey`, the record kept on the
 * PDS (the https one, else the oldest). The other rows and records go.
 */
export interface DuplicateFeedMerge {
  keepRow: string;
  /** The PDS record the kept row is re-pointed at, or null when the PDS holds none. */
  targetRkey: string | null;
  /** The feed address the kept row takes on: the kept record's, else its own. */
  feedUrl: string;
  category: string | null;
  siteUrl: string | null;
  customTitle: string | null;
  customIconUrl: string | null;
  active: number;
  /** Parked by the reader: kept when no copy is active and any copy was. */
  userParked: number;
  dropRows: string[];
  dropRkeys: string[];
}

/** Groups merged per sync call; each costs two D1 queries and up to a couple of PDS writes. */
export const MAX_DUPLICATE_MERGES = 25;

function createdAtMs(value?: string): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * Find feeds the reader holds twice, here or on the PDS, under addresses that
 * differ only in scheme or the host's case (see feedUrlKey). Another app importing the
 * same OPML with https where Skyreader had http left one record of each, and
 * the sync, which used to compare raw addresses, pulled the other app's copy
 * in as a second feed.
 *
 * Only RSS feeds are considered, and a feed is left alone when any of its rows
 * is kept private (the reader chose to keep it off the PDS) or when no row
 * holds it here (nothing local says which copy is wanted).
 */
export function planDuplicateFeedMerges(
  localRows: LocalSubscription[],
  pdsRecords: ListedSubscription[]
): DuplicateFeedMerge[] {
  const isRss = (feedUrl: string | undefined, sourceType: string | null | undefined) =>
    !!feedUrl &&
    !sourceType?.startsWith('atproto.') &&
    !isLocalOnlySubscription(feedUrl, sourceType ?? undefined);

  const groups = new Map<string, { rows: LocalSubscription[]; records: ListedSubscription[] }>();
  const group = (key: string) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { rows: [], records: [] }));
    return g;
  };
  for (const row of localRows) {
    if (isRss(row.feed_url, row.source_type)) group(feedUrlKey(row.feed_url)).rows.push(row);
  }
  const rowByRkey = new Map(localRows.map((r) => [extractRkey(r.record_uri), r]));
  for (const rec of pdsRecords) {
    if (!isRss(rec.value.feedUrl, rec.value.sourceType)) continue;
    const key = feedUrlKey(rec.value.feedUrl!);
    // A record a row for another feed still points at is that row's business.
    const owner = rowByRkey.get(extractRkey(rec.uri));
    if (
      owner &&
      !(isRss(owner.feed_url, owner.source_type) && feedUrlKey(owner.feed_url) === key)
    ) {
      continue;
    }
    group(key).records.push(rec);
  }

  const pdsRkeys = new Set(pdsRecords.map((r) => extractRkey(r.uri)));
  const merges: DuplicateFeedMerge[] = [];
  for (const { rows, records } of groups.values()) {
    if (rows.length === 0) continue;
    // One row and one record is a pair too when the row's own record is gone:
    // the import settles a feed against another app's record without writing
    // its own, and a row left on a missing rkey can't be unsubscribed from
    // there (the delete goes by rkey), so the record would come straight back.
    const strandedRow =
      rows.length === 1 && records.length === 1 && !pdsRkeys.has(extractRkey(rows[0].record_uri));
    if (rows.length < 2 && records.length < 2 && !strandedRow) continue;
    if (rows.some((r) => r.keep_private === 1)) continue;
    // Copies at one exact address are an older shape the push already settles
    // (one row owns the record, the rest stand down); only fold copies whose
    // addresses differ, which nothing else reconciles.
    const addresses = new Set([
      ...rows.map((r) => r.feed_url.trim()),
      ...records.map((r) => r.value.feedUrl!.trim()),
    ]);
    if (addresses.size < 2) continue;

    const isHttps = (url?: string) => /^\s*https:\/\//i.test(url || '');
    const target = [...records].sort(
      (a, b) =>
        Number(isHttps(b.value.feedUrl)) - Number(isHttps(a.value.feedUrl)) ||
        createdAtMs(a.value.createdAt) - createdAtMs(b.value.createdAt) ||
        (extractRkey(a.uri) < extractRkey(b.uri) ? -1 : 1)
    )[0];
    const targetRkey = target ? extractRkey(target.uri) : null;

    const hasFolder = (r: LocalSubscription) => (r.category?.trim() ? 1 : 0);
    const ordered = [...rows].sort(
      (a, b) =>
        hasFolder(b) - hasFolder(a) ||
        b.active - a.active ||
        a.created_at - b.created_at ||
        (a.record_uri < b.record_uri ? -1 : 1)
    );
    const keep = ordered[0];

    // A single row already on the kept record, with no other record to drop:
    // nothing to do (planPushWrites handles any edit it owes).
    const dropRkeys = records
      .map((r) => extractRkey(r.uri))
      .filter((rkey) => rkey && rkey !== targetRkey);
    if (rows.length === 1 && dropRkeys.length === 0 && !strandedRow) continue;

    const active = rows.some((r) => r.active === 1) ? 1 : 0;
    const firstOf = (pick: (r: LocalSubscription) => string | null) =>
      ordered.map(pick).find((v) => !!v?.trim()) ?? null;
    merges.push({
      keepRow: keep.record_uri,
      targetRkey,
      feedUrl: target?.value.feedUrl || keep.feed_url,
      // A folder already on the kept record was set elsewhere and stays, as
      // the folder fill leaves it; the reader's folder fills it only when empty.
      category: target?.value.category?.trim() ? target.value.category : firstOf((r) => r.category),
      siteUrl: firstOf((r) => r.site_url) ?? (target?.value.siteUrl || null),
      customTitle: firstOf((r) => r.custom_title),
      customIconUrl: firstOf((r) => r.custom_icon_url),
      active,
      userParked: !active && rows.some((r) => r.user_parked === 1) ? 1 : 0,
      dropRows: ordered.slice(1).map((r) => r.record_uri),
      dropRkeys,
    });
  }
  return merges;
}

// Batch size for applyWrites - 200 is the documented limit but large batches
// can fail with 500 errors, possibly due to request body size. Using 50 as safe default.
export const MAX_BATCH_SIZE = 50;
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
  // An empty rkey marks a write that settles no row (a folder fill).
  const unique = [...new Set(rkeys)].filter(Boolean);
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
    'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ? AND pds_dirty = 1 AND keep_private = 0'
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
  sessionId?: string,
  // This request's subrequest ledger, shared with anything else the invocation runs
  // (`/api/sync` also runs the Atmosphere reconcile). The pull charges its inserts
  // to it so what runs after it is admitted against what the request has actually
  // spent, not against a count alone.
  ledger?: QueryLedger
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
    let sortedPdsRecords = [...pdsRecords].sort((a, b) => {
      const dateA = new Date(a.value.createdAt || 0).getTime();
      const dateB = new Date(b.value.createdAt || 0).getTime();
      return dateA - dateB;
    });

    // Step 2: Fetch all local subscriptions
    const localResult = await env.DB.prepare(
      `SELECT record_uri, feed_url, title, site_url, category, created_at, source_type, subject_did, custom_title, custom_icon_url, active, pds_dirty, keep_private, user_parked
			 FROM subscriptions_cache
			 WHERE user_did = ?`
    )
      .bind(session.did)
      .all<LocalSubscription>();

    let localSubscriptions = localResult.results || [];
    console.log(`[SubscriptionSync] Found ${localSubscriptions.length} local subscriptions`);

    // Step 2b: Fold feeds held twice (http and https, say) back into one. The
    // rows go now, in one batch per feed; the records go with the push below.
    const allMerges = planDuplicateFeedMerges(localSubscriptions, sortedPdsRecords);
    const merges = allMerges.slice(0, MAX_DUPLICATE_MERGES);
    if (allMerges.length > merges.length) result.hasMore = true;
    const mergeDeletes: WriteOp[] = [];
    if (merges.length > 0) {
      const statements = merges.flatMap((m) => {
        const keepUri = m.targetRkey
          ? buildRecordUri(session.did, COLLECTION, m.targetRkey)
          : m.keepRow;
        const drops = m.dropRows.length
          ? [
              env.DB.prepare(
                `DELETE FROM subscriptions_cache WHERE user_did = ? AND record_uri IN (${m.dropRows
                  .map(() => '?')
                  .join(',')})`
              ).bind(session.did, ...m.dropRows),
            ]
          : [];
        return [
          ...drops,
          // Dirty when it now answers to a record, so the push below writes the
          // folder and names onto it (merged, keeping the record's own address).
          env.DB.prepare(
            `UPDATE subscriptions_cache
             SET record_uri = ?, feed_url = ?, category = ?, site_url = ?, custom_title = ?,
                 custom_icon_url = ?, active = ?, user_parked = ?, pds_dirty = ?
             WHERE user_did = ? AND record_uri = ?`
          ).bind(
            keepUri,
            m.feedUrl,
            m.category,
            m.siteUrl,
            m.customTitle,
            m.customIconUrl,
            m.active,
            m.userParked,
            m.targetRkey ? 1 : 0,
            session.did,
            m.keepRow
          ),
        ];
      });
      await env.DB.batch(statements);
      if (ledger) chargeQueries(ledger, statements.length);

      const dropped = new Set(merges.flatMap((m) => m.dropRows));
      const keptBy = new Map(merges.map((m) => [m.keepRow, m]));
      localSubscriptions = localSubscriptions
        .filter((row) => !dropped.has(row.record_uri))
        .map((row) => {
          const m = keptBy.get(row.record_uri);
          if (!m) return row;
          return {
            ...row,
            record_uri: m.targetRkey
              ? buildRecordUri(session.did, COLLECTION, m.targetRkey)
              : row.record_uri,
            feed_url: m.feedUrl,
            category: m.category,
            site_url: m.siteUrl,
            custom_title: m.customTitle,
            custom_icon_url: m.customIconUrl,
            active: m.active,
            user_parked: m.userParked,
            pds_dirty: m.targetRkey ? 1 : row.pds_dirty,
          };
        });
      const droppedRkeys = new Set(merges.flatMap((m) => m.dropRkeys));
      for (const rkey of droppedRkeys) {
        mergeDeletes.push({
          $type: 'com.atproto.repo.applyWrites#delete',
          collection: COLLECTION,
          rkey,
        });
      }
      sortedPdsRecords = sortedPdsRecords.filter((r) => !droppedRkeys.has(extractRkey(r.uri)));
      // Feeds the reader saw twice. A merge that only retries a record delete
      // was counted when its rows were merged.
      const merged = merges.filter((m) => m.dropRows.length > 0).length;
      if (merged > 0) result.mergedDuplicates = merged;
      console.log(`[SubscriptionSync] Merged ${merges.length} duplicated feed(s)`);
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

    const pulledKeys = new Set<string>();
    for (const pdsRecord of sortedPdsRecords) {
      const key = subscriptionKey(
        pdsRecord.value.feedUrl,
        pdsRecord.value.sourceType,
        pdsRecord.value.subjectDid
      );
      if (!key) continue;

      // A record naming a newsletter or Bluesky likes/bookmarks feed is never
      // ours to mirror: those are local-only, and one arriving from a PDS could
      // name another reader's inbox or bookmarks (services/local-only-sources.ts).
      if (isLocalOnlySubscription(pdsRecord.value.feedUrl, pdsRecord.value.sourceType)) continue;

      // Already have this subscription locally — leave its active state untouched
      // (never silently demote something the reader is already showing).
      if (localByKey.has(key)) continue;
      // Nor pull a feed twice: the PDS can hold it at http and at https, and
      // with no row here yet both would land (the next sync folds the records).
      if (pulledKeys.has(key)) continue;
      pulledKeys.add(key);

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
      // Each statement in the batch is its own query against the invocation's
      // ceiling. This is the term that dwarfs everything else in a restore, and it
      // is still unbounded here (the mirror cap, 1000/5000 rows, is the only limit):
      // charging it is what stops the walks below from being scheduled on top of an
      // invocation that has already spent its budget. See `backend/CLAUDE.md`.
      if (ledger) chargeQueries(ledger, statements.length);
      if (statements.length > LARGE_PULL_BATCH) {
        log.warn('subscription_pull_batch_large', {
          inserted: statements.length,
          userDid: session.did,
        });
      }
      result.pulledFromPds = toAddLocally.length;
      console.log(`[SubscriptionSync] Successfully inserted ${toAddLocally.length} subscriptions`);

      // A restored `atproto.documents` row needs the author's back catalogue like
      // any other new subscription: documents are served from D1, so an author
      // nobody has listed serves `status:'error'` on every poll. This is the
      // restore-from-the-Atmosphere case — the PDS records survive, the local rows
      // don't — and it can pull in far more rows at once than a subscribe does,
      // so each walk is its own queued job rather than this request's work.
      await enqueueAuthorBackfills(
        env,
        toAddLocally.flatMap((sub) =>
          sub.sourceType?.startsWith('atproto.') && sub.subjectDid ? [sub.subjectDid] : []
        )
      );
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
        if (ledger) chargeQueries(ledger, toPromote.length);
        result.reactivated = toPromote.length;
        console.log(`[SubscriptionSync] Reactivated ${toPromote.length} parked subscription(s)`);
      }
    }

    // Step 4: Push to PDS - add local records that don't exist in PDS (by feedUrl)
    const {
      writes: pushWrites,
      settledRkeys,
      settlesLocalRkey,
      skippedNoOp,
    } = planPushWrites(localSubscriptions, localByRkey, pdsByKey, pdsByRkey);

    // The merges' deletes go last: a capped batch that leaves one behind sets
    // hasMore, and the next call plans it again (the record is still there).
    const writes = [...pushWrites, ...mergeDeletes];

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

/**
 * Push the flagged rows among `rkeys` to the PDS, the way the full sync would:
 * merged onto the record already there (so other apps' fields and the original
 * createdAt survive) and aimed at the record the PDS actually holds for that
 * feed, which isn't always the one under the row's own rkey. The edit routes
 * use this instead of a blind putRecord per row, which replaced the whole record
 * and, where the rkeys differed, wrote a second record for the same feed.
 *
 * Background and best-effort: anything that doesn't land keeps its flag, and
 * the next sync settles it.
 */
export async function pushDirtySubscriptions(
  session: Session,
  env: Env,
  rkeys: string[]
): Promise<void> {
  if (rkeys.length === 0) return;
  const pdsClient = createPDSClient(session);
  try {
    const listed = await pdsClient.listAllRecords<PDSSubscriptionRecord>(COLLECTION, {
      maxPages: MAX_LIST_PAGES,
    });
    if (!listed.success) {
      console.error(`[SubscriptionSync] Edit push could not list the PDS: ${listed.error}`);
      return;
    }
    const pdsByKey = new Map<string, ListedSubscription>();
    const pdsByRkey = new Map<string, ListedSubscription>();
    // Oldest first, as the full sync orders them, so where the PDS holds two
    // records for one feed this lands on the same one the sync would.
    const sorted = [...listed.data].sort(
      (a, b) =>
        new Date(a.value.createdAt || 0).getTime() - new Date(b.value.createdAt || 0).getTime()
    );
    for (const record of sorted) {
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

    const local = await env.DB.prepare(
      `SELECT record_uri, feed_url, title, site_url, category, created_at, source_type, subject_did, custom_title, custom_icon_url, active, pds_dirty, keep_private
       FROM subscriptions_cache
       WHERE user_did = ?`
    )
      .bind(session.did)
      .all<LocalSubscription>();
    const localByRkey = new Map<string, LocalSubscription>();
    for (const row of local.results || []) {
      const rkey = extractRkey(row.record_uri);
      if (rkey) localByRkey.set(rkey, row);
    }

    const wanted = new Set(rkeys);
    const rowsToPush = [...localByRkey.entries()]
      .filter(([rkey, row]) => wanted.has(rkey) && row.pds_dirty === 1)
      .map(([, row]) => row);
    const { writes, settledRkeys, settlesLocalRkey } = planPushWrites(
      rowsToPush,
      localByRkey,
      pdsByKey,
      pdsByRkey
    );

    for (let i = 0; i < writes.length; i += MAX_BATCH_SIZE) {
      const batch = writes.slice(i, i + MAX_BATCH_SIZE);
      const result = await pdsClient.applyWrites(batch);
      if (result.success) {
        for (const write of batch)
          settledRkeys.push(settlesLocalRkey.get(write.rkey) ?? write.rkey);
        continue;
      }
      // One bad write fails the whole applyWrites. Retry each on its own so it
      // can't hold back the rest: a put also lands a "create" whose record a
      // truncated listing missed.
      console.error(`[SubscriptionSync] Edit push failed, retrying one by one: ${result.error}`);
      for (const write of batch) {
        const single =
          write.$type === 'com.atproto.repo.applyWrites#delete'
            ? await pdsClient.deleteRecord(COLLECTION, write.rkey)
            : await pdsClient.putRecord(COLLECTION, write.rkey, write.value);
        if (single.success) {
          settledRkeys.push(settlesLocalRkey.get(write.rkey) ?? write.rkey);
        }
      }
    }
    if (settledRkeys.length > 0) {
      await clearSubscriptionsDirty(env, session.did, settledRkeys);
    }
  } catch (error) {
    console.error('[SubscriptionSync] Edit push error:', error);
  }
}
