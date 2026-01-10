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
    let result: { ok: boolean; data: PdsResponse; status: number };

    if (operation === 'create') {
      result = await makePdsRequest(session, 'com.atproto.repo.createRecord', {
        repo: session.did,
        collection,
        rkey,
        record: { $type: collection, ...record },
      });
    } else if (operation === 'update') {
      result = await makePdsRequest(session, 'com.atproto.repo.putRecord', {
        repo: session.did,
        collection,
        rkey,
        record: { $type: collection, ...record },
      });
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

    return new Response(JSON.stringify({
      uri: result.data.uri,
      cid: result.data.cid,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Record sync error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to sync record' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
