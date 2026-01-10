import type { Env } from '../types';
import { getSessionFromRequest, importPrivateKey, createDPoPProof } from '../services/oauth';

const ALLOWED_COLLECTIONS = [
  'com.at-rss.feed.subscription',
  'com.at-rss.feed.readPosition',
  'com.at-rss.social.share',
];

interface RecordSyncRequest {
  operation: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  record?: Record<string, unknown>;
}

interface PdsResponse {
  uri?: string;
  cid?: string;
  error?: string;
  message?: string;
}

async function makePdsRequest(
  session: { pdsUrl: string; accessToken: string; dpopPrivateKey: string },
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

    // Handle use_dpop_nonce error (PDS returns 401 for this)
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

async function makePdsGetRequest<T>(
  session: { pdsUrl: string; accessToken: string; dpopPrivateKey: string },
  endpoint: string,
  params: Record<string, string>
): Promise<{ ok: boolean; data: T; status: number }> {
  const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
  const privateKey = await importPrivateKey(privateKeyJwk);
  const publicKeyJwk = { ...privateKeyJwk };
  delete publicKeyJwk.d;

  const queryString = new URLSearchParams(params).toString();
  const url = `${session.pdsUrl}/xrpc/${endpoint}?${queryString}`;
  let nonce: string | undefined;

  // Retry up to 2 times for nonce errors
  for (let attempt = 0; attempt < 2; attempt++) {
    const dpopProof = await createDPoPProof(
      privateKey,
      publicKeyJwk,
      'GET',
      url,
      nonce,
      session.accessToken
    );

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `DPoP ${session.accessToken}`,
        DPoP: dpopProof,
      },
    });

    const data = await response.json() as T & { error?: string };

    // Handle use_dpop_nonce error
    if (data.error === 'use_dpop_nonce') {
      nonce = response.headers.get('dpop-nonce') || response.headers.get('DPoP-Nonce') || undefined;
      if (nonce) {
        continue;
      }
    }

    return { ok: response.ok, data, status: response.status };
  }

  return { ok: false, data: { error: 'Failed after nonce retry' } as T, status: 400 };
}

interface ReadPositionRecord {
  itemGuid: string;
  itemUrl?: string;
  itemTitle?: string;
  starred?: boolean;
  readAt: string;
}

interface CachedReadPosition {
  id: number;
  user_did: string;
  rkey: string;
  record_uri: string | null;
  item_guid: string;
  synced_at: number | null;
}

// Track which users have had their cache hydrated (in-memory, per-isolate)
const hydratedUsers = new Set<string>();

async function hydrateReadPositionsCacheFromPds(
  env: Env,
  session: { did: string; pdsUrl: string; accessToken: string; dpopPrivateKey: string }
): Promise<void> {
  // Check if we've already hydrated for this user in this isolate
  if (hydratedUsers.has(session.did)) {
    return;
  }

  // Check if user has any cached records - if so, assume cache is valid
  const existingCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM read_positions_cache WHERE user_did = ?'
  ).bind(session.did).first<{ count: number }>();

  if (existingCount && existingCount.count > 0) {
    hydratedUsers.add(session.did);
    return;
  }

  // No cache exists - fetch from PDS and populate
  console.log(`Hydrating read positions cache for ${session.did} from PDS`);

  try {
    const allRecords: Array<{ uri: string; cid: string; value: ReadPositionRecord }> = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, string> = {
        repo: session.did,
        collection: 'com.at-rss.feed.readPosition',
        limit: '100',
      };
      if (cursor) {
        params.cursor = cursor;
      }

      const result = await makePdsGetRequest<{
        records: Array<{ uri: string; cid: string; value: ReadPositionRecord }>;
        cursor?: string;
      }>(session, 'com.atproto.repo.listRecords', params);

      if (!result.ok) {
        console.error('Failed to fetch read positions from PDS:', result.data);
        break;
      }

      allRecords.push(...result.data.records);
      cursor = result.data.cursor;
    } while (cursor);

    // Insert all records into cache
    for (const record of allRecords) {
      // Extract rkey from URI: at://did/collection/rkey
      const rkey = record.uri.split('/').pop();
      if (!rkey) continue;

      try {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO read_positions_cache
          (user_did, rkey, record_uri, item_guid, item_url, item_title, starred, read_at, synced_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).bind(
          session.did,
          rkey,
          record.uri,
          record.value.itemGuid,
          record.value.itemUrl || null,
          record.value.itemTitle || null,
          record.value.starred ? 1 : 0,
          record.value.readAt
        ).run();
      } catch (err) {
        // Ignore insert errors (e.g., duplicates)
        console.error('Failed to insert cached read position:', err);
      }
    }

    console.log(`Hydrated ${allRecords.length} read positions for ${session.did}`);
    hydratedUsers.add(session.did);
  } catch (error) {
    console.error('Error hydrating read positions cache:', error);
    // Don't throw - allow operation to continue, cache will be built up over time
  }
}

async function handleReadPositionSync(
  env: Env,
  session: { did: string; pdsUrl: string; accessToken: string; dpopPrivateKey: string },
  operation: 'create' | 'update' | 'delete',
  rkey: string,
  record?: Record<string, unknown>
): Promise<Response> {
  const collection = 'com.at-rss.feed.readPosition';

  // Ensure cache is hydrated from PDS before checking
  await hydrateReadPositionsCacheFromPds(env, session);

  if (operation === 'delete') {
    // For delete, remove from cache and PDS
    const result = await makePdsRequest(session, 'com.atproto.repo.deleteRecord', {
      repo: session.did,
      collection,
      rkey,
    });

    // Remove from cache regardless of PDS result
    await env.DB.prepare(
      'DELETE FROM read_positions_cache WHERE user_did = ? AND rkey = ?'
    ).bind(session.did, rkey).run();

    if (!result.ok) {
      // If record doesn't exist on PDS, that's fine for delete
      if (result.data.error === 'RecordNotFound') {
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        error: result.data.error || 'PDS request failed',
        message: result.data.message,
      }), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // For create/update, check cache first
  if (!record) {
    return new Response(JSON.stringify({ error: 'Record required for create/update' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const readRecord = record as unknown as ReadPositionRecord;

  // Check if this record is already in cache and synced
  const cached = await env.DB.prepare(
    'SELECT id, record_uri, synced_at FROM read_positions_cache WHERE user_did = ? AND rkey = ?'
  ).bind(session.did, rkey).first<CachedReadPosition>();

  if (cached && cached.synced_at !== null && cached.record_uri) {
    // Already synced - return cached URI without hitting PDS
    console.log(`Read position ${rkey} already synced, returning cached URI`);
    return new Response(JSON.stringify({
      uri: cached.record_uri,
      cached: true,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Not in cache or not yet synced - sync to PDS
  const requestBody = {
    repo: session.did,
    collection,
    rkey,
    record: { $type: collection, ...record },
  };
  console.log('Syncing read position to PDS:', rkey);
  const result = await makePdsRequest(session, 'com.atproto.repo.putRecord', requestBody);

  if (!result.ok) {
    console.error('PDS request failed for read position:', result.data);
    return new Response(JSON.stringify({
      error: result.data.error || 'PDS request failed',
      message: result.data.message,
    }), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Update cache with sync result
  const recordUri = result.data.uri || `at://${session.did}/${collection}/${rkey}`;
  try {
    await env.DB.prepare(`
      INSERT INTO read_positions_cache
      (user_did, rkey, record_uri, item_guid, item_url, item_title, starred, read_at, synced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(user_did, rkey) DO UPDATE SET
        record_uri = excluded.record_uri,
        starred = excluded.starred,
        synced_at = unixepoch()
    `).bind(
      session.did,
      rkey,
      recordUri,
      readRecord.itemGuid,
      readRecord.itemUrl || null,
      readRecord.itemTitle || null,
      readRecord.starred ? 1 : 0,
      readRecord.readAt
    ).run();
  } catch (cacheError) {
    console.error('Failed to cache read position:', cacheError);
    // Don't fail the request if caching fails
  }

  return new Response(JSON.stringify({
    uri: result.data.uri,
    cid: result.data.cid,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleRecordSync(request: Request, env: Env): Promise<Response> {
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

  let body: RecordSyncRequest;
  try {
    body = await request.json() as RecordSyncRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { operation, collection, rkey, record } = body;

  // Validate operation
  if (!['create', 'update', 'delete'].includes(operation)) {
    return new Response(JSON.stringify({ error: 'Invalid operation' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate collection
  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    return new Response(JSON.stringify({ error: 'Invalid collection' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate rkey
  if (!rkey || typeof rkey !== 'string') {
    return new Response(JSON.stringify({ error: 'Invalid rkey' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate record for create/update
  if ((operation === 'create' || operation === 'update') && !record) {
    return new Response(JSON.stringify({ error: 'Record required for create/update' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Handle read positions with cache-first deduplication
    if (collection === 'com.at-rss.feed.readPosition') {
      return await handleReadPositionSync(env, session, operation, rkey, record);
    }

    let result: { ok: boolean; data: PdsResponse; status: number };

    if (operation === 'create' || operation === 'update') {
      // Use putRecord for both create and update - it's idempotent
      // This handles retries gracefully when a record already exists
      const requestBody = {
        repo: session.did,
        collection,
        rkey,
        record: { $type: collection, ...record },
      };
      console.log('Upserting record:', JSON.stringify(requestBody, null, 2));
      result = await makePdsRequest(session, 'com.atproto.repo.putRecord', requestBody);
    } else {
      // delete
      result = await makePdsRequest(session, 'com.atproto.repo.deleteRecord', {
        repo: session.did,
        collection,
        rkey,
      });
    }

    if (!result.ok) {
      console.error('PDS request failed:', result.data);
      return new Response(JSON.stringify({
        error: result.data.error || 'PDS request failed',
        message: result.data.message,
      }), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Cache subscription for scheduled feed fetching
    if (collection === 'com.at-rss.feed.subscription') {
      try {
        if (operation === 'create' || operation === 'update') {
          const feedRecord = record as { feedUrl: string; title?: string };
          const recordUri = result.data.uri || `at://${session.did}/${collection}/${rkey}`;
          await env.DB.prepare(`
            INSERT OR REPLACE INTO subscriptions_cache
            (user_did, record_uri, feed_url, title, created_at)
            VALUES (?, ?, ?, ?, unixepoch())
          `).bind(
            session.did,
            recordUri,
            feedRecord.feedUrl,
            feedRecord.title || null
          ).run();
        } else if (operation === 'delete') {
          await env.DB.prepare(
            'DELETE FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
          ).bind(session.did, `%/${rkey}`).run();
        }
      } catch (cacheError) {
        // Log but don't fail the request if caching fails
        console.error('Failed to cache subscription:', cacheError);
      }
    }

    // Index shares for social feed
    if (collection === 'com.at-rss.social.share') {
      try {
        const recordUri = result.data.uri || `at://${session.did}/${collection}/${rkey}`;
        if (operation === 'create' || operation === 'update') {
          const shareRecord = record as {
            itemUrl: string;
            itemTitle?: string;
            itemAuthor?: string;
            itemDescription?: string;
            itemImage?: string;
            note?: string;
            tags?: string[];
            createdAt: string;
          };

          // Ensure user exists in users table with full profile info
          await env.DB.prepare(`
            INSERT INTO users (did, handle, display_name, avatar_url, pds_url, updated_at)
            VALUES (?, ?, ?, ?, ?, unixepoch())
            ON CONFLICT(did) DO UPDATE SET
              handle = excluded.handle,
              display_name = COALESCE(excluded.display_name, users.display_name),
              avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
              updated_at = unixepoch()
          `).bind(
            session.did,
            session.handle || session.did,
            session.displayName || null,
            session.avatarUrl || null,
            session.pdsUrl
          ).run();

          // Insert share into shares table
          await env.DB.prepare(`
            INSERT OR REPLACE INTO shares
            (author_did, record_uri, record_cid, item_url, item_title,
             item_author, item_description, item_image, note, tags, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            session.did,
            recordUri,
            result.data.cid || '',
            shareRecord.itemUrl,
            shareRecord.itemTitle || null,
            shareRecord.itemAuthor || null,
            shareRecord.itemDescription || null,
            shareRecord.itemImage || null,
            shareRecord.note || null,
            shareRecord.tags ? JSON.stringify(shareRecord.tags) : null,
            new Date(shareRecord.createdAt).getTime()
          ).run();

          // Notify RealtimeHub of new share for live updates
          try {
            const hubId = env.REALTIME_HUB.idFromName('main');
            const hub = env.REALTIME_HUB.get(hubId);
            await hub.fetch('http://internal/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'new_share',
                payload: {
                  authorDid: session.did,
                  authorHandle: session.handle,
                  authorDisplayName: session.displayName,
                  authorAvatar: session.avatarUrl,
                  recordUri,
                  itemUrl: shareRecord.itemUrl,
                  itemTitle: shareRecord.itemTitle,
                  itemDescription: shareRecord.itemDescription,
                  itemImage: shareRecord.itemImage,
                  note: shareRecord.note,
                  createdAt: shareRecord.createdAt,
                },
              }),
            });
          } catch (realtimeError) {
            console.error('Failed to notify RealtimeHub:', realtimeError);
          }
        } else if (operation === 'delete') {
          await env.DB.prepare(
            'DELETE FROM shares WHERE record_uri = ?'
          ).bind(recordUri).run();
        }
      } catch (cacheError) {
        console.error('Failed to index share:', cacheError);
      }
    }

    return new Response(JSON.stringify({
      uri: result.data.uri,
      cid: result.data.cid,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Record sync error:', error);
    const errorMessage = error instanceof Error
      ? `${error.name}: ${error.message}`
      : 'Failed to sync record';
    console.error('Error details:', errorMessage, error instanceof Error ? error.stack : '');
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

interface ListRecordsResponse {
  records: Array<{
    uri: string;
    cid: string;
    value: Record<string, unknown>;
  }>;
  cursor?: string;
}

export async function handleRecordsList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const collection = url.searchParams.get('collection');

  if (!collection || !ALLOWED_COLLECTIONS.includes(collection)) {
    return new Response(JSON.stringify({ error: 'Invalid collection' }), {
      status: 400,
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

  try {
    const allRecords: ListRecordsResponse['records'] = [];
    let cursor: string | undefined;

    // Paginate through all records
    do {
      const params: Record<string, string> = {
        repo: session.did,
        collection,
        limit: '100',
      };
      if (cursor) {
        params.cursor = cursor;
      }

      const result = await makePdsGetRequest<ListRecordsResponse>(
        session,
        'com.atproto.repo.listRecords',
        params
      );

      if (!result.ok) {
        console.error('PDS listRecords failed:', result.data);
        return new Response(JSON.stringify({
          error: 'Failed to fetch records from PDS',
        }), {
          status: result.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      allRecords.push(...result.data.records);
      cursor = result.data.cursor;
    } while (cursor);

    return new Response(JSON.stringify({ records: allRecords }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Record list error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to list records' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
