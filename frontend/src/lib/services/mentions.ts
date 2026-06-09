// Client-side @mention notifications, sourced live from Constellation.
//
// The browser queries Constellation (the network-wide atproto backlink index)
// for `site.standard.document` records carrying a
// `pub.leaflet.richtext.facet#didMention` facet that targets the logged-in
// user's DID, then enriches each with the author's profile and the post's
// title/URL via public, unauthenticated reads.
//
// Why client-side: Constellation is public + CORS-open, so each user polls only
// their own DID — load scales by construction with active users, and historical
// mentions (authored before signup) surface through the same query as new ones.
// Read-state is local (see stores/notifications.svelte.ts).

import { profileService } from './profiles';

const CONSTELLATION_BASE = 'https://constellation.microcosm.blue';
const DOC_COLLECTION = 'site.standard.document';
const PUBLICATION_COLLECTION = 'site.standard.publication';
const MENTION_FACET_TYPE = 'pub.leaflet.richtext.facet#didMention';

// Bounds — keep a poll cheap and the badge from a runaway history.
const MAX_PATHS = 8;
const RECORDS_PER_PATH = 50;
const MAX_MENTIONS = 50;

// A mention as discovered from the index — cheap to fetch (no enrichment), so
// this is what the badge poll resolves.
export interface MentionSource {
  /** at://author/site.standard.document/rkey */
  sourceUri: string;
  actorDid: string;
  rkey: string;
}

// A mention ready to display, after resolving the author profile + post.
export interface EnrichedMention extends MentionSource {
  actorHandle: string | null;
  actorDisplayName: string | null;
  actorAvatar: string | null;
  title: string | null;
  canonicalUrl: string | null;
  createdAt: number;
}

interface LinksAllResponse {
  links?: Record<string, Record<string, { records?: number }>>;
}
interface LinksResponse {
  linking_records?: Array<{ did: string; collection: string; rkey: string }>;
}

async function constellationGet<T>(
  path: string,
  params: Record<string, string>
): Promise<T | null> {
  try {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${CONSTELLATION_BASE}${path}?${qs}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Discover the documents that @mention `myDid`, newest pages first. Cheap: only
 * the index calls, no per-record enrichment — suitable for badge polling.
 */
export async function fetchMentionSources(myDid: string): Promise<MentionSource[]> {
  const all = await constellationGet<LinksAllResponse>('/links/all', { target: myDid });
  const docPaths = all?.links?.[DOC_COLLECTION];
  if (!docPaths) return [];

  // The didMention DID can sit at several JSON paths depending on the block type
  // (text / header / list item); take every path that ends in a didMention.
  const mentionPaths = Object.keys(docPaths)
    .filter((p) => p.includes(`features[${MENTION_FACET_TYPE}].did`))
    .slice(0, MAX_PATHS);
  if (mentionPaths.length === 0) return [];

  const seen = new Set<string>();
  const sources: MentionSource[] = [];
  for (const path of mentionPaths) {
    if (sources.length >= MAX_MENTIONS) break;
    const links = await constellationGet<LinksResponse>('/links', {
      target: myDid,
      collection: DOC_COLLECTION,
      path,
      limit: String(RECORDS_PER_PATH),
    });
    for (const rec of links?.linking_records ?? []) {
      if (rec.did === myDid) continue; // ignore self-mentions
      const sourceUri = `at://${rec.did}/${DOC_COLLECTION}/${rec.rkey}`;
      if (seen.has(sourceUri)) continue;
      seen.add(sourceUri);
      sources.push({ sourceUri, actorDid: rec.did, rkey: rec.rkey });
      if (sources.length >= MAX_MENTIONS) break;
    }
  }
  return sources;
}

// ── Public-read resolution (DID → PDS → record), all CORS-open ───────────────

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { did: m[1], collection: m[2], rkey: m[3] };
}

const pdsCache = new Map<string, string | null>();

async function resolvePdsUrl(did: string): Promise<string | null> {
  if (pdsCache.has(did)) return pdsCache.get(did)!;
  let endpoint: string | null = null;
  try {
    if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${did}`);
      if (res.ok) {
        const doc = (await res.json()) as {
          service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
        };
        endpoint =
          doc.service?.find(
            (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
          )?.serviceEndpoint || null;
      }
    } else if (did.startsWith('did:web:')) {
      const domain = did.replace('did:web:', '');
      const res = await fetch(`https://${domain}/.well-known/did.json`);
      if (res.ok) {
        const doc = (await res.json()) as {
          service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
        };
        endpoint =
          doc.service?.find(
            (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
          )?.serviceEndpoint || null;
      }
    }
  } catch {
    endpoint = null;
  }
  pdsCache.set(did, endpoint);
  return endpoint;
}

async function getRecord<T>(did: string, collection: string, rkey: string): Promise<T | null> {
  const pds = await resolvePdsUrl(did);
  if (!pds) return null;
  try {
    const url =
      `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}` +
      `&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: T };
    return data.value ?? null;
  } catch {
    return null;
  }
}

const pubUrlCache = new Map<string, string | null>();

// Resolve a document's `site` field to a public base URL. `site` is either an
// at:// publication URI (fetch the record's `url`) or already an https:// URL.
async function resolvePublicationUrl(siteUri: string): Promise<string | null> {
  if (!siteUri) return null;
  if (siteUri.startsWith('http://') || siteUri.startsWith('https://')) return siteUri;
  if (pubUrlCache.has(siteUri)) return pubUrlCache.get(siteUri)!;

  let url: string | null = null;
  const parsed = parseAtUri(siteUri);
  if (parsed && parsed.collection === PUBLICATION_COLLECTION) {
    const pub = await getRecord<{ url?: string }>(parsed.did, parsed.collection, parsed.rkey);
    url = pub?.url ?? null;
  }
  pubUrlCache.set(siteUri, url);
  return url;
}

function buildCanonicalUrl(base: string, path: string): string {
  if (!base) return path || '';
  if (!path) return base;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

interface DocumentValue {
  title?: string;
  site?: string;
  path?: string;
  createdAt?: string;
  publishedAt?: string;
}

/**
 * Resolve a discovered mention into a displayable item: author profile (cached,
 * batched via profileService) plus the post's title and canonical URL. Degrades
 * to nulls when a PDS or the index is unreachable — the mention still renders.
 */
export async function enrichMention(src: MentionSource): Promise<EnrichedMention> {
  const [doc, profile] = await Promise.all([
    getRecord<DocumentValue>(src.actorDid, DOC_COLLECTION, src.rkey),
    profileService.getProfile(src.actorDid),
  ]);

  let title: string | null = null;
  let canonicalUrl: string | null = null;
  // 0, not Date.now(): the list sorts newest-first on createdAt, so an undated or
  // unresolvable doc must sink to the bottom deterministically. Falling back to
  // "now" would float it to the top — and with a value that changes every poll.
  let createdAt = 0;
  if (doc) {
    title = typeof doc.title === 'string' ? doc.title : null;
    // Prefer createdAt (the post's share time); external standard.site docs often
    // carry only publishedAt, so fall back to it before giving up (→ 0). Matches
    // feedView's `createdAt || publishedAt` ordering for linkblog documents.
    const dateStr =
      typeof doc.createdAt === 'string'
        ? doc.createdAt
        : typeof doc.publishedAt === 'string'
          ? doc.publishedAt
          : null;
    if (dateStr) {
      const ms = new Date(dateStr).getTime();
      if (!Number.isNaN(ms)) createdAt = ms;
    }
    const base = await resolvePublicationUrl(typeof doc.site === 'string' ? doc.site : '');
    if (base) canonicalUrl = buildCanonicalUrl(base, typeof doc.path === 'string' ? doc.path : '');
  }

  return {
    ...src,
    actorHandle: profile?.handle ?? null,
    actorDisplayName: profile?.displayName ?? null,
    actorAvatar: profile?.avatar ?? null,
    title,
    canonicalUrl,
    createdAt,
  };
}
