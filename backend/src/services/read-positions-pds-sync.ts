import type { Env } from '../types';
import { importPrivateKey, createDPoPProof } from './oauth';

interface UnsyncedPosition {
  id: number;
  user_did: string;
  rkey: string;
  item_guid: string;
  item_url: string | null;
  item_title: string | null;
  starred: number;
  read_at: number;
}

interface UserSession {
  did: string;
  pds_url: string;
  access_token: string;
  dpop_private_key: string;
}

interface PdsResponse {
  uri?: string;
  cid?: string;
  error?: string;
  message?: string;
}

const COLLECTION = 'app.skyreader.feed.readPosition';
const BATCH_SIZE = 50; // Max records to sync per user per run
const MAX_USERS_PER_RUN = 10; // Limit users per cron run to avoid timeout

/**
 * Syncs unsynced read positions from D1 to users' PDS.
 * Called by the cron job.
 */
export async function syncReadPositionsToPds(env: Env): Promise<{
  synced: number;
  errors: number;
  users: number;
}> {
  const timings: Record<string, number> = {};
  const startTime = Date.now();
  let synced = 0;
  let errors = 0;
  let usersProcessed = 0;
  let usersSkipped = 0;

  // Accumulated timing categories
  let totalSessionLookup = 0;
  let totalPositionsQuery = 0;
  let totalPdsRequests = 0;
  let totalDbWrites = 0;

  try {
    // Find users with unsynced read positions
    let queryStart = Date.now();
    const usersWithUnsynced = await env.DB.prepare(`
      SELECT DISTINCT user_did
      FROM read_positions_cache
      WHERE synced_at IS NULL
      LIMIT ?
    `).bind(MAX_USERS_PER_RUN).all<{ user_did: string }>();
    timings.usersQuery = Date.now() - queryStart;
    timings.usersFound = usersWithUnsynced.results.length;

    for (const { user_did } of usersWithUnsynced.results) {
      // Get user's session (need access token and DPoP key)
      queryStart = Date.now();
      const session = await env.DB.prepare(`
        SELECT did, pds_url, access_token, dpop_private_key
        FROM sessions
        WHERE did = ? AND expires_at > ?
        ORDER BY expires_at DESC
        LIMIT 1
      `).bind(user_did, Date.now()).first<UserSession>();
      totalSessionLookup += Date.now() - queryStart;

      if (!session) {
        // User has no valid session - skip their records
        // They'll sync when they log in again
        usersSkipped++;
        continue;
      }

      usersProcessed++;

      // Get unsynced positions for this user
      queryStart = Date.now();
      const unsyncedPositions = await env.DB.prepare(`
        SELECT id, user_did, rkey, item_guid, item_url, item_title, starred, read_at
        FROM read_positions_cache
        WHERE user_did = ? AND synced_at IS NULL
        ORDER BY read_at ASC
        LIMIT ?
      `).bind(user_did, BATCH_SIZE).all<UnsyncedPosition>();
      totalPositionsQuery += Date.now() - queryStart;

      // Sync each position to PDS
      for (const position of unsyncedPositions.results) {
        try {
          const pdsStart = Date.now();
          const result = await syncPositionToPds(session, position);
          totalPdsRequests += Date.now() - pdsStart;

          if (result.success) {
            // Mark as synced in D1
            const dbStart = Date.now();
            await env.DB.prepare(`
              UPDATE read_positions_cache
              SET record_uri = ?, synced_at = unixepoch()
              WHERE id = ?
            `).bind(result.uri, position.id).run();
            totalDbWrites += Date.now() - dbStart;
            synced++;
          } else {
            errors++;
            console.error(`[PDSSync] Failed to sync position ${position.rkey} for ${user_did}:`, result.error);
          }
        } catch (error) {
          errors++;
          console.error(`[PDSSync] Error syncing position ${position.rkey}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('[PDSSync] Error in syncReadPositionsToPds:', error);
  }

  timings.sessionLookup = totalSessionLookup;
  timings.positionsQuery = totalPositionsQuery;
  timings.pdsRequests = totalPdsRequests;
  timings.dbWrites = totalDbWrites;
  timings.total = Date.now() - startTime;
  timings.synced = synced;
  timings.errors = errors;
  timings.usersProcessed = usersProcessed;
  timings.usersSkipped = usersSkipped;

  console.log(`[PDSSync] Complete: timings=${JSON.stringify(timings)}`);

  return { synced, errors, users: usersProcessed };
}

async function syncPositionToPds(
  session: UserSession,
  position: UnsyncedPosition
): Promise<{ success: boolean; uri?: string; error?: string }> {
  const record = {
    $type: COLLECTION,
    itemGuid: position.item_guid,
    readAt: new Date(position.read_at).toISOString(),
    starred: position.starred === 1,
    ...(position.item_url && { itemUrl: position.item_url }),
    ...(position.item_title && { itemTitle: position.item_title }),
  };

  const requestBody = {
    repo: session.did,
    collection: COLLECTION,
    rkey: position.rkey,
    record,
  };

  const result = await makePdsRequest(session, 'com.atproto.repo.putRecord', requestBody);

  if (result.ok) {
    return {
      success: true,
      uri: result.data.uri || `at://${session.did}/${COLLECTION}/${position.rkey}`,
    };
  }

  return {
    success: false,
    error: result.data.error || result.data.message || 'Unknown error',
  };
}

async function makePdsRequest(
  session: UserSession,
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; data: PdsResponse; status: number }> {
  const privateKeyJwk = JSON.parse(session.dpop_private_key);
  const privateKey = await importPrivateKey(privateKeyJwk);
  const publicKeyJwk = { ...privateKeyJwk };
  delete publicKeyJwk.d;

  const url = `${session.pds_url}/xrpc/${endpoint}`;
  let nonce: string | undefined;

  // Retry up to 2 times for nonce errors
  for (let attempt = 0; attempt < 2; attempt++) {
    const dpopProof = await createDPoPProof(
      privateKey,
      publicKeyJwk,
      'POST',
      url,
      nonce,
      session.access_token
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `DPoP ${session.access_token}`,
        DPoP: dpopProof,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as PdsResponse;

    // Handle use_dpop_nonce error
    if (data.error === 'use_dpop_nonce') {
      nonce = response.headers.get('dpop-nonce') || response.headers.get('DPoP-Nonce') || undefined;
      if (nonce) {
        continue;
      }
    }

    return { ok: response.ok, data, status: response.status };
  }

  return { ok: false, data: { error: 'Failed after nonce retry' }, status: 400 };
}

/**
 * Sync deleted read positions to PDS.
 * This handles the case where a user marks something as unread.
 */
export async function syncDeletedReadPositionsToPds(env: Env): Promise<{
  deleted: number;
  errors: number;
}> {
  // For now, we don't track deleted positions separately.
  // When a user marks as unread, we delete from D1 but don't sync to PDS.
  // This is acceptable because:
  // 1. PDS has the "eventually consistent" view
  // 2. D1 is the source of truth for the app
  // 3. Next time user logs in from PDS, we can handle conflicts
  return { deleted: 0, errors: 0 };
}
