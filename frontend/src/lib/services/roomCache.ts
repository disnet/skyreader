// Local cache for reading rooms — the disk behind the paint.
//
// A room's article list is a remote read: /api/rooms walks a foreign collection
// record by record, and the /rooms index describes each room off its owner's
// PDS. Both are slow enough to spin, and neither changes minute to minute, so
// every surface here reads the same way: **paint what we have, refresh behind
// it**. Nothing in this module blocks a render, and a failed refresh leaves the
// last good copy standing rather than blanking the room.
//
// Two kinds of cache live here:
//   - per-room snapshots (Dexie `roomSnapshots`), the article list itself;
//   - the /rooms index lists (metadata blobs), which are small and always read
//     whole.
// Both are per-reader and both are dropped by clearAllData on sign-out.
// See docs/plans/READING_ROOMS_SPIKE.md.

import { db, getMetadata, setMetadata, type RoomSnapshotEntry } from '$lib/services/db';
import { safePut } from '$lib/services/safeDb.svelte';
import { FEATURED_ROOM_URIS, type MyRoom, type RoomListing } from '$lib/services/rooms';
import type { RoomInfo } from '$lib/types';

/** Cache owner for a signed-out visitor. A room reached by link renders without
 *  a session, and that snapshot carries no personal read state — but it still
 *  must not be handed to whoever signs in next, so it gets its own owner key.
 *  No real DID can collide: every DID starts with `did:`. */
export const ANON_ROOM_DID = 'anon';

/** Snapshots older than this are dropped on the next write. A room you opened
 *  once last spring is not worth painting, and pruning by age keeps a browsing
 *  habit from growing the table without bound. */
const MAX_SNAPSHOT_AGE = 30 * 24 * 60 * 60 * 1000;

const JOINED_KEY = 'rooms.joined';
const MINE_KEY = 'rooms.index.mine';
const FEATURED_KEY = 'rooms.index.featured';
const PRESENCE_KEY = 'rooms.index.presence';

export function roomCacheDid(did: string | null | undefined): string {
  return did ?? ANON_ROOM_DID;
}

/** The last snapshot of this room for this reader, or null when we've never
 *  held one. Never throws: a cache miss and a broken IndexedDB are the same
 *  answer to the caller — fetch it. */
export async function readRoomSnapshot(
  subject: string,
  did: string
): Promise<RoomSnapshotEntry | null> {
  try {
    return (await db.roomSnapshots.get([did, subject])) ?? null;
  } catch (e) {
    console.error('[roomCache] snapshot read failed:', e);
    return null;
  }
}

/** The snapshots of several rooms at once, keyed by subject. Rooms we hold no
 *  snapshot for are simply absent. */
export async function readRoomSnapshots(
  subjects: string[],
  did: string
): Promise<Map<string, RoomSnapshotEntry>> {
  const found = new Map<string, RoomSnapshotEntry>();
  try {
    const rows = await db.roomSnapshots.bulkGet(subjects.map((subject) => [did, subject]));
    for (const row of rows) if (row) found.set(row.subject, row);
  } catch (e) {
    console.error('[roomCache] snapshot list read failed:', e);
  }
  return found;
}

/** Record what the room looks like now, and drop whatever has gone ancient. */
export async function writeRoomSnapshot(
  subject: string,
  did: string,
  room: RoomInfo,
  joined: boolean
): Promise<void> {
  try {
    await safePut(db.roomSnapshots, { did, subject, room, joined, cachedAt: Date.now() });
    await db.roomSnapshots
      .where('cachedAt')
      .below(Date.now() - MAX_SNAPSHOT_AGE)
      .delete();
  } catch (e) {
    // A cache write is never load-bearing: the room is already on screen.
    console.error('[roomCache] snapshot write failed:', e);
  }
}

// --- the join list --------------------------------------------------------

interface JoinedCache {
  did: string;
  subjects: string[];
}

/** The rooms this reader had joined at last look, in the order their PDS
 *  listed them — which is the order Home's lanes are in, so the lanes painted
 *  from cache don't reshuffle when the refresh lands. Null for another
 *  account's cache. */
export async function readJoinedRoomsCache(did: string): Promise<string[] | null> {
  const cached = await getMetadata<JoinedCache>(JOINED_KEY);
  if (!cached || cached.did !== did || !Array.isArray(cached.subjects)) return null;
  return cached.subjects;
}

export async function writeJoinedRoomsCache(did: string, subjects: string[]): Promise<void> {
  await setMetadata<JoinedCache>(JOINED_KEY, { did, subjects });
}

// --- /rooms index lists ---------------------------------------------------

/** A row of the "Your rooms" list, as the index renders it. */
export type MyRoomListing = MyRoom & RoomListing;

interface MineCache {
  did: string;
  rooms: MyRoomListing[];
}

interface FeaturedCache {
  rooms: RoomListing[];
}

interface PresenceCache {
  counts: Record<string, number>;
}

/** The rooms this reader had joined at last look, described. Null for another
 *  account's cache — your rooms are never someone else's. */
export async function readMyRoomsCache(did: string): Promise<MyRoomListing[] | null> {
  const cached = await getMetadata<MineCache>(MINE_KEY);
  if (!cached || cached.did !== did || !Array.isArray(cached.rooms)) return null;
  return cached.rooms;
}

export async function writeMyRoomsCache(did: string, rooms: MyRoomListing[]): Promise<void> {
  await setMetadata<MineCache>(MINE_KEY, { did, rooms });
}

/** The featured listings, filtered to what's featured *now*: the list is a
 *  constant that ships with a deploy, so a cached row that has since been
 *  dropped from it has no business on the page. */
export async function readFeaturedCache(): Promise<RoomListing[] | null> {
  const cached = await getMetadata<FeaturedCache>(FEATURED_KEY);
  if (!cached || !Array.isArray(cached.rooms)) return null;
  const featured = new Set(FEATURED_ROOM_URIS);
  return cached.rooms.filter((r) => featured.has(r.subject));
}

export async function writeFeaturedCache(rooms: RoomListing[]): Promise<void> {
  await setMetadata<FeaturedCache>(FEATURED_KEY, { rooms });
}

/** Cached "n reading along" counts, so the index rows don't wait on
 *  Constellation to say anything. Counts only, never the DIDs: the index draws
 *  no avatars, and a count is not a person. */
export async function readPresenceCache(): Promise<Record<string, number>> {
  const cached = await getMetadata<PresenceCache>(PRESENCE_KEY);
  return cached?.counts && typeof cached.counts === 'object' ? cached.counts : {};
}

export async function writePresenceCache(counts: Record<string, number | null>): Promise<void> {
  // A failed lookup (null) is not a count — cache what we actually learned.
  const known = Object.fromEntries(
    Object.entries(counts).filter((entry): entry is [string, number] => entry[1] !== null)
  );
  await setMetadata<PresenceCache>(PRESENCE_KEY, { counts: known });
}
