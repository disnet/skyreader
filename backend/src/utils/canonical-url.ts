/**
 * Resolving a standard.site publication from an AT URI.
 *
 * This file used to also build canonical URLs for `site.standard.document`
 * records, backed by a D1 `publications_cache`. Both moved to the feed proxy when
 * documents went to on-demand fetch (`buildCanonicalUrl` / `resolveSiteMeta` in
 * `feed-proxy/src/standard-site.ts`), so what's left here is the discovery path:
 * turn an at:// URI advertised by a website into a domain-verified, subscribable
 * publication.
 */

import type { Env } from '../types';
import { resolvePdsUrl } from './did-resolver';

interface ParsedAtUri {
  did: string;
  collection: string;
  rkey: string;
}

interface BlobRef {
  ref: { $link: string };
  mimeType: string;
}

interface PublicationRecord {
  $type: string;
  url: string;
  name?: string;
  description?: string;
  icon?: BlobRef;
}

/**
 * Resolve a blob reference to a CDN URL
 * Uses the Bluesky CDN format: https://cdn.bsky.app/img/feed_thumbnail/plain/{did}/{cid}@jpeg
 */
function resolveBlobUrl(did: string, blob: BlobRef | undefined): string | null {
  if (!blob?.ref?.$link) {
    return null;
  }
  // Use Bluesky's CDN for blob URLs
  return `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${blob.ref.$link}@jpeg`;
}

/**
 * Parse an AT URI into its components
 * Format: at://did/collection/rkey
 */
export function parseAtUri(uri: string): ParsedAtUri | null {
  if (!uri.startsWith('at://')) {
    return null;
  }

  const withoutPrefix = uri.slice(5); // Remove 'at://'
  const parts = withoutPrefix.split('/');

  if (parts.length < 3) {
    return null;
  }

  const did = parts[0];
  const collection = parts[1];
  const rkey = parts.slice(2).join('/'); // rkey might contain slashes

  if (!did.startsWith('did:')) {
    return null;
  }

  return { did, collection, rkey };
}

/**
 * Fetch a publication record from the author's PDS
 */
async function fetchPublicationRecord(
  pdsUrl: string,
  did: string,
  collection: string,
  rkey: string
): Promise<PublicationRecord | null> {
  try {
    const params = new URLSearchParams({
      repo: did,
      collection,
      rkey,
    });

    const response = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (!response.ok) {
      console.warn(`[canonical-url] Failed to fetch publication record: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { value: PublicationRecord };
    return data.value;
  } catch (error) {
    console.error('[canonical-url] Error fetching publication record:', error);
    return null;
  }
}

/**
 * A standard.site discovered from a website and verified against its domain,
 * resolved into a subscribable AT Protocol publication.
 */
export interface ResolvedStandardSite {
  /** DID whose repo holds the site.standard.document records to subscribe to */
  did: string;
  /**
   * The verified publication AT URI (at://did/site.standard.publication/rkey),
   * used as the subscription's feedUrl.
   */
  publicationUri: string;
  name: string;
  url?: string;
  description?: string;
  iconUrl?: string;
}

/**
 * Verify a publication against its domain via the standard.site .well-known
 * endpoint.
 *
 * Per https://standard.site/docs/verification, the <link> hint in a page's HTML
 * must not be trusted on its own. Verification is a bidirectional consistency
 * check: the publication record claims a domain (its `url`), and that domain must
 * claim the same publication back via /.well-known/site.standard.publication.
 *
 * Returns true only when the well-known endpoint at `publicationUrl`'s origin
 * returns the `expectedUri` (the publication AT URI we resolved).
 */
async function verifyPublicationDomain(
  publicationUrl: string,
  expectedUri: string
): Promise<boolean> {
  try {
    const origin = new URL(publicationUrl).origin;
    const res = await fetch(`${origin}/.well-known/site.standard.publication`, {
      headers: { Accept: 'application/json, text/plain, */*' },
      redirect: 'follow',
    });
    if (!res.ok) {
      return false;
    }
    // The endpoint may return a bare AT URI or a JSON object containing one.
    const body = (await res.text()).trim();
    const advertisedUri = body.match(/at:\/\/[^\s"']+/)?.[0];
    return advertisedUri === expectedUri;
  } catch (error) {
    console.warn('[canonical-url] Publication domain verification failed:', error);
    return false;
  }
}

/**
 * Resolve + verify a site.standard.publication URI into a subscribable publication.
 *
 * Fetches the publication record and confirms the bidirectional binding against
 * the domain's /.well-known/site.standard.publication endpoint (per the
 * standard.site spec — the HTML hint alone is not trusted). Returns null when the
 * record has no URL or verification fails.
 */
async function resolveVerifiedPublication(
  publicationUri: string
): Promise<ResolvedStandardSite | null> {
  const pub = parseAtUri(publicationUri);
  if (!pub || pub.collection !== 'site.standard.publication') {
    return null;
  }

  const pdsUrl = await resolvePdsUrl(pub.did);
  if (!pdsUrl) {
    return null;
  }

  const record = await fetchPublicationRecord(pdsUrl, pub.did, pub.collection, pub.rkey);
  if (!record?.url) {
    return null;
  }

  // Confirm the bidirectional binding before trusting the hint.
  const verified = await verifyPublicationDomain(record.url, publicationUri);
  if (!verified) {
    console.warn(`[canonical-url] Unverified standard.site, not offering: ${publicationUri}`);
    return null;
  }

  return {
    did: pub.did,
    publicationUri,
    name: record.name || record.url,
    url: record.url,
    description: record.description,
    iconUrl: resolveBlobUrl(pub.did, record.icon) || undefined,
  };
}

/**
 * Resolve a discovered standard.site URI into a *verified*, subscribable
 * publication.
 *
 * Accepts either of the at:// URIs advertised in a website's <link> hint:
 * - `at://did/site.standard.publication/rkey` (publication homepages) — used
 *   directly.
 * - `at://did/site.standard.document/rkey` (article pages) — the document record
 *   is fetched and its `site` field followed to the owning publication.
 *
 * In both cases the resolved publication is verified against its domain's
 * /.well-known/site.standard.publication endpoint (per the standard.site spec).
 *
 * Returns the publication's name/url/icon (so the frontend can create an
 * `atproto.documents` subscription) only when verification succeeds, otherwise
 * null. Documents without a verifiable publication (freestanding or loose
 * https:// sites) cannot be tied back to the domain and are not offered.
 */
export async function resolveStandardSite(
  uri: string,
  _env: Env
): Promise<ResolvedStandardSite | null> {
  const parsed = parseAtUri(uri);
  if (!parsed) {
    return null;
  }

  // Publication homepages advertise the publication directly.
  if (parsed.collection === 'site.standard.publication') {
    return resolveVerifiedPublication(uri);
  }

  if (parsed.collection !== 'site.standard.document') {
    return null;
  }

  const doc = parsed;
  const pdsUrl = await resolvePdsUrl(doc.did);
  if (!pdsUrl) {
    return null;
  }

  let site: string | undefined;
  try {
    const params = new URLSearchParams({
      repo: doc.did,
      collection: doc.collection,
      rkey: doc.rkey,
    });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (res.ok) {
      const data = (await res.json()) as { value?: { site?: string } };
      site = data.value?.site;
    }
  } catch (error) {
    console.error('[canonical-url] Error fetching document record:', error);
  }

  // Only at:// publications can be verified against a domain. Loose https://
  // sites and freestanding documents have no well-known binding, so we don't
  // offer them from URL discovery.
  if (!site || !site.startsWith('at://')) {
    return null;
  }

  const resolved = await resolveVerifiedPublication(site);
  if (!resolved) {
    return null;
  }

  // Subscribe to the document author's repo (which holds the documents we
  // discovered), not the publication owner's — these differ for loose documents.
  return { ...resolved, did: doc.did };
}
