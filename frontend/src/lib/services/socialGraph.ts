// Client-side social-graph + publication discovery for /discover.
//
// Everything here runs in the browser against public, CORS-enabled endpoints —
// no backend round-trip:
//   - follows:        app.bsky.graph.getFollows on the public AppView (paged)
//   - PDS resolution: plc.directory (did:plc) or the domain's did.json (did:web)
//   - publications:   com.atproto.repo.listRecords on the follow's own PDS
//
// Results are cached in IndexedDB (see db.ts: `follows`, `followingPublications`)
// so repeat visits are instant and we only scan accounts we haven't seen yet.
// Best-effort throughout: an account whose PDS won't resolve or whose PDS blocks
// CORS is silently skipped — discovery is an adornment, never load-bearing.

import type { FollowingPublication } from '$lib/types';
import { LINKBLOG_MARKER_URL } from '$lib/utils/linkPost';

const APPVIEW_BASE = 'https://public.api.bsky.app';
const PLC_DIRECTORY = 'https://plc.directory';
const PUBLICATION_COLLECTION = 'site.standard.publication';
// A Skyreader linkblog is surfaced in the Linkblogs section, so it's excluded
// here to avoid listing the same account twice on /discover. The marker is the
// durable tell: publications minted since the TID change each sit at their own
// rkey, so the fixed one only identifies the ones created before it.
const LEGACY_LINKBLOG_RKEY = 'skyreader-links';

function isSkyreaderLinkblog(uri: string, value: PublicationRecord): boolean {
  return value.skyreaderLinkblog === LINKBLOG_MARKER_URL || rkeyOf(uri) === LEGACY_LINKBLOG_RKEY;
}

export interface FollowLite {
  did: string;
  handle: string | null;
  displayName?: string;
  avatar?: string;
  // Their Bluesky bio: where links to their blog or newsletter usually are.
  description?: string;
}

interface GetFollowsResponse {
  follows?: Array<{
    did: string;
    handle?: string;
    displayName?: string;
    avatar?: string;
    description?: string;
  }>;
  cursor?: string;
}

/**
 * One page of accounts `actor` follows on Bluesky (100 at a time), threading the
 * AppView's opaque cursor back so callers can page at their own pace — the store
 * persists page 1 immediately, then backfills the rest in the background. An
 * absent cursor (or empty page) means the graph is exhausted. Returns an empty
 * page with no cursor on error.
 */
export async function fetchFollowsPage(
  actor: string,
  cursor?: string
): Promise<{ follows: FollowLite[]; cursor?: string }> {
  const params = new URLSearchParams({ actor, limit: '100' });
  if (cursor) params.set('cursor', cursor);

  let data: GetFollowsResponse | null = null;
  try {
    const res = await fetch(`${APPVIEW_BASE}/xrpc/app.bsky.graph.getFollows?${params}`);
    if (res.ok) data = (await res.json()) as GetFollowsResponse;
  } catch (e) {
    console.error('[socialGraph] getFollows error:', e);
  }
  if (!data?.follows?.length) return { follows: [] };

  const follows = data.follows.map((f) => ({
    did: f.did,
    handle: f.handle ?? null,
    displayName: f.displayName,
    avatar: f.avatar,
    // Always a string once fetched, so a row cached before bios were kept
    // (undefined) can be told from one with an empty bio.
    description: f.description ?? '',
  }));
  return { follows, cursor: data.cursor };
}

interface DidService {
  id: string;
  type: string;
  serviceEndpoint: string;
}
interface DidDocument {
  service?: DidService[];
}

function pdsFromDoc(doc: DidDocument): string | null {
  const svc = doc.service?.find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
  );
  return svc?.serviceEndpoint ?? null;
}

/** Resolve a DID to its PDS endpoint (did:plc via plc.directory, did:web via did.json). */
export async function resolvePdsUrl(did: string): Promise<string | null> {
  try {
    if (did.startsWith('did:plc:')) {
      const res = await fetch(`${PLC_DIRECTORY}/${did}`);
      if (!res.ok) return null;
      return pdsFromDoc((await res.json()) as DidDocument);
    }
    if (did.startsWith('did:web:')) {
      const domain = did.slice('did:web:'.length);
      const res = await fetch(`https://${domain}/.well-known/did.json`);
      if (!res.ok) return null;
      return pdsFromDoc((await res.json()) as DidDocument);
    }
  } catch (e) {
    console.error(`[socialGraph] PDS resolve failed for ${did}:`, e);
  }
  return null;
}

interface PublicationRecord {
  name?: string;
  url?: string;
  description?: string;
  icon?: { ref?: { $link?: string } };
  // Skyreader's provenance marker on the publications it creates.
  skyreaderLinkblog?: string;
}
function rkeyOf(uri: string): string {
  return uri.split('/').pop() || '';
}

async function listRecords<T>(pdsUrl: string, did: string, collection: string): Promise<T[]> {
  try {
    const params = new URLSearchParams({ repo: did, collection, limit: '100' });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (!res.ok) return [];
    return ((await res.json()) as { records?: T[] }).records ?? [];
  } catch (e) {
    console.error(`[socialGraph] listRecords ${collection} failed for ${did}:`, e);
    return [];
  }
}

function publicationsOf(
  follow: FollowLite,
  records: Array<{ uri: string; value: PublicationRecord }>
): FollowingPublication[] {
  const out: FollowingPublication[] = [];
  for (const record of records) {
    const value = record.value || {};
    if (isSkyreaderLinkblog(record.uri, value)) continue;

    let iconUrl: string | undefined;
    if (value.icon?.ref?.$link) {
      iconUrl = `https://cdn.bsky.app/img/feed_thumbnail/plain/${follow.did}/${value.icon.ref.$link}@jpeg`;
    }

    out.push({
      did: follow.did,
      handle: follow.handle,
      displayName: follow.displayName,
      avatar: follow.avatar,
      publicationUri: record.uri,
      name: value.name || value.url || 'Publication',
      description: value.description,
      iconUrl,
      url: value.url || '',
    });
  }
  return out;
}

/**
 * A website someone lists on their own profile, as a record on their PDS:
 *  - `bluesky`: the links under a Bluesky bio, `app.bsky.actor.link` records
 *    that the profile record's `links` lists (in display order; a record it
 *    doesn't list isn't shown, so isn't kept).
 *  - `sifa`: `id.sifa.profile.externalAccount` records from a Sifa profile
 *    (sifa.id, a professional profile on the Atmosphere), only the kinds that
 *    can be a blog (not a GitHub or LinkedIn account), with any feed they name.
 */
export interface ProfileLink {
  source: 'bluesky' | 'sifa';
  url: string;
  feedUrl?: string;
  label?: string;
}

const BSKY_LINK_COLLECTION = 'app.bsky.actor.link';
const SIFA_LINK_COLLECTION = 'id.sifa.profile.externalAccount';
const SIFA_BLOG_PLATFORMS = new Set([
  'id.sifa.defs#platformRss',
  'id.sifa.defs#platformWebsite',
  'id.sifa.defs#platformOther',
]);

const isWeb = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);
const labelOf = (l: unknown): string | undefined =>
  typeof l === 'string' ? l.trim() || undefined : undefined;

interface SifaLinkRecord {
  value?: { platform?: string; url?: string; feedUrl?: string; label?: string };
}

function sifaLinksOf(records: SifaLinkRecord[]): ProfileLink[] {
  const out: ProfileLink[] = [];
  for (const { value } of records) {
    if (!value?.platform || !SIFA_BLOG_PLATFORMS.has(value.platform) || !isWeb(value.url)) continue;
    out.push({
      source: 'sifa',
      url: value.url,
      feedUrl: isWeb(value.feedUrl) ? value.feedUrl : undefined,
      label: labelOf(value.label),
    });
  }
  return out;
}

interface BskyLinkRecord {
  uri: string;
  value?: { url?: string; title?: string };
}

async function bskyLinksOf(pdsUrl: string, did: string): Promise<ProfileLink[]> {
  // Cheap check first: most profiles have no links, and then there's no list
  // to read.
  let shown: string[] = [];
  try {
    const params = new URLSearchParams({
      repo: did,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
    });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (!res.ok) return [];
    const profile = (await res.json()) as { value?: { links?: Array<{ uri?: unknown }> } };
    const links = profile.value?.links;
    if (!Array.isArray(links)) return [];
    shown = links.map((l) => l?.uri).filter((u): u is string => typeof u === 'string');
  } catch (e) {
    console.error(`[socialGraph] profile read failed for ${did}:`, e);
    return [];
  }
  if (shown.length === 0) return [];

  const byUri = new Map(
    (await listRecords<BskyLinkRecord>(pdsUrl, did, BSKY_LINK_COLLECTION)).map((r) => [r.uri, r])
  );
  const out: ProfileLink[] = [];
  for (const uri of shown) {
    const value = byUri.get(uri)?.value;
    if (!isWeb(value?.url)) continue;
    out.push({ source: 'bluesky', url: value.url, label: labelOf(value.title) });
  }
  return out;
}

/**
 * Read one followed account's PDS for what discovery needs: their standard.site
 * publications (minus their Skyreader linkblog) and the websites on their
 * Bluesky and Sifa profiles. All empty on any failure (unresolved PDS, CORS
 * block, network error) — never throws.
 */
export async function scanFollow(
  follow: FollowLite
): Promise<{ publications: FollowingPublication[]; profileLinks: ProfileLink[] }> {
  const pdsUrl = await resolvePdsUrl(follow.did);
  if (!pdsUrl) return { publications: [], profileLinks: [] };
  const [publications, bsky, sifa] = await Promise.all([
    listRecords<{ uri: string; value: PublicationRecord }>(
      pdsUrl,
      follow.did,
      PUBLICATION_COLLECTION
    ),
    bskyLinksOf(pdsUrl, follow.did),
    listRecords<SifaLinkRecord>(pdsUrl, follow.did, SIFA_LINK_COLLECTION),
  ]);
  return {
    publications: publicationsOf(follow, publications),
    profileLinks: [...bsky, ...sifaLinksOf(sifa)],
  };
}

/** Just the standard.site publications of one followed account (see scanFollow). */
export async function scanPublications(follow: FollowLite): Promise<FollowingPublication[]> {
  return (await scanFollow(follow)).publications;
}
