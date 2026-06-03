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

const APPVIEW_BASE = 'https://public.api.bsky.app';
const PLC_DIRECTORY = 'https://plc.directory';
const PUBLICATION_COLLECTION = 'site.standard.publication';
// The Skyreader linkblog publication — surfaced in the Linkblogs section, so we
// exclude it here to avoid listing the same account twice on /discover.
const LINKBLOG_RKEY = 'skyreader-links';

export interface FollowLite {
  did: string;
  handle: string | null;
  displayName?: string;
  avatar?: string;
}

interface GetFollowsResponse {
  follows?: Array<{ did: string; handle?: string; displayName?: string; avatar?: string }>;
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
}
interface ListRecordsResponse {
  records?: Array<{ uri: string; value: PublicationRecord }>;
}

function rkeyOf(uri: string): string {
  return uri.split('/').pop() || '';
}

/**
 * List one followed account's standard.site publications straight from their
 * PDS. Skips the Skyreader linkblog (skyreader-links). Returns [] on any
 * failure (unresolved PDS, CORS block, network error) — never throws.
 */
export async function scanPublications(follow: FollowLite): Promise<FollowingPublication[]> {
  const pdsUrl = await resolvePdsUrl(follow.did);
  if (!pdsUrl) return [];

  let data: ListRecordsResponse | null = null;
  try {
    const params = new URLSearchParams({
      repo: follow.did,
      collection: PUBLICATION_COLLECTION,
      limit: '100',
    });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (res.ok) data = (await res.json()) as ListRecordsResponse;
  } catch (e) {
    console.error(`[socialGraph] listRecords failed for ${follow.did}:`, e);
  }
  if (!data?.records) return [];

  const out: FollowingPublication[] = [];
  for (const record of data.records) {
    if (rkeyOf(record.uri) === LINKBLOG_RKEY) continue;
    const value = record.value || {};

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
