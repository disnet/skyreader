import type { Env } from '../types';
import { getSessionFromRequest, importPrivateKey, createDPoPProof } from '../services/oauth';
import { fetchArticleContent } from '../services/jetstream-poller';
import { fetchAndCacheFeed } from './feeds';

const ALLOWED_COLLECTIONS = [
  'app.skyreader.feed.subscription',
  'app.skyreader.feed.readPosition',
  'app.skyreader.social.share',
  'app.skyreader.social.follow',
  'app.skyreader.social.shareReadPosition',
];

const MAX_SUBSCRIPTIONS = 100;

interface ProfileInfo {
  handle: string;
  displayName?: string;
  avatar?: string;
}

async function fetchProfileInfo(did: string): Promise<ProfileInfo | null> {
  try {
    const response = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      console.warn(`Failed to fetch profile for ${did}: ${response.status}`);
      return null;
    }

    const data = await response.json() as {
      handle: string;
      displayName?: string;
      avatar?: string;
    };

    return {
      handle: data.handle,
      displayName: data.displayName,
      avatar: data.avatar,
    };
  } catch (error) {
    console.error(`Error fetching profile for ${did}:`, error);
    return null;
  }
}

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
        collection: 'app.skyreader.feed.readPosition',
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
  const collection = 'app.skyreader.feed.readPosition';

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

interface ShareReadPositionRecord {
  shareUri: string;
  shareAuthorDid: string;
  itemUrl?: string;
  itemTitle?: string;
  readAt: string;
}

async function handleShareReadPositionSync(
  env: Env,
  session: { did: string; pdsUrl: string; accessToken: string; dpopPrivateKey: string },
  operation: 'create' | 'update' | 'delete',
  rkey: string,
  record?: Record<string, unknown>
): Promise<Response> {
  const collection = 'app.skyreader.social.shareReadPosition';

  if (operation === 'delete') {
    // For delete, remove from cache and PDS
    const result = await makePdsRequest(session, 'com.atproto.repo.deleteRecord', {
      repo: session.did,
      collection,
      rkey,
    });

    // Remove from cache regardless of PDS result
    await env.DB.prepare(
      'DELETE FROM share_read_positions_cache WHERE user_did = ? AND rkey = ?'
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
  const shareReadRecord = record as unknown as ShareReadPositionRecord;

  // Check if this record is already in cache and synced (by shareUri)
  const cached = await env.DB.prepare(
    'SELECT id, record_uri, synced_at FROM share_read_positions_cache WHERE user_did = ? AND share_uri = ?'
  ).bind(session.did, shareReadRecord.shareUri).first<{ id: number; record_uri: string | null; synced_at: number | null }>();

  if (cached && cached.synced_at !== null && cached.record_uri) {
    // Already synced - return cached URI without hitting PDS
    console.log(`Share read position for ${shareReadRecord.shareUri} already synced, returning cached URI`);
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
  console.log('Syncing share read position to PDS:', rkey);
  const result = await makePdsRequest(session, 'com.atproto.repo.putRecord', requestBody);

  if (!result.ok) {
    console.error('PDS request failed for share read position:', result.data);
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
      INSERT INTO share_read_positions_cache
      (user_did, rkey, record_uri, share_uri, share_author_did, item_url, item_title, read_at, synced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(user_did, share_uri) DO UPDATE SET
        record_uri = excluded.record_uri,
        synced_at = unixepoch()
    `).bind(
      session.did,
      rkey,
      recordUri,
      shareReadRecord.shareUri,
      shareReadRecord.shareAuthorDid,
      shareReadRecord.itemUrl || null,
      shareReadRecord.itemTitle || null,
      shareReadRecord.readAt
    ).run();
  } catch (cacheError) {
    console.error('Failed to cache share read position:', cacheError);
    // Don't fail the request if caching fails
  }

  return new Response(JSON.stringify({
    uri: result.data.uri,
    cid: result.data.cid,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function countUserSubscriptions(
  session: { did: string; pdsUrl: string; accessToken: string; dpopPrivateKey: string }
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      repo: session.did,
      collection: 'app.skyreader.feed.subscription',
      limit: '100',
    };

    if (cursor) {
      params.cursor = cursor;
    }

    const result = await makePdsGetRequest<{
      records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>;
      cursor?: string;
    }>(session, 'com.atproto.repo.listRecords', params);

    if (!result.ok) {
      throw new Error('Failed to count subscriptions');
    }

    count += result.data.records.length;
    cursor = result.data.cursor;
  } while (cursor);

  return count;
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

  // Check subscription limit for creates
  if (operation === 'create' && collection === 'app.skyreader.feed.subscription') {
    try {
      const currentCount = await countUserSubscriptions(session);
      if (currentCount >= MAX_SUBSCRIPTIONS) {
        return new Response(JSON.stringify({
          error: 'subscription_limit_reached',
          message: `You have reached the maximum of ${MAX_SUBSCRIPTIONS} feed subscriptions.`,
          limit: MAX_SUBSCRIPTIONS,
          current: currentCount,
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (countError) {
      console.error('Failed to check subscription count:', countError);
      // Continue anyway - don't block user if count check fails
    }
  }

  try {
    // Handle read positions with cache-first deduplication
    if (collection === 'app.skyreader.feed.readPosition') {
      return await handleReadPositionSync(env, session, operation, rkey, record);
    }

    // Handle share read positions with cache-first deduplication
    if (collection === 'app.skyreader.social.shareReadPosition') {
      return await handleShareReadPositionSync(env, session, operation, rkey, record);
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
    if (collection === 'app.skyreader.feed.subscription') {
      const feedRecord = record as { feedUrl: string; title?: string };
      try {
        if (operation === 'create' || operation === 'update') {
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

      // Trigger immediate feed fetch for new subscriptions
      if (operation === 'create' && feedRecord.feedUrl) {
        try {
          await fetchAndCacheFeed(env, feedRecord.feedUrl);
          console.log(`Fetched feed for new subscription: ${feedRecord.feedUrl}`);
        } catch (fetchError) {
          // Don't fail the request if feed fetch fails - cron will retry
          console.error(`Failed to fetch feed ${feedRecord.feedUrl}:`, fetchError);
        }
      }
    }

    // Index shares for social feed
    if (collection === 'app.skyreader.social.share') {
      try {
        const recordUri = result.data.uri || `at://${session.did}/${collection}/${rkey}`;
        if (operation === 'create' || operation === 'update') {
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

          // Insert share into shares table (content will be updated after fetch)
          const shareRecordForInsert = record as {
            feedUrl?: string;
            itemGuid?: string;
            itemUrl: string;
            itemTitle?: string;
            itemAuthor?: string;
            itemDescription?: string;
            itemImage?: string;
            itemPublishedAt?: string;
            note?: string;
            tags?: string[];
            createdAt: string;
          };
          await env.DB.prepare(`
            INSERT OR REPLACE INTO shares
            (author_did, record_uri, record_cid, feed_url, item_url, item_title,
             item_author, item_description, item_image, item_guid, item_published_at, note, tags, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            session.did,
            recordUri,
            result.data.cid || '',
            shareRecordForInsert.feedUrl || null,
            shareRecordForInsert.itemUrl,
            shareRecordForInsert.itemTitle || null,
            shareRecordForInsert.itemAuthor || null,
            shareRecordForInsert.itemDescription || null,
            shareRecordForInsert.itemImage || null,
            shareRecordForInsert.itemGuid || null,
            shareRecordForInsert.itemPublishedAt ? new Date(shareRecordForInsert.itemPublishedAt).getTime() : null,
            shareRecordForInsert.note || null,
            shareRecordForInsert.tags ? JSON.stringify(shareRecordForInsert.tags) : null,
            new Date(shareRecordForInsert.createdAt).getTime()
          ).run();

          // Fetch article content if feedUrl and itemGuid are available
          let articleContent: string | null = null;
          if (shareRecordForInsert.feedUrl && shareRecordForInsert.itemGuid) {
            articleContent = await fetchArticleContent(env, shareRecordForInsert.feedUrl, shareRecordForInsert.itemGuid, shareRecordForInsert.itemUrl);
          }

          // Update share with content if fetched
          if (articleContent) {
            await env.DB.prepare(`
              UPDATE shares SET content = ?
              WHERE record_uri = ?
            `).bind(articleContent, recordUri).run();
          }

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
                  feedUrl: shareRecordForInsert.feedUrl,
                  itemUrl: shareRecordForInsert.itemUrl,
                  itemTitle: shareRecordForInsert.itemTitle,
                  itemDescription: shareRecordForInsert.itemDescription,
                  itemImage: shareRecordForInsert.itemImage,
                  itemGuid: shareRecordForInsert.itemGuid,
                  itemPublishedAt: shareRecordForInsert.itemPublishedAt,
                  note: shareRecordForInsert.note,
                  content: articleContent,
                  createdAt: shareRecordForInsert.createdAt,
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

    // Index in-app follows
    if (collection === 'app.skyreader.social.follow') {
      try {
        const followRecord = record as { subject: string; createdAt: string };
        const recordUri = result.data.uri || `at://${session.did}/${collection}/${rkey}`;

        if (operation === 'create' || operation === 'update') {
          // Insert into inapp_follows
          await env.DB.prepare(`
            INSERT OR REPLACE INTO inapp_follows
            (follower_did, following_did, rkey, record_uri, created_at)
            VALUES (?, ?, ?, ?, unixepoch())
          `).bind(session.did, followRecord.subject, rkey, recordUri).run();

          // Ensure followed user exists in users table
          const profile = await fetchProfileInfo(followRecord.subject);
          await env.DB.prepare(`
            INSERT INTO users (did, handle, display_name, avatar_url, pds_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, '', unixepoch(), unixepoch())
            ON CONFLICT(did) DO UPDATE SET
              handle = CASE WHEN excluded.handle != excluded.did THEN excluded.handle ELSE users.handle END,
              display_name = COALESCE(excluded.display_name, users.display_name),
              avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
              updated_at = unixepoch()
          `).bind(
            followRecord.subject,
            profile?.handle || followRecord.subject,
            profile?.displayName || null,
            profile?.avatar || null
          ).run();

          console.log(`Indexed in-app follow: ${session.did} -> ${followRecord.subject}`);
        } else if (operation === 'delete') {
          await env.DB.prepare(
            'DELETE FROM inapp_follows WHERE follower_did = ? AND rkey = ?'
          ).bind(session.did, rkey).run();
          console.log(`Removed in-app follow: ${session.did} (rkey: ${rkey})`);
        }
      } catch (cacheError) {
        console.error('Failed to index in-app follow:', cacheError);
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

interface BulkSyncRequest {
  operations: Array<{
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    record?: Record<string, unknown>;
  }>;
}

interface ApplyWritesResponse {
  results?: Array<{
    uri?: string;
    cid?: string;
    validationStatus?: string;
  }>;
  error?: string;
  message?: string;
}

export async function handleBulkRecordSync(request: Request, env: Env): Promise<Response> {
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

  let body: BulkSyncRequest;
  try {
    body = await request.json() as BulkSyncRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { operations } = body;

  if (!Array.isArray(operations) || operations.length === 0) {
    return new Response(JSON.stringify({ error: 'Operations array required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate all operations
  for (const op of operations) {
    if (!['create', 'update', 'delete'].includes(op.operation)) {
      return new Response(JSON.stringify({ error: `Invalid operation: ${op.operation}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!ALLOWED_COLLECTIONS.includes(op.collection)) {
      return new Response(JSON.stringify({ error: `Invalid collection: ${op.collection}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!op.rkey || typeof op.rkey !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid rkey' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if ((op.operation === 'create' || op.operation === 'update') && !op.record) {
      return new Response(JSON.stringify({ error: 'Record required for create/update' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Check subscription limit for bulk creates
  const subscriptionCreates = operations.filter(
    op => op.operation === 'create' && op.collection === 'app.skyreader.feed.subscription'
  );

  if (subscriptionCreates.length > 0) {
    try {
      const currentCount = await countUserSubscriptions(session);
      const totalAfterImport = currentCount + subscriptionCreates.length;

      if (totalAfterImport > MAX_SUBSCRIPTIONS) {
        const available = Math.max(0, MAX_SUBSCRIPTIONS - currentCount);
        return new Response(JSON.stringify({
          error: 'subscription_limit_exceeded',
          message: `Adding ${subscriptionCreates.length} feeds would exceed the maximum of ${MAX_SUBSCRIPTIONS}.`,
          limit: MAX_SUBSCRIPTIONS,
          current: currentCount,
          requested: subscriptionCreates.length,
          available,
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (countError) {
      console.error('Failed to check subscription count:', countError);
      // Continue anyway - don't block user if count check fails
    }
  }

  try {
    // Build applyWrites request
    const writes = operations.map(op => {
      if (op.operation === 'delete') {
        return {
          $type: 'com.atproto.repo.applyWrites#delete',
          collection: op.collection,
          rkey: op.rkey,
        };
      } else {
        // Both create and update use the same format with applyWrites
        return {
          $type: 'com.atproto.repo.applyWrites#create',
          collection: op.collection,
          rkey: op.rkey,
          value: { $type: op.collection, ...op.record },
        };
      }
    });

    const requestBody = {
      repo: session.did,
      writes,
    };

    console.log(`Bulk sync: ${operations.length} operations`);
    const result = await makePdsRequest(session, 'com.atproto.repo.applyWrites', requestBody);

    if (!result.ok) {
      console.error('Bulk PDS request failed:', result.data);
      return new Response(JSON.stringify({
        error: result.data.error || 'PDS request failed',
        message: result.data.message,
      }), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const applyResult = result.data as unknown as ApplyWritesResponse;

    // Cache subscriptions for scheduled feed fetching
    const subscriptionOps = operations.filter(op => op.collection === 'app.skyreader.feed.subscription');
    const feedsToFetch: string[] = [];

    for (let i = 0; i < subscriptionOps.length; i++) {
      const op = subscriptionOps[i];
      try {
        if (op.operation === 'create' || op.operation === 'update') {
          const feedRecord = op.record as { feedUrl: string; title?: string };
          const resultUri = applyResult.results?.[i]?.uri;
          const recordUri = resultUri || `at://${session.did}/${op.collection}/${op.rkey}`;
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

          // Collect feeds to fetch (for create only)
          if (op.operation === 'create' && feedRecord.feedUrl) {
            feedsToFetch.push(feedRecord.feedUrl);
          }
        } else if (op.operation === 'delete') {
          await env.DB.prepare(
            'DELETE FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
          ).bind(session.did, `%/${op.rkey}`).run();
        }
      } catch (cacheError) {
        console.error('Failed to cache subscription:', cacheError);
      }
    }

    // Fetch feeds for new subscriptions (limit to 5 to stay under subrequest limits)
    const MAX_FEEDS_TO_FETCH = 5;
    for (let i = 0; i < Math.min(feedsToFetch.length, MAX_FEEDS_TO_FETCH); i++) {
      try {
        await fetchAndCacheFeed(env, feedsToFetch[i]);
        console.log(`Fetched feed for new subscription: ${feedsToFetch[i]}`);
      } catch (fetchError) {
        console.error(`Failed to fetch feed ${feedsToFetch[i]}:`, fetchError);
      }
    }
    if (feedsToFetch.length > MAX_FEEDS_TO_FETCH) {
      console.log(`${feedsToFetch.length - MAX_FEEDS_TO_FETCH} feeds will be fetched by cron`);
    }

    // Index shares in D1 for social feed
    const shareOps = operations.filter(op => op.collection === 'app.skyreader.social.share');
    for (let i = 0; i < shareOps.length; i++) {
      const op = shareOps[i];
      try {
        // Find the index of this share op in the original operations array
        const originalIndex = operations.indexOf(op);
        const resultUri = applyResult.results?.[originalIndex]?.uri;
        const recordUri = resultUri || `at://${session.did}/${op.collection}/${op.rkey}`;
        const resultCid = applyResult.results?.[originalIndex]?.cid || '';

        if (op.operation === 'create' || op.operation === 'update') {
          // Ensure user exists
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

          // Insert share
          const shareRecord = op.record as {
            feedUrl?: string;
            itemGuid?: string;
            itemUrl: string;
            itemTitle?: string;
            itemAuthor?: string;
            itemDescription?: string;
            itemImage?: string;
            itemPublishedAt?: string;
            note?: string;
            tags?: string[];
            createdAt: string;
          };

          await env.DB.prepare(`
            INSERT OR REPLACE INTO shares
            (author_did, record_uri, record_cid, feed_url, item_url, item_title,
             item_author, item_description, item_image, item_guid, item_published_at, note, tags, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            session.did,
            recordUri,
            resultCid,
            shareRecord.feedUrl || null,
            shareRecord.itemUrl,
            shareRecord.itemTitle || null,
            shareRecord.itemAuthor || null,
            shareRecord.itemDescription || null,
            shareRecord.itemImage || null,
            shareRecord.itemGuid || null,
            shareRecord.itemPublishedAt ? new Date(shareRecord.itemPublishedAt).getTime() : null,
            shareRecord.note || null,
            shareRecord.tags ? JSON.stringify(shareRecord.tags) : null,
            new Date(shareRecord.createdAt).getTime()
          ).run();
        } else if (op.operation === 'delete') {
          await env.DB.prepare(
            'DELETE FROM shares WHERE record_uri = ?'
          ).bind(recordUri).run();
        }
      } catch (shareError) {
        console.error('[bulk-sync] Failed to index share:', shareError);
      }
    }

    // Build response with URIs
    const results = operations.map((op, i) => ({
      rkey: op.rkey,
      uri: applyResult.results?.[i]?.uri || `at://${session.did}/${op.collection}/${op.rkey}`,
      cid: applyResult.results?.[i]?.cid,
    }));

    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Bulk record sync error:', error);
    const errorMessage = error instanceof Error
      ? `${error.name}: ${error.message}`
      : 'Failed to sync records';
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
