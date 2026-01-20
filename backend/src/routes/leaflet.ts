import type { Env, Session } from '../types';
import { getSessionFromRequest, importPrivateKey, createDPoPProof } from '../services/oauth';
import { fetchLeafletSubscriptions, resolvePublicationToRss } from '../services/leaflet';
import { fetchAndCacheFeed } from './feeds';

// Generate a TID (Timestamp Identifier) for record keys
function generateTid(): string {
  const now = Date.now() * 1000; // microseconds
  const clockId = Math.floor(Math.random() * 1024);
  const tid = BigInt(now) << BigInt(10) | BigInt(clockId);

  // Base32 encode (sortable)
  const chars = '234567abcdefghijklmnopqrstuvwxyz';
  let result = '';
  let value = tid;
  for (let i = 0; i < 13; i++) {
    result = chars[Number(value % BigInt(32))] + result;
    value = value / BigInt(32);
  }
  return result;
}

// Make authenticated POST request to user's PDS
async function makePdsRequest(
  session: Session,
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; data: { uri?: string; cid?: string; error?: string; message?: string }; status: number }> {
  const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
  const privateKey = await importPrivateKey(privateKeyJwk);
  const publicKeyJwk = { ...privateKeyJwk };
  delete (publicKeyJwk as Record<string, unknown>).d;

  const url = `${session.pdsUrl}/xrpc/${endpoint}`;
  let nonce: string | undefined;

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

    const data = await response.json() as { uri?: string; cid?: string; error?: string; message?: string };

    if (data.error === 'use_dpop_nonce') {
      nonce = response.headers.get('dpop-nonce') || response.headers.get('DPoP-Nonce') || undefined;
      if (nonce) continue;
    }

    return { ok: response.ok, data, status: response.status };
  }

  return { ok: false, data: { error: 'Failed after nonce retry' }, status: 400 };
}

// Get Leaflet sync settings for a user
export async function handleGetLeafletSettings(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const settings = await env.DB.prepare(`
    SELECT leaflet_sync_enabled, leaflet_last_synced_at
    FROM user_settings
    WHERE user_did = ?
  `).bind(session.did).first<{
    leaflet_sync_enabled: number;
    leaflet_last_synced_at: number | null;
  }>();

  return new Response(JSON.stringify({
    enabled: settings?.leaflet_sync_enabled === 1,
    lastSyncedAt: settings?.leaflet_last_synced_at ? settings.leaflet_last_synced_at * 1000 : null,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Update Leaflet sync settings
export async function handleUpdateLeafletSettings(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { enabled: boolean };
  try {
    body = await request.json() as { enabled: boolean };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await env.DB.prepare(`
    INSERT INTO user_settings (user_did, leaflet_sync_enabled, created_at, updated_at)
    VALUES (?, ?, unixepoch(), unixepoch())
    ON CONFLICT(user_did) DO UPDATE SET
      leaflet_sync_enabled = excluded.leaflet_sync_enabled,
      updated_at = unixepoch()
  `).bind(session.did, body.enabled ? 1 : 0).run();

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Sync Leaflet subscriptions
export async function handleLeafletSync(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const errors: string[] = [];
  let added = 0;
  let removed = 0;

  try {
    // 1. Fetch all Leaflet subscriptions from user's PDS
    const leafletSubs = await fetchLeafletSubscriptions(session);
    console.log(`Found ${leafletSubs.length} Leaflet subscriptions for ${session.handle}`);

    // 2. Get current Skyreader subscriptions with source='leaflet'
    const currentLeafletSubs = await env.DB.prepare(`
      SELECT record_uri, external_ref, feed_url
      FROM subscriptions_cache
      WHERE user_did = ? AND source = 'leaflet'
    `).bind(session.did).all<{
      record_uri: string;
      external_ref: string;
      feed_url: string;
    }>();

    const currentByRef = new Map<string, { record_uri: string; feed_url: string }>();
    for (const row of currentLeafletSubs.results) {
      if (row.external_ref) {
        currentByRef.set(row.external_ref, { record_uri: row.record_uri, feed_url: row.feed_url });
      }
    }

    const leafletByUri = new Map<string, typeof leafletSubs[0]>();
    for (const sub of leafletSubs) {
      leafletByUri.set(sub.uri, sub);
    }

    // 3. Find subscriptions to add (in Leaflet but not in Skyreader)
    const toAdd: Array<{ leafletUri: string; rssUrl: string; title: string; siteUrl: string }> = [];
    for (const sub of leafletSubs) {
      if (!currentByRef.has(sub.uri)) {
        const resolved = await resolvePublicationToRss(sub.value.publication);
        if (resolved) {
          toAdd.push({
            leafletUri: sub.uri,
            rssUrl: resolved.rssUrl,
            title: resolved.title || resolved.rssUrl,
            siteUrl: resolved.siteUrl,
          });
        } else {
          errors.push(`Could not resolve publication: ${sub.value.publication}`);
        }
      }
    }

    // 4. Find subscriptions to remove (in Skyreader but not in Leaflet)
    const toRemove: Array<{ recordUri: string; feedUrl: string }> = [];
    for (const [externalRef, sub] of currentByRef) {
      if (!leafletByUri.has(externalRef)) {
        toRemove.push({ recordUri: sub.record_uri, feedUrl: sub.feed_url });
      }
    }

    console.log(`Leaflet sync: adding ${toAdd.length}, removing ${toRemove.length}`);

    // 5. Add new subscriptions
    for (const sub of toAdd) {
      try {
        const rkey = generateTid();
        const record = {
          $type: 'app.skyreader.feed.subscription',
          feedUrl: sub.rssUrl,
          title: sub.title,
          siteUrl: sub.siteUrl,
          source: 'leaflet',
          externalRef: sub.leafletUri,
          createdAt: new Date().toISOString(),
        };

        const result = await makePdsRequest(session, 'com.atproto.repo.putRecord', {
          repo: session.did,
          collection: 'app.skyreader.feed.subscription',
          rkey,
          record,
        });

        if (result.ok) {
          const recordUri = result.data.uri || `at://${session.did}/app.skyreader.feed.subscription/${rkey}`;

          // Cache in D1
          await env.DB.prepare(`
            INSERT OR REPLACE INTO subscriptions_cache
            (user_did, record_uri, feed_url, title, source, external_ref, created_at)
            VALUES (?, ?, ?, ?, 'leaflet', ?, unixepoch())
          `).bind(
            session.did,
            recordUri,
            sub.rssUrl,
            sub.title,
            sub.leafletUri
          ).run();

          // Fetch the feed
          try {
            await fetchAndCacheFeed(env, sub.rssUrl);
          } catch (fetchError) {
            console.error(`Failed to fetch feed ${sub.rssUrl}:`, fetchError);
          }

          added++;
        } else {
          errors.push(`Failed to add ${sub.title}: ${result.data.error || result.data.message}`);
        }
      } catch (error) {
        errors.push(`Failed to add ${sub.title}: ${error}`);
      }
    }

    // 6. Remove old subscriptions
    for (const sub of toRemove) {
      try {
        // Extract rkey from record URI (at://did/collection/rkey)
        const rkey = sub.recordUri.split('/').pop();
        if (!rkey) {
          errors.push(`Invalid record URI: ${sub.recordUri}`);
          continue;
        }

        const result = await makePdsRequest(session, 'com.atproto.repo.deleteRecord', {
          repo: session.did,
          collection: 'app.skyreader.feed.subscription',
          rkey,
        });

        if (result.ok || result.status === 404) {
          // Remove from cache
          await env.DB.prepare(
            'DELETE FROM subscriptions_cache WHERE user_did = ? AND record_uri = ?'
          ).bind(session.did, sub.recordUri).run();

          removed++;
        } else {
          errors.push(`Failed to remove feed: ${result.data.error || result.data.message}`);
        }
      } catch (error) {
        errors.push(`Failed to remove feed: ${error}`);
      }
    }

    // 7. Update last sync time
    await env.DB.prepare(`
      INSERT INTO user_settings (user_did, leaflet_sync_enabled, leaflet_last_synced_at, created_at, updated_at)
      VALUES (?, 1, unixepoch(), unixepoch(), unixepoch())
      ON CONFLICT(user_did) DO UPDATE SET
        leaflet_last_synced_at = unixepoch(),
        updated_at = unixepoch()
    `).bind(session.did).run();

    return new Response(JSON.stringify({
      added,
      removed,
      errors,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Leaflet sync error:', error);
    return new Response(JSON.stringify({
      error: 'Sync failed',
      message: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
