import type { Env } from '../types';
import { getSessionFromRequest, importPrivateKey, createDPoPProof } from '../services/oauth';

interface ShareRecord {
  feedUrl?: string;
  itemGuid?: string;
  itemUrl: string;
  itemTitle?: string;
  itemAuthor?: string;
  itemDescription?: string;
  itemImage?: string;
  itemPublishedAt?: string;
  note?: string;
  createdAt: string;
}

interface UserShareRow {
  record_uri: string;
  record_cid: string;
  feed_url: string | null;
  item_url: string;
  item_title: string | null;
  item_author: string | null;
  item_description: string | null;
  item_image: string | null;
  item_guid: string | null;
  item_published_at: number | null;
  note: string | null;
  created_at: number;
}

// Track hydrated users (in-memory, per-isolate)
const hydratedShareUsers = new Set<string>();

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

async function hydrateSharesCacheFromPds(
  env: Env,
  session: { did: string; pdsUrl: string; accessToken: string; dpopPrivateKey: string }
): Promise<void> {
  // Check if we've already hydrated for this user in this isolate
  if (hydratedShareUsers.has(session.did)) {
    return;
  }

  // Check if user has any cached shares - if so, assume cache is valid
  const existingCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM shares WHERE author_did = ?'
  ).bind(session.did).first<{ count: number }>();

  console.log(`[shares/hydrate] User ${session.did} has ${existingCount?.count ?? 0} shares in D1`);

  if (existingCount && existingCount.count > 0) {
    hydratedShareUsers.add(session.did);
    return;
  }

  // No cache exists - fetch from PDS and populate
  console.log(`[shares/hydrate] Hydrating shares cache for ${session.did} from PDS`);

  try {
    const allRecords: Array<{ uri: string; cid: string; value: ShareRecord }> = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, string> = {
        repo: session.did,
        collection: 'app.skyreader.social.share',
        limit: '100',
      };
      if (cursor) {
        params.cursor = cursor;
      }

      const result = await makePdsGetRequest<{
        records: Array<{ uri: string; cid: string; value: ShareRecord }>;
        cursor?: string;
      }>(session, 'com.atproto.repo.listRecords', params);

      if (!result.ok) {
        console.error('[shares/hydrate] Failed to fetch shares from PDS:', result.data);
        break;
      }

      console.log(`[shares/hydrate] PDS returned ${result.data.records.length} records (cursor: ${cursor || 'none'})`);
      allRecords.push(...result.data.records);
      cursor = result.data.cursor;
    } while (cursor);

    // Insert all records into D1 shares table
    for (const record of allRecords) {
      try {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO shares
          (author_did, record_uri, record_cid, feed_url, item_url, item_title,
           item_author, item_description, item_image, item_guid, item_published_at, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          session.did,
          record.uri,
          record.cid,
          record.value.feedUrl || null,
          record.value.itemUrl,
          record.value.itemTitle || null,
          record.value.itemAuthor || null,
          record.value.itemDescription || null,
          record.value.itemImage || null,
          record.value.itemGuid || null,
          record.value.itemPublishedAt ? new Date(record.value.itemPublishedAt).getTime() : null,
          record.value.note || null,
          new Date(record.value.createdAt).getTime()
        ).run();
      } catch (err) {
        // Ignore insert errors (e.g., duplicates from unique constraint on record_uri)
        console.error('Failed to insert share from PDS:', err);
      }
    }

    console.log(`[shares/hydrate] Hydrated ${allRecords.length} shares for ${session.did}`);
    hydratedShareUsers.add(session.did);
  } catch (error) {
    console.error('Error hydrating shares cache:', error);
    // Don't throw - allow operation to continue, cache will be built up over time
  }
}

// GET /api/shares/my - Get user's own shares
export async function handleGetMyShares(request: Request, env: Env): Promise<Response> {
  console.log('[shares/my] Request received');
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    console.log('[shares/my] No session found');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(`[shares/my] Session found for user: ${session.did}`);

  try {
    // Hydrate from PDS if D1 cache is empty
    await hydrateSharesCacheFromPds(env, session);

    // Query user's shares from D1
    const result = await env.DB.prepare(`
      SELECT record_uri, record_cid, feed_url, item_url, item_title,
             item_author, item_description, item_image, item_guid,
             item_published_at, note, created_at
      FROM shares
      WHERE author_did = ?
      ORDER BY created_at DESC
    `).bind(session.did).all<UserShareRow>();

    console.log(`[shares/my] Found ${result.results.length} shares in D1 for ${session.did}`);

    const shares = result.results.map((row) => ({
      recordUri: row.record_uri,
      recordCid: row.record_cid,
      feedUrl: row.feed_url,
      articleGuid: row.item_guid,
      articleUrl: row.item_url,
      articleTitle: row.item_title,
      articleAuthor: row.item_author,
      articleDescription: row.item_description,
      articleImage: row.item_image,
      articlePublishedAt: row.item_published_at ? new Date(row.item_published_at).toISOString() : undefined,
      note: row.note,
      createdAt: new Date(row.created_at).toISOString(),
    }));

    return new Response(JSON.stringify({ shares }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get user shares:', error);
    return new Response(JSON.stringify({ error: 'Failed to get shares' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
