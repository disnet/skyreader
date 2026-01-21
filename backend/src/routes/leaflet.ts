import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { fetchLeafletSubscriptions, resolvePublicationToRss } from '../services/leaflet';

// Maximum publications to resolve in a single request (to stay under CF subrequest limits)
const MAX_BATCH_SIZE = 10;

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

// Get user's Leaflet subscriptions (publication URIs)
export async function handleGetLeafletSubscriptions(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const subs = await fetchLeafletSubscriptions(session);
    console.log(`Found ${subs.length} Leaflet subscriptions for ${session.handle}`);

    return new Response(JSON.stringify({
      subscriptions: subs.map(s => ({
        uri: s.uri,
        publication: s.value.publication,
      })),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to fetch Leaflet subscriptions:', error);
    return new Response(JSON.stringify({
      error: 'Failed to fetch subscriptions',
      message: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Resolve batch of publication URIs to RSS URLs
export async function handleResolvePublications(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { publications: string[] };
  try {
    body = await request.json() as { publications: string[] };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(body.publications)) {
    return new Response(JSON.stringify({ error: 'publications must be an array' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (body.publications.length > MAX_BATCH_SIZE) {
    return new Response(JSON.stringify({
      error: `Max ${MAX_BATCH_SIZE} publications per request`,
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Resolve all publications in parallel
    const results = await Promise.all(
      body.publications.map(async (pub) => {
        const resolved = await resolvePublicationToRss(pub, env);
        return { publication: pub, resolved };
      })
    );

    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to resolve publications:', error);
    return new Response(JSON.stringify({
      error: 'Failed to resolve publications',
      message: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
