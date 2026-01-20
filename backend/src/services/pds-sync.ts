import type { Env, Session } from '../types';
import { importPrivateKey, createDPoPProof } from './oauth';

interface UnsyncedPosition {
  id: number;
  rkey: string;
  item_guid: string;
  item_url: string | null;
  item_title: string | null;
  starred: number;
  read_at: number;
}

interface PdsResponse {
  uri?: string;
  cid?: string;
  error?: string;
  message?: string;
}

const COLLECTION = 'app.skyreader.feed.readPosition';
const BATCH_SIZE = 25; // Max records to sync per run (kept low to stay under subrequest limits)

interface ApplyWritesResponse {
  results?: Array<{
    uri?: string;
    cid?: string;
    validationStatus?: string;
  }>;
  error?: string;
  message?: string;
}

/**
 * Syncs unsynced read positions from D1 to the user's PDS.
 * Called on user login to ensure data portability.
 * Uses batched applyWrites to avoid exceeding Cloudflare's 50 subrequest limit.
 */
export async function syncReadPositionsForUser(
  env: Env,
  session: Session
): Promise<{ synced: number; errors: number }> {
  try {
    // Get unsynced positions for this user
    const unsyncedPositions = await env.DB.prepare(`
      SELECT id, rkey, item_guid, item_url, item_title, starred, read_at
      FROM read_positions_cache
      WHERE user_did = ? AND synced_at IS NULL
      ORDER BY read_at ASC
      LIMIT ?
    `).bind(session.did, BATCH_SIZE).all<UnsyncedPosition>();

    if (unsyncedPositions.results.length === 0) {
      return { synced: 0, errors: 0 };
    }

    const positions = unsyncedPositions.results;

    // Build batched applyWrites request
    const writes = positions.map(position => ({
      $type: 'com.atproto.repo.applyWrites#create',
      collection: COLLECTION,
      rkey: position.rkey,
      value: {
        $type: COLLECTION,
        itemGuid: position.item_guid,
        readAt: new Date(position.read_at).toISOString(),
        starred: position.starred === 1,
        ...(position.item_url && { itemUrl: position.item_url }),
        ...(position.item_title && { itemTitle: position.item_title }),
      },
    }));

    const result = await makePdsRequest(session, 'com.atproto.repo.applyWrites', {
      repo: session.did,
      writes,
    });

    if (!result.ok) {
      console.error('[PDSSync] Batch sync failed:', result.data);
      return { synced: 0, errors: positions.length };
    }

    const applyResult = result.data as unknown as ApplyWritesResponse;

    // Batch update D1 records with sync results
    const updateStatements = positions.map((position, i) => {
      const recordUri = applyResult.results?.[i]?.uri ||
        `at://${session.did}/${COLLECTION}/${position.rkey}`;
      return env.DB.prepare(`
        UPDATE read_positions_cache
        SET record_uri = ?, synced_at = unixepoch()
        WHERE id = ?
      `).bind(recordUri, position.id);
    });

    await env.DB.batch(updateStatements);

    console.log(`[PDSSync] Synced ${positions.length} read positions for ${session.did}`);
    return { synced: positions.length, errors: 0 };
  } catch (error) {
    console.error('[PDSSync] Error in syncReadPositionsForUser:', error);
    return { synced: 0, errors: 0 };
  }
}

async function makePdsRequest(
  session: Session,
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; data: PdsResponse; status: number }> {
  const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
  const privateKey = await importPrivateKey(privateKeyJwk);
  const publicKeyJwk = { ...privateKeyJwk };
  delete publicKeyJwk.d;

  const url = `${session.pdsUrl}/xrpc/${endpoint}`;
  let nonce: string | undefined;

  // Retry up to 2 times for nonce errors
  for (let attempt = 0; attempt < 2; attempt++) {
    const dpopProof = await createDPoPProof(
      privateKey,
      publicKeyJwk,
      'POST',
      url,
      nonce,
      session.accessToken
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `DPoP ${session.accessToken}`,
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
