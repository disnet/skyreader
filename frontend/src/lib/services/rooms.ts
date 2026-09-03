// Reading Rooms (spike) — client-side membership aggregation.
//
// A room IS a Semble/Margin collection; joining writes a public
// app.skyreader.reading.readAlong record to the joiner's own repo. Membership is
// aggregated here via Constellation backlink queries (same pattern as the
// @mention inbox: zero backend index, reflects deletes). The room's article list
// and read counts come from the backend (/api/rooms); this module answers "who
// joined" and "which rooms have I joined".
// See docs/plans/READING_ROOMS_SPIKE.md.

import { resolvePdsUrl, type FollowLite } from '$lib/services/socialGraph';
import { pdsForFollow, forgetFollowPds } from '$lib/services/followGraph';
import type { FollowedRoomEntry } from '$lib/services/db';

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

/** How many DIDs are reading along with this collection.
 *
 *  The count, not the people: the /rooms index shows a presence marker per row
 *  and has no avatars to fill, so this is one request per room instead of paging
 *  the DID list. Null (not 0) when the lookup fails, so a Constellation outage
 *  shows no marker rather than a confident "nobody is here". */
export async function fetchRoomMemberCount(collectionUri: string): Promise<number | null> {
  const params = new URLSearchParams({
    target: collectionUri,
    collection: READ_ALONG_NSID,
    path: SUBJECT_PATH,
  });
  try {
    const res = await fetch(`${CONSTELLATION_BASE}/links/count/distinct-dids?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { total?: unknown };
    return typeof data.total === 'number' ? data.total : null;
  } catch {
    return null;
  }
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

/**
 * The rooms one followed account has joined: their own readAlong records, read
 * publicly from their PDS.
 *
 * This is the discovery direction Constellation cannot answer. Constellation
 * indexes by target ("who joined THIS room"), so it can tell you about a room
 * you already have the uri for, but it cannot enumerate rooms. Walking the
 * follow graph asks the question the other way round, per repo, and stays
 * client-side: still no Jetstream index of the join NSID, still not the
 * deferred global directory, just the corner of it your own follows can see.
 *
 * Returns [] on any failure (unresolved PDS, CORS block, network error) and
 * never throws — discovery is an adornment, never load-bearing.
 */
export async function scanReadAlongs(follow: FollowLite): Promise<FollowedRoomEntry[]> {
  const pdsUrl = await pdsForFollow(follow.did);
  if (!pdsUrl) return [];

  const params = new URLSearchParams({
    repo: follow.did,
    collection: READ_ALONG_NSID,
    limit: '100',
  });
  interface ReadAlongRecords {
    records?: Array<{ uri: string; value?: { subject?: unknown; createdAt?: unknown } }>;
  }
  let data: ReadAlongRecords | null = null;
  try {
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (res.ok) {
      data = (await res.json()) as ReadAlongRecords;
    } else {
      // A moved account leaves a stale endpoint behind, and every scan against
      // it would quietly report "no rooms". Drop it and re-resolve next pass.
      await forgetFollowPds(follow.did);
    }
  } catch {
    await forgetFollowPds(follow.did);
  }
  if (!data?.records) return [];

  const seen = new Set<string>();
  const out: FollowedRoomEntry[] = [];
  for (const record of data.records) {
    const subject = record.value?.subject;
    // A repo can hold two readAlong records for the same room (join, leave,
    // rejoin), and the row is keyed by [did+subject], so keep the first.
    if (typeof subject !== 'string' || !parseAtUri(subject) || seen.has(subject)) continue;
    seen.add(subject);
    out.push({
      did: follow.did,
      subject,
      handle: follow.handle,
      displayName: follow.displayName,
      avatar: follow.avatar,
      createdAt: typeof record.value?.createdAt === 'string' ? record.value.createdAt : undefined,
    });
  }
  return out;
}

/** A room with the people you follow who are reading along in it. */
export interface FollowedRoom {
  /** the collection at-uri — the room's identity */
  subject: string;
  readers: FollowLite[];
}

/** Group per-person readAlong rows into one row per room, busiest first.
 *  Ties break on the room uri so the list doesn't reshuffle between scans. */
export function aggregateFollowedRooms(rows: FollowedRoomEntry[]): FollowedRoom[] {
  const byRoom = new Map<string, FollowLite[]>();
  for (const row of rows) {
    const readers = byRoom.get(row.subject) ?? [];
    if (readers.some((r) => r.did === row.did)) continue;
    readers.push({
      did: row.did,
      handle: row.handle,
      displayName: row.displayName,
      avatar: row.avatar,
    });
    byRoom.set(row.subject, readers);
  }
  return [...byRoom.entries()]
    .map(([subject, readers]) => ({ subject, readers }))
    .sort((a, b) => b.readers.length - a.readers.length || a.subject.localeCompare(b.subject));
}

/** Curated rooms surfaced on the /rooms index for readers with nowhere to
 *  start. Just collection at-uris: names and descriptions come from the
 *  collection records themselves (fetchCollectionMeta), so edits on Semble show
 *  up here without a deploy. Order is the display order. */
export const FEATURED_ROOM_URIS = [
  'at://did:plc:4vjd3fe2cgzq5d24j4f3zvar/network.cosmik.collection/3munguoqf5x25', // How We Read Now
  'at://did:plc:4vjd3fe2cgzq5d24j4f3zvar/network.cosmik.collection/3mungyyxm2w2p', // Tools for Thought
  'at://did:plc:4vjd3fe2cgzq5d24j4f3zvar/network.cosmik.collection/3munh3tsvbf2l', // The Open Web
  'at://did:plc:4vjd3fe2cgzq5d24j4f3zvar/network.cosmik.collection/3munh5zxdih2t', // The Craft
];

export interface CollectionMeta {
  name: string | null;
  /** the curator's own blurb — Semble's optional `description` field */
  description: string | null;
}

const EMPTY_META: CollectionMeta = { name: null, description: null };

/** Display metadata for a collection, fetched publicly from its owner's PDS (for
 *  the your-rooms list, where hitting /api/rooms per room would be heavy).
 *  Both providers carry `name`; `description` is Semble-only and optional. */
export async function fetchCollectionMeta(collectionUri: string): Promise<CollectionMeta> {
  const ref = parseAtUri(collectionUri);
  if (!ref) return EMPTY_META;
  try {
    const pds = await resolvePdsUrl(ref.did);
    if (!pds) return EMPTY_META;
    const params = new URLSearchParams({
      repo: ref.did,
      collection: ref.collection,
      rkey: ref.rkey,
    });
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (!res.ok) return EMPTY_META;
    const data = (await res.json()) as { value?: { name?: unknown; description?: unknown } };
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return { name: str(data.value?.name), description: str(data.value?.description) };
  } catch {
    return EMPTY_META;
  }
}

const SEMBLE_COLLECTION_NSID = 'network.cosmik.collection';
const SEMBLE_HOST = 'semble.so';

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
  if (url.hostname !== SEMBLE_HOST) return null;
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

/** The public page a collection lives on, where its provider has one. */
export interface CollectionPageLink {
  url: string;
  /** The provider's name, so the link can say where it goes. */
  provider: string;
}

/** The DID whose repo holds a collection record — its owner. */
export function collectionOwnerDid(collectionUri: string): string | null {
  return parseAtUri(collectionUri)?.did ?? null;
}

/**
 * The inverse of `sembleCollectionPageToUri`: a room's collection back to the
 * page a reader can open it on, so a room can be followed out to where its list
 * actually lives.
 *
 * Semble keys that page by the owner's *handle*, not their DID (the same
 * construction the feed proxy uses for filed-in-a-collection cards — see
 * `feed-proxy/src/mention-lane.ts`), so an owner whose handle we could not
 * resolve gets no link rather than a guessed one. `handle.invalid` is what the
 * appview returns when resolution fails, and it is a real hostname shape, so it
 * would build a URL that 404s quietly.
 *
 * `at.margin.collection` has no collection page we can construct, so a Margin
 * room links nowhere — the same stance as its missing access field: what the
 * provider doesn't give us, we don't invent.
 */
export function collectionPageLink(
  collectionUri: string,
  ownerHandle: string | null | undefined
): CollectionPageLink | null {
  const ref = parseAtUri(collectionUri);
  if (!ref || ref.collection !== SEMBLE_COLLECTION_NSID) return null;
  if (!ownerHandle || ownerHandle.startsWith('did:') || ownerHandle === 'handle.invalid') {
    return null;
  }
  return {
    url: `https://${SEMBLE_HOST}/profile/${encodeURIComponent(ownerHandle)}/collections/${ref.rkey}`,
    provider: 'Semble',
  };
}
