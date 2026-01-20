import type { Session } from '../types';
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

// Resolve a DID to get its handle from the DID document
async function resolveDidToHandle(did: string): Promise<string | null> {
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
    if (didDoc.alsoKnownAs && didDoc.alsoKnownAs.length > 0) {
      for (const aka of didDoc.alsoKnownAs) {
        if (aka.startsWith('at://')) {
          return aka.replace('at://', '');
        }
      }
    }

    return null;
  } catch (error) {
    console.error(`Error resolving DID ${did}:`, error);
    return null;
  }
}

// Resolve a Leaflet publication at-uri to RSS URL and metadata
export async function resolvePublicationToRss(publicationUri: string): Promise<ResolvedPublication | null> {
  const parsed = parseAtUri(publicationUri);
  if (!parsed || parsed.collection !== 'pub.leaflet.publication') {
    console.error(`Invalid Leaflet publication URI: ${publicationUri}`);
    return null;
  }

  // Resolve DID to get the handle (which is the subdomain for Leaflet)
  const handle = await resolveDidToHandle(parsed.did);
  if (!handle) {
    console.error(`Could not resolve handle for DID: ${parsed.did}`);
    return null;
  }

  // For Leaflet, the handle should be something like "subdomain.leaflet.pub"
  // The RSS feed is at https://subdomain.leaflet.pub/rss
  if (!handle.endsWith('.leaflet.pub')) {
    console.warn(`Handle ${handle} doesn't appear to be a Leaflet publication`);
    // Still try to construct the URL - it might work
  }

  const siteUrl = `https://${handle}`;
  const rssUrl = `${siteUrl}/rss`;

  // Optionally fetch the publication record to get the title
  // For now, just use the subdomain as the title
  const subdomain = handle.replace('.leaflet.pub', '');

  return {
    rssUrl,
    title: subdomain,
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
