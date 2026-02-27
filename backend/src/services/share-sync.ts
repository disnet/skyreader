import type { Env, Session } from '../types';
import { createPDSClient, type PDSResult, type PutRecordResponse } from './pds-client';

const COLLECTION = 'app.skyreader.social.share';

/**
 * PDS share record schema
 */
interface PDSShareRecord {
  $type?: string;
  itemUrl: string;
  createdAt: string;
  feedUrl?: string;
  itemTitle?: string;
  itemAuthor?: string;
  itemDescription?: string;
  content?: string;
  itemImage?: string;
  itemGuid?: string;
  itemPublishedAt?: string;
  note?: string;
  tags?: string[];
  reshareOf?: {
    uri: string;
    authorDid: string;
  };
}

/**
 * Local share row from D1
 */
interface LocalShare {
  record_uri: string;
  record_cid: string;
  feed_url: string | null;
  item_url: string;
  item_title: string | null;
  item_author: string | null;
  item_description: string | null;
  content: string | null;
  item_image: string | null;
  item_guid: string | null;
  item_published_at: number | null;
  note: string | null;
  tags: string | null;
  created_at: number;
  reshare_of_uri: string | null;
  reshare_of_author_did: string | null;
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
  warnings: string[];
  /** If true, there are more records to push - call sync again */
  hasMore?: boolean;
}

// Batch size for applyWrites - 200 is the documented limit but share records
// contain lots of data (descriptions, content, images) so the request body can
// exceed size limits. Using 10 to stay well under the limit.
const MAX_BATCH_SIZE = 10;
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
 * Sync shares between local D1 cache and user's PDS
 *
 * Pull and Merge Algorithm:
 * 1. Fetch all from PDS (with pagination)
 * 2. Fetch all from local D1 shares
 * 3. For each PDS record not in local: add to D1
 * 4. For each local record not in PDS: push to PDS
 * 5. For conflicts: merge by itemUrl (unique identifier)
 */
export async function syncShares(session: Session, env: Env): Promise<SyncResult> {
  const result: SyncResult = {
    success: true,
    pulledFromPds: 0,
    pushedToPds: 0,
    skipped: 0,
    warnings: [],
  };

  const pdsClient = createPDSClient(session);

  try {
    // Step 1: Fetch records from PDS (limited to avoid subrequest limit)
    console.log('[ShareSync] Fetching records from PDS...');
    const pdsResult = await pdsClient.listAllRecords<PDSShareRecord>(COLLECTION, {
      maxPages: MAX_LIST_PAGES,
    });
    if (!pdsResult.success) {
      console.error('[ShareSync] Failed to fetch from PDS:', pdsResult.error);
      return {
        ...result,
        success: false,
        error: `Failed to fetch from PDS: ${pdsResult.error}`,
      };
    }

    const pdsRecords = pdsResult.data;
    console.log(`[ShareSync] Found ${pdsRecords.length} records in PDS`);

    // Step 2: Fetch all local shares for this user
    const localResult = await env.DB.prepare(
      `SELECT record_uri, record_cid, feed_url, item_url, item_title,
			        item_author, item_description, content, item_image, item_guid,
			        item_published_at, note, tags, created_at,
			        reshare_of_uri, reshare_of_author_did
			 FROM shares
			 WHERE author_did = ?`
    )
      .bind(session.did)
      .all<LocalShare>();

    const localShares = localResult.results || [];
    console.log(`[ShareSync] Found ${localShares.length} local shares`);

    // Create lookup maps by itemUrl (unique identifier for shares)
    const pdsByItemUrl = new Map<string, (typeof pdsRecords)[0]>();
    for (const record of pdsRecords) {
      if (record.value.itemUrl) {
        pdsByItemUrl.set(record.value.itemUrl, record);
      }
    }

    const localByItemUrl = new Map<string, LocalShare>();
    for (const share of localShares) {
      localByItemUrl.set(share.item_url, share);
    }

    // Step 3: Pull from PDS - add records that don't exist locally
    const toAddLocally: Array<{
      uri: string;
      cid: string;
      record: PDSShareRecord;
    }> = [];

    for (const pdsRecord of pdsRecords) {
      const itemUrl = pdsRecord.value.itemUrl;
      if (!itemUrl) continue;

      // Check if we already have this share locally (by itemUrl)
      if (!localByItemUrl.has(itemUrl)) {
        toAddLocally.push({
          uri: pdsRecord.uri,
          cid: pdsRecord.cid,
          record: pdsRecord.value,
        });
      }
    }

    // Insert pulled records into local D1
    console.log(`[ShareSync] Will add ${toAddLocally.length} shares from PDS to local`);
    if (toAddLocally.length > 0) {
      // Ensure user exists in users table
      await env.DB.prepare(
        `INSERT INTO users (did, handle, display_name, avatar_url, pds_url, updated_at)
				 VALUES (?, ?, ?, ?, ?, unixepoch())
				 ON CONFLICT(did) DO UPDATE SET
				   handle = excluded.handle,
				   display_name = COALESCE(excluded.display_name, users.display_name),
				   avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
				   updated_at = unixepoch()`
      )
        .bind(
          session.did,
          session.handle || session.did,
          session.displayName || null,
          session.avatarUrl || null,
          session.pdsUrl
        )
        .run();

      const statements = toAddLocally.map((item) => {
        const record = item.record;
        const createdAt = record.createdAt ? new Date(record.createdAt).getTime() : Date.now();
        const itemPublishedAt = record.itemPublishedAt
          ? new Date(record.itemPublishedAt).getTime()
          : null;

        return env.DB.prepare(
          `INSERT OR IGNORE INTO shares
					 (author_did, record_uri, record_cid, feed_url, item_url, item_title,
					  item_author, item_description, content, item_image, item_guid,
					  item_published_at, note, tags, created_at,
					  reshare_of_uri, reshare_of_author_did, reshare_count)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        ).bind(
          session.did,
          item.uri,
          item.cid,
          record.feedUrl || null,
          record.itemUrl,
          record.itemTitle || null,
          record.itemAuthor || null,
          record.itemDescription || null,
          record.content || null,
          record.itemImage || null,
          record.itemGuid || null,
          itemPublishedAt,
          record.note || null,
          record.tags ? JSON.stringify(record.tags) : null,
          createdAt,
          record.reshareOf?.uri || null,
          record.reshareOf?.authorDid || null
        );
      });

      await env.DB.batch(statements);
      result.pulledFromPds = toAddLocally.length;
      console.log(`[ShareSync] Successfully inserted ${toAddLocally.length} shares`);
    }

    // Step 4: Push to PDS - add local records that don't exist in PDS
    const toPushToPds: LocalShare[] = [];

    for (const localShare of localShares) {
      // Check if this share exists in PDS (by itemUrl)
      if (!pdsByItemUrl.has(localShare.item_url)) {
        toPushToPds.push(localShare);
      }
    }

    // Push records to PDS using batch writes (single subrequest for many records)
    // Track URI updates for records pushed to PDS
    const uriUpdates: Array<{ oldUri: string; newUri: string; newCid: string }> = [];

    if (toPushToPds.length > 0) {
      // Limit batch size
      const batch = toPushToPds.slice(0, MAX_BATCH_SIZE);
      if (toPushToPds.length > MAX_BATCH_SIZE) {
        result.hasMore = true;
        console.log(
          `[ShareSync] Batch limit reached, ${toPushToPds.length - MAX_BATCH_SIZE} remaining`
        );
      }

      // Build records to push, keeping track of which ones need URI updates
      const recordsToPush: Array<{
        collection: string;
        rkey: string;
        record: PDSShareRecord;
        originalUri: string;
      }> = [];

      for (const localShare of batch) {
        const rkey = extractRkey(localShare.record_uri);
        if (!rkey) continue;

        recordsToPush.push({
          collection: COLLECTION,
          rkey,
          record: {
            $type: COLLECTION,
            itemUrl: localShare.item_url,
            createdAt: new Date(localShare.created_at).toISOString(),
            feedUrl: localShare.feed_url || undefined,
            itemTitle: localShare.item_title || undefined,
            itemAuthor: localShare.item_author || undefined,
            itemDescription: localShare.item_description || undefined,
            content: localShare.content || undefined,
            itemImage: localShare.item_image || undefined,
            itemGuid: localShare.item_guid || undefined,
            itemPublishedAt: localShare.item_published_at
              ? new Date(localShare.item_published_at).toISOString()
              : undefined,
            note: localShare.note || undefined,
            tags: localShare.tags ? JSON.parse(localShare.tags) : undefined,
            reshareOf:
              localShare.reshare_of_uri && localShare.reshare_of_author_did
                ? {
                    uri: localShare.reshare_of_uri,
                    authorDid: localShare.reshare_of_author_did,
                  }
                : undefined,
          },
          originalUri: localShare.record_uri,
        });
      }

      if (recordsToPush.length > 0) {
        console.log(`[ShareSync] Batch pushing ${recordsToPush.length} records to PDS...`);
        const batchResult = await pdsClient.putRecordsBatch(
          recordsToPush.map((r) => ({
            collection: r.collection,
            rkey: r.rkey,
            record: r.record,
          }))
        );

        if (!batchResult.success) {
          console.error('[ShareSync] Batch push failed:', batchResult.error);
          result.warnings.push(`Batch push failed: ${batchResult.error}`);
        } else {
          result.pushedToPds = batchResult.data.length;
          console.log(`[ShareSync] Successfully pushed ${result.pushedToPds} records`);

          // Track URI updates for records pushed to PDS (update CID)
          for (let i = 0; i < batchResult.data.length; i++) {
            const originalUri = recordsToPush[i].originalUri;
            if (batchResult.data[i].cid) {
              uriUpdates.push({
                oldUri: originalUri,
                newUri: batchResult.data[i].uri,
                newCid: batchResult.data[i].cid,
              });
            }
          }
        }
      }
    }

    // Update CIDs for records that were pushed to PDS
    if (uriUpdates.length > 0) {
      console.log(`[ShareSync] Updating ${uriUpdates.length} record CIDs from PDS`);
      const updateStatements = uriUpdates.map((update) =>
        env.DB.prepare(
          `UPDATE shares SET record_uri = ?, record_cid = ? WHERE record_uri = ?`
        ).bind(update.newUri, update.newCid, update.oldUri)
      );
      await env.DB.batch(updateStatements);
    }

    return result;
  } catch (error) {
    console.error('Share sync error:', error);
    return {
      ...result,
      success: false,
      error: error instanceof Error ? error.message : 'Sync failed',
    };
  }
}

/**
 * Push a single share to PDS (for use with waitUntil on create)
 * Returns the URI and CID from PDS
 */
export async function pushShareToPds(
  session: Session,
  rkey: string,
  shareData: {
    itemUrl: string;
    feedUrl?: string;
    itemGuid?: string;
    itemTitle?: string;
    itemAuthor?: string;
    itemDescription?: string;
    content?: string;
    itemImage?: string;
    itemPublishedAt?: string;
    note?: string;
    tags?: string[];
    reshareOf?: {
      uri: string;
      authorDid: string;
    };
  }
): Promise<PDSResult<PutRecordResponse>> {
  const pdsClient = createPDSClient(session);

  const record: PDSShareRecord = {
    $type: COLLECTION,
    itemUrl: shareData.itemUrl,
    createdAt: new Date().toISOString(),
    feedUrl: shareData.feedUrl,
    itemTitle: shareData.itemTitle,
    itemAuthor: shareData.itemAuthor,
    itemDescription: shareData.itemDescription,
    content: shareData.content,
    itemImage: shareData.itemImage,
    itemGuid: shareData.itemGuid,
    itemPublishedAt: shareData.itemPublishedAt,
    note: shareData.note,
    tags: shareData.tags,
    reshareOf: shareData.reshareOf,
  };

  return pdsClient.putRecord(COLLECTION, rkey, record);
}

/**
 * Delete a share from PDS (for use with waitUntil on delete)
 */
export async function deleteShareFromPds(session: Session, rkey: string): Promise<PDSResult<void>> {
  const pdsClient = createPDSClient(session);
  return pdsClient.deleteRecord(COLLECTION, rkey);
}
