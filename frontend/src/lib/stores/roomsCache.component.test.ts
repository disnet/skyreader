// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Opening Home used to mean waiting on a foreign-collection read per room. The
// store now paints the last snapshot first and refreshes behind it, so these
// tests are about what the reader sees while the network is still out: the
// cached lanes, in the order they were in, and never a blank shelf because a
// PDS or one room's read failed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomInfo, RoomItem } from '$lib/types';
import type { RoomSnapshotEntry } from '$lib/services/db';

const ME = 'did:plc:me';
const ROOM_A = 'at://did:plc:owner/network.cosmik.collection/aaa';
const ROOM_B = 'at://did:plc:owner/network.cosmik.collection/bbb';

const snapshots = new Map<string, RoomSnapshotEntry>();
let joinedCache: string[] | null = null;

const roomCache = {
  readJoinedRoomsCache: vi.fn(async (did: string) => (did === ME ? joinedCache : null)),
  readRoomSnapshot: vi.fn(
    async (subject: string, did: string) => snapshots.get(`${did}|${subject}`) ?? null
  ),
  readRoomSnapshots: vi.fn(async (subjects: string[], did: string) => {
    const found = new Map<string, RoomSnapshotEntry>();
    for (const subject of subjects) {
      const row = snapshots.get(`${did}|${subject}`);
      if (row) found.set(subject, row);
    }
    return found;
  }),
  writeJoinedRoomsCache: vi.fn(async (did: string, subjects: string[]) => {
    if (did === ME) joinedCache = subjects;
  }),
  writeRoomSnapshot: vi.fn(
    async (subject: string, did: string, room: RoomInfo, joined: boolean) => {
      snapshots.set(`${did}|${subject}`, { did, subject, room, joined, cachedAt: Date.now() });
    }
  ),
};
vi.mock('$lib/services/roomCache', () => roomCache);

const fetchMyRooms = vi.fn();
vi.mock('$lib/services/rooms', () => ({ fetchMyRooms: (...a: unknown[]) => fetchMyRooms(...a) }));

const api = { getRoom: vi.fn(), recordRoomRead: vi.fn(async () => ({ ok: true })) };
vi.mock('$lib/services/api', () => ({ api }));
vi.mock('./auth.svelte', () => ({
  auth: { user: { did: ME, pdsUrl: 'https://pds.example' } },
}));
vi.mock('./toast.svelte', () => ({
  toastStore: { add: vi.fn(() => 1), update: vi.fn() },
}));

function item(url: string, readByMe = false): RoomItem {
  return { url, urlNormalized: url, itemType: 'article', title: url, readCount: 0, readByMe };
}

function room(uri: string, name: string, items: RoomItem[] = [item(`${uri}#1`)]): RoomInfo {
  return {
    uri,
    provider: 'semble',
    ownerDid: 'did:plc:owner',
    name,
    canAdd: false,
    complete: true,
    items,
  };
}

function seedSnapshot(subject: string, name: string, items?: RoomItem[]) {
  snapshots.set(`${ME}|${subject}`, {
    did: ME,
    subject,
    room: room(subject, name, items),
    joined: true,
    cachedAt: Date.now(),
  });
}

async function freshStore() {
  vi.resetModules();
  return (await import('./rooms.svelte')).roomsStore;
}

beforeEach(() => {
  snapshots.clear();
  joinedCache = null;
  vi.clearAllMocks();
});

describe('roomsStore caching', () => {
  it('paints the cached rooms before the network answers', async () => {
    joinedCache = [ROOM_A, ROOM_B];
    seedSnapshot(ROOM_A, 'Cached A');
    seedSnapshot(ROOM_B, 'Cached B');
    let releaseNetwork: (rooms: Array<{ subject: string }>) => void = () => {};
    fetchMyRooms.mockReturnValue(new Promise((resolve) => (releaseNetwork = resolve)));

    const store = await freshStore();
    const loading = store.load();
    await vi.waitFor(() => expect(store.rooms).toHaveLength(2));
    // The cached join order is the lane order, so nothing reshuffles later.
    expect(store.rooms.map((r) => r.name)).toEqual(['Cached A', 'Cached B']);

    api.getRoom.mockImplementation(async (uri: string) => room(uri, 'Fresh'));
    releaseNetwork([{ subject: ROOM_A }, { subject: ROOM_B }]);
    await loading;
    expect(store.rooms.map((r) => r.name)).toEqual(['Fresh', 'Fresh']);
  });

  it('skips a cached room it holds no snapshot for', async () => {
    joinedCache = [ROOM_A, ROOM_B];
    seedSnapshot(ROOM_A, 'Cached A');
    fetchMyRooms.mockResolvedValue([{ subject: ROOM_A }, { subject: ROOM_B }]);
    api.getRoom.mockImplementation(async (uri: string) => room(uri, 'Fresh'));

    const store = await freshStore();
    await store.load();
    expect(store.rooms).toHaveLength(2);
  });

  it('keeps the cached rooms when the PDS lookup fails', async () => {
    joinedCache = [ROOM_A];
    seedSnapshot(ROOM_A, 'Cached A');
    fetchMyRooms.mockResolvedValue(null);

    const store = await freshStore();
    await store.load();
    expect(store.rooms.map((r) => r.name)).toEqual(['Cached A']);
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it('falls back to the snapshot for a room whose read fails', async () => {
    seedSnapshot(ROOM_B, 'Cached B');
    fetchMyRooms.mockResolvedValue([{ subject: ROOM_A }, { subject: ROOM_B }]);
    api.getRoom.mockImplementation(async (uri: string) => {
      if (uri === ROOM_B) throw new Error('collection read failed');
      return room(uri, 'Fresh A');
    });

    const store = await freshStore();
    await store.load();
    expect(store.rooms.map((r) => r.name)).toEqual(['Fresh A', 'Cached B']);
  });

  it('drops a room with neither a fresh read nor a snapshot', async () => {
    fetchMyRooms.mockResolvedValue([{ subject: ROOM_A }]);
    api.getRoom.mockRejectedValue(new Error('collection read failed'));

    const store = await freshStore();
    await store.load();
    expect(store.rooms).toEqual([]);
  });

  it('caches the join list and every room it loaded', async () => {
    fetchMyRooms.mockResolvedValue([{ subject: ROOM_A }, { subject: ROOM_B }]);
    api.getRoom.mockImplementation(async (uri: string) => room(uri, 'Fresh'));

    const store = await freshStore();
    await store.load();
    expect(joinedCache).toEqual([ROOM_A, ROOM_B]);
    expect(snapshots.get(`${ME}|${ROOM_A}`)?.joined).toBe(true);
    expect(snapshots.get(`${ME}|${ROOM_B}`)?.room.name).toBe('Fresh');
  });

  it('writes a read mark through to the snapshot', async () => {
    const url = `${ROOM_A}#1`;
    fetchMyRooms.mockResolvedValue([{ subject: ROOM_A }]);
    api.getRoom.mockImplementation(async (uri: string) => room(uri, 'Fresh', [item(url)]));

    const store = await freshStore();
    await store.load();
    await store.markRead(ROOM_A, store.rooms[0].items[0]);

    await vi.waitFor(() => {
      const cached = snapshots.get(`${ME}|${ROOM_A}`)!.room.items[0];
      expect(cached.readByMe).toBe(true);
      expect(cached.readCount).toBe(1);
    });
  });
});
