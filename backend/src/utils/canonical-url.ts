/**
 * Utility functions for resolving canonical URLs from site.standard.document records
 *
 * The `site` field in a document can be either:
 * 1. An `at://` URI pointing to a `site.standard.publication` record
 * 2. An `https://` URL for loose documents
 *
 * The canonical URL is constructed by resolving the publication's base URL
 * and combining it with the document's path.
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

// Cache TTL: 24 hours in milliseconds
const PUBLICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
 * Check the publications cache for a cached base URL
 */
async function getCachedPublicationUrl(publicationUri: string, env: Env): Promise<string | null> {
  try {
    const result = await env.DB.prepare(
      `SELECT base_url FROM publications_cache
			 WHERE publication_uri = ? AND expires_at > ?`
    )
      .bind(publicationUri, Date.now())
      .first<{ base_url: string }>();

    return result?.base_url || null;
  } catch (error) {
    console.error('[canonical-url] Error reading from publications cache:', error);
    return null;
  }
}

/**
 * Get the cached icon URL for a publication
 */
export async function getCachedPublicationIcon(
  publicationUri: string,
  env: Env
): Promise<string | null> {
  if (!publicationUri || !publicationUri.startsWith('at://')) {
    return null;
  }

  try {
    const result = await env.DB.prepare(
      `SELECT icon FROM publications_cache
			 WHERE publication_uri = ? AND expires_at > ?`
    )
      .bind(publicationUri, Date.now())
      .first<{ icon: string | null }>();

    return result?.icon || null;
  } catch (error) {
    console.error('[canonical-url] Error reading icon from publications cache:', error);
    return null;
  }
}

/**
 * Cache a publication's base URL and icon
 */
async function cachePublicationUrl(
  publicationUri: string,
  authorDid: string,
  baseUrl: string,
  name: string | null,
  description: string | null,
  icon: string | null,
  env: Env
): Promise<void> {
  try {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO publications_cache
			 (publication_uri, author_did, base_url, name, description, icon, cached_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(publication_uri) DO UPDATE SET
			   base_url = excluded.base_url,
			   name = excluded.name,
			   description = excluded.description,
			   icon = excluded.icon,
			   cached_at = excluded.cached_at,
			   expires_at = excluded.expires_at`
    )
      .bind(
        publicationUri,
        authorDid,
        baseUrl,
        name,
        description,
        icon,
        now,
        now + PUBLICATION_CACHE_TTL_MS
      )
      .run();
  } catch (error) {
    console.error('[canonical-url] Error caching publication:', error);
  }
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
 * Resolve a publication's base URL from an AT URI or HTTPS URL
 *
 * If siteUri is an `at://` URI pointing to a site.standard.publication,
 * fetches the publication record and returns its `url` field.
 * If siteUri is already an HTTPS URL, returns it directly.
 */
export async function resolvePublicationUrl(siteUri: string, env: Env): Promise<string | null> {
  if (!siteUri) {
    return null;
  }

  // If it's already an HTTPS URL, return it directly
  if (siteUri.startsWith('https://') || siteUri.startsWith('http://')) {
    return siteUri;
  }

  // Parse the AT URI
  const parsed = parseAtUri(siteUri);
  if (!parsed) {
    console.warn(`[canonical-url] Invalid AT URI: ${siteUri}`);
    return null;
  }

  // Check if it's a publication collection
  if (parsed.collection !== 'site.standard.publication') {
    console.warn(`[canonical-url] Unexpected collection: ${parsed.collection}`);
    return null;
  }

  // Check cache first
  const cachedUrl = await getCachedPublicationUrl(siteUri, env);
  if (cachedUrl) {
    return cachedUrl;
  }

  // Resolve PDS URL for the publication author
  const pdsUrl = await resolvePdsUrl(parsed.did);
  if (!pdsUrl) {
    console.warn(`[canonical-url] Could not resolve PDS for ${parsed.did}`);
    return null;
  }

  // Fetch the publication record
  const publication = await fetchPublicationRecord(
    pdsUrl,
    parsed.did,
    parsed.collection,
    parsed.rkey
  );
  if (!publication?.url) {
    console.warn(`[canonical-url] Publication has no URL: ${siteUri}`);
    return null;
  }

  // Resolve icon blob to URL
  const iconUrl = resolveBlobUrl(parsed.did, publication.icon);

  // Cache the result
  await cachePublicationUrl(
    siteUri,
    parsed.did,
    publication.url,
    publication.name || null,
    publication.description || null,
    iconUrl,
    env
  );

  return publication.url;
}

/**
 * Combine a base URL with a path, handling slash normalization
 */
export function buildCanonicalUrl(baseUrl: string, path: string): string {
  if (!baseUrl) {
    return path || '';
  }

  if (!path) {
    return baseUrl;
  }

  // Remove trailing slash from base URL
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Resolve a canonical URL from a site URI and path
 *
 * This is the main entry point for constructing canonical URLs from
 * site.standard.document records.
 *
 * @param siteUri - The site field from the document (at:// URI or https:// URL)
 * @param path - The path field from the document
 * @param env - The Cloudflare Workers environment
 * @returns The resolved canonical URL, or a fallback if resolution fails
 */
export async function resolveCanonicalUrl(
  siteUri: string,
  path: string,
  env: Env
): Promise<string> {
  // Try to resolve the publication URL
  const baseUrl = await resolvePublicationUrl(siteUri, env);

  if (baseUrl) {
    return buildCanonicalUrl(baseUrl, path);
  }

  // Fallback: if we couldn't resolve the publication, return path or empty string
  // This handles cases where the publication fetch fails or the site URI is invalid
  if (path) {
    console.warn(`[canonical-url] Could not resolve publication, falling back to path: ${path}`);
    return path;
  }

  console.warn(`[canonical-url] Could not resolve canonical URL for site=${siteUri}, path=${path}`);
  return '';
}
