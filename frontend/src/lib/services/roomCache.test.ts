import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomInfo } from '$lib/types';
import type { RoomSnapshotEntry } from '$lib/services/db';

// [did+subject] compound key, flattened so the fake table can hold it.
const snapshots = new Map<string, RoomSnapshotEntry>();
const metadata = new Map<string, unknown>();
const key = (did: string, subject: string) => `${did}|${subject}`;

let deletedBelow: number | null = null;

vi.mock('$lib/services/db', () => ({
  getMetadata: async (k: string) => metadata.get(k) ?? null,
  setMetadata: async (k: string, value: unknown) => void metadata.set(k, value),
  db: {
    roomSnapshots: {
      get: async ([did, subject]: [string, string]) => snapshots.get(key(did, subject)),
      bulkGet: async (keys: Array<[string, string]>) =>
        keys.map(([did, subject]) => snapshots.get(key(did, subject))),
      put: async (row: RoomSnapshotEntry) => void snapshots.set(key(row.did, row.subject), row),
      where: () => ({
        below: (cutoff: number) => ({
          delete: async () => {
            deletedBelow = cutoff;
            for (const [k, row] of snapshots) if (row.cachedAt < cutoff) snapshots.delete(k);
          },
        }),
      }),
    },
  },
}));

vi.mock('$lib/services/safeDb.svelte', () => ({
  safePut: async (table: { put: (v: unknown) => Promise<void> }, v: unknown) => table.put(v),
}));

const {
  ANON_ROOM_DID,
  roomCacheDid,
  readRoomSnapshot,
  readRoomSnapshots,
  writeRoomSnapshot,
  readMyRoomsCache,
  writeMyRoomsCache,
  readFeaturedCache,
  writeFeaturedCache,
  readPresenceCache,
  writePresenceCache,
} = await import('./roomCache');
const { FEATURED_ROOM_URIS } = await import('./rooms');

const ROOM_A = 'at://did:plc:owner/network.cosmik.collection/aaa';
const ROOM_B = 'at://did:plc:owner/network.cosmik.collection/bbb';
const ME = 'did:plc:me';

function room(uri: string, name: string): RoomInfo {
  return {
    uri,
    provider: 'semble',
    ownerDid: 'did:plc:owner',
    name,
    canAdd: false,
    complete: true,
    items: [],
  };
}

beforeEach(() => {
  snapshots.clear();
  metadata.clear();
  deletedBelow = null;
});

describe('room snapshots', () => {
  it('round-trips a snapshot for one reader', async () => {
    await writeRoomSnapshot(ROOM_A, ME, room(ROOM_A, 'Tools for Thought'), true);
    const cached = await readRoomSnapshot(ROOM_A, ME);
    expect(cached?.room.name).toBe('Tools for Thought');
    expect(cached?.joined).toBe(true);
  });

  it('never hands one reader another reader’s snapshot', async () => {
    await writeRoomSnapshot(ROOM_A, ME, room(ROOM_A, 'Mine'), true);
    expect(await readRoomSnapshot(ROOM_A, 'did:plc:someone-else')).toBeNull();
    expect(await readRoomSnapshot(ROOM_A, ANON_ROOM_DID)).toBeNull();
  });

  it('files a signed-out visitor under the anonymous owner', () => {
    expect(roomCacheDid(null)).toBe(ANON_ROOM_DID);
    expect(roomCacheDid(undefined)).toBe(ANON_ROOM_DID);
    expect(roomCacheDid(ME)).toBe(ME);
  });

  it('reads several rooms at once, skipping the ones it has never seen', async () => {
    await writeRoomSnapshot(ROOM_A, ME, room(ROOM_A, 'A'), true);
    const found = await readRoomSnapshots([ROOM_A, ROOM_B], ME);
    expect(found.get(ROOM_A)?.room.name).toBe('A');
    expect(found.has(ROOM_B)).toBe(false);
  });

  it('prunes snapshots that have gone stale', async () => {
    const ancient = Date.now() - 60 * 24 * 60 * 60 * 1000;
    snapshots.set(key(ME, ROOM_B), {
      did: ME,
      subject: ROOM_B,
      room: room(ROOM_B, 'Old'),
      joined: false,
      cachedAt: ancient,
    });
    await writeRoomSnapshot(ROOM_A, ME, room(ROOM_A, 'New'), true);
    expect(deletedBelow).not.toBeNull();
    expect(await readRoomSnapshot(ROOM_B, ME)).toBeNull();
    expect(await readRoomSnapshot(ROOM_A, ME)).not.toBeNull();
  });
});

describe('index caches', () => {
  it('keeps your rooms to your account', async () => {
    await writeMyRoomsCache(ME, [
      {
        recordUri: 'at://did:plc:me/x/1',
        subject: ROOM_A,
        name: 'A',
        description: null,
        link: null,
      },
    ]);
    expect(await readMyRoomsCache(ME)).toHaveLength(1);
    expect(await readMyRoomsCache('did:plc:someone-else')).toBeNull();
  });

  it('drops cached featured rooms that are no longer featured', async () => {
    await writeFeaturedCache([
      { subject: FEATURED_ROOM_URIS[0], name: 'Still featured', description: null, link: null },
      { subject: ROOM_A, name: 'Dropped from the list', description: null, link: null },
    ]);
    const cached = await readFeaturedCache();
    expect(cached?.map((r) => r.subject)).toEqual([FEATURED_ROOM_URIS[0]]);
  });

  it('caches presence counts but not failed lookups', async () => {
    await writePresenceCache({ [ROOM_A]: 4, [ROOM_B]: null });
    expect(await readPresenceCache()).toEqual({ [ROOM_A]: 4 });
  });

  it('answers an empty presence cache with an empty map', async () => {
    expect(await readPresenceCache()).toEqual({});
  });
});
