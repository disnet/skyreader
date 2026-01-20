import type { Env, Session } from '../types';
import { importPrivateKey, createDPoPProof } from './oauth';

// Leaflet subscription record from user's PDS
export interface LeafletSubscription {
  uri: string;
  cid: string;
  value: {
    publication: string; // at-uri like "at://did:plc:xxx/pub.leaflet.publication/tid"
    createdAt?: string;
  };
}

// Resolved publication info
export interface ResolvedPublication {
  rssUrl: string;
  title?: string;
  siteUrl: string;
}

// Cache TTL: 24 hours in seconds
const HANDLE_CACHE_TTL_SECONDS = 24 * 60 * 60;

// Parse an at-uri into components
function parseAtUri(atUri: string): { did: string; collection: string; rkey: string } | null {
  // at://did:plc:xxx/pub.leaflet.publication/tid
  const match = atUri.match(/^at:\/\/(did:[^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return {
    did: match[1],
    collection: match[2],
    rkey: match[3],
  };
}

// Resolve a DID to get its handle, using cache when available
async function resolveDidToHandle(did: string, env: Env): Promise<string | null> {
  // Check cache first
  const cached = await env.DB.prepare(`
    SELECT handle, cached_at FROM did_handle_cache
    WHERE did = ? AND cached_at > unixepoch() - ?
  `).bind(did, HANDLE_CACHE_TTL_SECONDS).first<{ handle: string; cached_at: number }>();

  if (cached) {
    return cached.handle;
  }

  // Cache miss or stale - fetch from plc.directory
  try {
    let didDocUrl: string;

    if (did.startsWith('did:plc:')) {
      didDocUrl = `https://plc.directory/${did}`;
    } else if (did.startsWith('did:web:')) {
      const domain = did.substring(8).replace(/:/g, '/');
      didDocUrl = `https://${domain}/.well-known/did.json`;
    } else {
      console.error(`Unsupported DID method: ${did}`);
      return null;
    }

    const response = await fetch(didDocUrl);
    if (!response.ok) {
      console.error(`Failed to resolve DID ${did}: ${response.status}`);
      return null;
    }

    const didDoc = await response.json() as {
      alsoKnownAs?: string[];
    };

    // Extract handle from alsoKnownAs (format: at://handle)
    let handle: string | null = null;
    if (didDoc.alsoKnownAs && didDoc.alsoKnownAs.length > 0) {
      for (const aka of didDoc.alsoKnownAs) {
        if (aka.startsWith('at://')) {
          handle = aka.replace('at://', '');
          break;
        }
      }
    }

    // Cache the result (even if null, to avoid repeated failed lookups)
    if (handle) {
      await env.DB.prepare(`
        INSERT INTO did_handle_cache (did, handle, cached_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, cached_at = unixepoch()
      `).bind(did, handle).run();
    }

    return handle;
  } catch (error) {
    console.error(`Error resolving DID ${did}:`, error);
    return null;
  }
}

// Resolve a Leaflet publication at-uri to RSS URL and metadata
export async function resolvePublicationToRss(publicationUri: string, env: Env): Promise<ResolvedPublication | null> {
  const parsed = parseAtUri(publicationUri);
  if (!parsed || parsed.collection !== 'pub.leaflet.publication') {
    console.error(`Invalid Leaflet publication URI: ${publicationUri}`);
    return null;
  }

  // Resolve DID to get the handle (which is the subdomain for Leaflet)
  const handle = await resolveDidToHandle(parsed.did, env);
  if (!handle) {
    console.error(`Could not resolve handle for DID: ${parsed.did}`);
    return null;
  }

  // For Leaflet, the handle should be something like "subdomain.leaflet.pub"
  // The RSS feed is at https://subdomain.leaflet.pub/rss
  if (!handle.endsWith('.leaflet.pub')) {
    console.warn(`Handle ${handle} doesn't appear to be a Leaflet publication`);
  }

  const siteUrl = `https://${handle}`;
  const rssUrl = `${siteUrl}/rss`;

  // Validate that the RSS feed actually exists before returning
  try {
    const rssResponse = await fetch(rssUrl, { method: 'HEAD' });
    if (!rssResponse.ok) {
      console.error(`RSS feed not found at ${rssUrl}: ${rssResponse.status}`);
      return null;
    }
    const contentType = rssResponse.headers.get('content-type') || '';
    if (!contentType.includes('xml') && !contentType.includes('rss')) {
      console.error(`Invalid RSS content type at ${rssUrl}: ${contentType}`);
      return null;
    }
  } catch (error) {
    console.error(`Failed to validate RSS feed at ${rssUrl}:`, error);
    return null;
  }

  // Use the subdomain as the title, or the full handle for custom domains
  const title = handle.endsWith('.leaflet.pub')
    ? handle.replace('.leaflet.pub', '')
    : handle;

  return {
    rssUrl,
    title,
    siteUrl,
  };
}

// Make authenticated GET request to user's PDS
async function makePdsGetRequest<T>(
  session: Session,
  endpoint: string,
  params: Record<string, string>
): Promise<{ ok: boolean; data: T; status: number }> {
  const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
  const privateKey = await importPrivateKey(privateKeyJwk);
  const publicKeyJwk = { ...privateKeyJwk };
  delete (publicKeyJwk as Record<string, unknown>).d;

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

// Fetch all Leaflet subscriptions from user's PDS
export async function fetchLeafletSubscriptions(session: Session): Promise<LeafletSubscription[]> {
  const subscriptions: LeafletSubscription[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      repo: session.did,
      collection: 'pub.leaflet.graph.subscription',
      limit: '100',
    };
    if (cursor) {
      params.cursor = cursor;
    }

    const response = await makePdsGetRequest<{
      records: Array<{
        uri: string;
        cid: string;
        value: {
          publication: string;
          createdAt?: string;
        };
      }>;
      cursor?: string;
    }>(session, 'com.atproto.repo.listRecords', params);

    if (!response.ok) {
      console.error('Failed to fetch Leaflet subscriptions:', response.data);
      break;
    }

    subscriptions.push(...response.data.records.map(r => ({
      uri: r.uri,
      cid: r.cid,
      value: r.value,
    })));

    cursor = response.data.cursor;
  } while (cursor);

  return subscriptions;
}
