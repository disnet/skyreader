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

// Resolve a DID to get its PDS URL
async function resolveDidToPds(did: string): Promise<string | null> {
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
      service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
    };

    // Find the AtprotoPersonalDataServer service
    if (didDoc.service) {
      for (const svc of didDoc.service) {
        if (svc.type === 'AtprotoPersonalDataServer') {
          return svc.serviceEndpoint;
        }
      }
    }

    console.error(`No PDS service found for DID ${did}`);
    return null;
  } catch (error) {
    console.error(`Error resolving DID ${did}:`, error);
    return null;
  }
}

// Leaflet publication record structure
interface LeafletPublication {
  $type: string;
  name?: string;
  description?: string;
  base_path?: string;
}

// Fetch a Leaflet publication record from a PDS
async function fetchPublicationRecord(
  pdsUrl: string,
  did: string,
  rkey: string
): Promise<LeafletPublication | null> {
  try {
    const url = `${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=pub.leaflet.publication&rkey=${rkey}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`Failed to fetch publication record: ${response.status}`);
      return null;
    }

    const data = await response.json() as { value: LeafletPublication };
    return data.value;
  } catch (error) {
    console.error(`Error fetching publication record:`, error);
    return null;
  }
}

// Resolve a Leaflet publication at-uri to RSS URL and metadata
export async function resolvePublicationToRss(publicationUri: string, _env: Env): Promise<ResolvedPublication | null> {
  const parsed = parseAtUri(publicationUri);
  if (!parsed || parsed.collection !== 'pub.leaflet.publication') {
    console.error(`Invalid Leaflet publication URI: ${publicationUri}`);
    return null;
  }

  // 1. Resolve DID to get the PDS URL
  const pdsUrl = await resolveDidToPds(parsed.did);
  if (!pdsUrl) {
    console.error(`Could not resolve PDS for DID: ${parsed.did}`);
    return null;
  }

  // 2. Fetch the publication record from the PDS
  const publication = await fetchPublicationRecord(pdsUrl, parsed.did, parsed.rkey);
  if (!publication) {
    console.error(`Could not fetch publication record: ${publicationUri}`);
    return null;
  }

  // 3. Get the base_path (the Leaflet subdomain)
  if (!publication.base_path) {
    console.error(`Publication has no base_path: ${publicationUri}`);
    return null;
  }

  const siteUrl = `https://${publication.base_path}`;
  const rssUrl = `${siteUrl}/rss`;

  // 4. Validate that the RSS feed actually exists
  try {
    const rssResponse = await fetch(rssUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Skyreader/1.0' },
    });
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

  // Use the publication name as title, fallback to subdomain
  const title = publication.name ||
    publication.base_path.replace('.leaflet.pub', '');

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
