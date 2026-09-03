// Reading Rooms (spike) — client-side membership aggregation.
//
// A room IS a Semble/Margin collection; joining writes a public
// app.skyreader.reading.readAlong record to the joiner's own repo. Membership is
// aggregated here via Constellation backlink queries (same pattern as the
// @mention inbox: zero backend index, reflects deletes). The room's article list
// and read counts come from the backend (/api/rooms); this module answers "who
// joined" and "which rooms have I joined".
// See docs/plans/READING_ROOMS_SPIKE.md.

import { resolvePdsUrl } from '$lib/services/socialGraph';

const CONSTELLATION_BASE = 'https://constellation.microcosm.blue';
export const READ_ALONG_NSID = 'app.skyreader.reading.readAlong';
const SUBJECT_PATH = '.subject';
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { did: m[1], collection: m[2], rkey: m[3] };
}

/** DIDs with a live readAlong record pointing at this collection. */
export async function fetchRoomMembers(collectionUri: string): Promise<string[]> {
  const dids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      target: collectionUri,
      collection: READ_ALONG_NSID,
      path: SUBJECT_PATH,
      limit: String(PAGE_LIMIT),
    });
    if (cursor) params.set('cursor', cursor);
    let data: { linking_dids?: string[]; cursor?: string } | null = null;
    try {
      const res = await fetch(`${CONSTELLATION_BASE}/links/distinct-dids?${params}`);
      if (!res.ok) break;
      data = (await res.json()) as { linking_dids?: string[]; cursor?: string };
    } catch {
      break;
    }
    for (const did of data.linking_dids ?? []) dids.push(did);
    if (!data.cursor || (data.linking_dids ?? []).length === 0) break;
    cursor = data.cursor;
  }
  return [...new Set(dids)];
}

export interface MyRoom {
  /** the readAlong record's at-uri (delete target) */
  recordUri: string;
  /** the collection at-uri (the room's identity) */
  subject: string;
  createdAt?: string;
}

/** The rooms this user has joined — their own readAlong records, read publicly
 *  from their own PDS (no session needed for reads). */
export async function fetchMyRooms(did: string, pdsUrl: string): Promise<MyRoom[]> {
  const params = new URLSearchParams({
    repo: did,
    collection: READ_ALONG_NSID,
    limit: '100',
  });
  try {
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      records?: Array<{ uri: string; value?: { subject?: string; createdAt?: string } }>;
    };
    return (data.records ?? [])
      .filter((r) => typeof r.value?.subject === 'string')
      .map((r) => ({
        recordUri: r.uri,
        subject: r.value!.subject!,
        createdAt: r.value?.createdAt,
      }));
  } catch {
    return [];
  }
}

/** Title of a collection, fetched publicly from its owner's PDS (for the
 *  your-rooms list, where hitting /api/rooms per room would be heavy). */
export async function fetchCollectionName(collectionUri: string): Promise<string | null> {
  const ref = parseAtUri(collectionUri);
  if (!ref) return null;
  try {
    const pds = await resolvePdsUrl(ref.did);
    if (!pds) return null;
    const params = new URLSearchParams({
      repo: ref.did,
      collection: ref.collection,
      rkey: ref.rkey,
    });
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: { name?: string } };
    return typeof data.value?.name === 'string' ? data.value.name : null;
  } catch {
    return null;
  }
}

const SEMBLE_COLLECTION_NSID = 'network.cosmik.collection';

async function resolveHandleToDid(handle: string): Promise<string | null> {
  if (handle.startsWith('did:')) return handle;
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { did?: string };
    return data.did ?? null;
  } catch {
    return null;
  }
}

/** A semble.so collection page (https://semble.so/profile/<handle>/collections/<rkey>)
 *  → the collection's at-uri, resolving the profile handle to a DID. */
async function sembleCollectionPageToUri(url: URL): Promise<string | null> {
  if (url.hostname !== 'semble.so') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'profile' || parts[2] !== 'collections') return null;
  const did = await resolveHandleToDid(decodeURIComponent(parts[1]));
  if (!did) return null;
  return `at://${did}/${SEMBLE_COLLECTION_NSID}/${parts[3]}`;
}

/** Accepts a pasted room link (/rooms?uri=…), a semble.so collection page, or a
 *  bare collection at-uri. */
export async function resolveRoomInput(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('at://')) return parseAtUri(trimmed) ? trimmed : null;
  try {
    const url = new URL(trimmed);
    const uri = url.searchParams.get('uri');
    if (uri && uri.startsWith('at://') && parseAtUri(uri)) return uri;
    return await sembleCollectionPageToUri(url);
  } catch {
    return null;
  }
}
