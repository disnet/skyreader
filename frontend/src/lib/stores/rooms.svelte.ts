import { api } from '$lib/services/api';
import { auth } from './auth.svelte';
import { toastStore } from './toast.svelte';
import { fetchMyRooms } from '$lib/services/rooms';
import {
  readJoinedRoomsCache,
  readRoomSnapshot,
  readRoomSnapshots,
  writeJoinedRoomsCache,
  writeRoomSnapshot,
} from '$lib/services/roomCache';
import type { RoomItem } from '$lib/types';

// The rooms this user has joined, with each room's article list — the cache
// behind Home's per-room lanes.
//
// Two layers, both stale-while-revalidate. The IndexedDB snapshot paints on the
// first load of a cold tab, so Home's lanes are there before any request
// settles; the network pass then refreshes them behind the paint and writes the
// result back. In-memory on top of that: loaded once per session (per account),
// so a Home mount after the first render costs nothing. `refresh()` refetches on
// demand; the room page reads the same snapshots and pushes its read marks back
// into this cache via noteReadElsewhere.
// See docs/plans/READING_ROOMS_SPIKE.md.

export interface JoinedRoom {
  /** the collection at-uri — the room's identity */
  subject: string;
  name: string | null;
  items: RoomItem[];
}

function createRoomsStore() {
  let rooms = $state<JoinedRoom[]>([]);
  let loading = $state(false);
  let loadedForDid: string | null = null;

  /** The cached rooms for this account: the snapshots of the rooms the cached
   *  join list says are theirs, in that list's order. A room whose snapshot is
   *  missing (joined on another device, never opened here) is skipped — the
   *  network pass a moment later is what fills it in. */
  async function fromCache(did: string): Promise<JoinedRoom[]> {
    const subjects = await readJoinedRoomsCache(did);
    if (!subjects?.length) return [];
    const snapshots = await readRoomSnapshots(subjects, did);
    return subjects.flatMap((subject) => {
      const cached = snapshots.get(subject);
      if (!cached) return [];
      return [{ subject, name: cached.room.name ?? null, items: cached.room.items }];
    });
  }

  async function load(force = false): Promise<void> {
    const user = auth.user;
    if (!user || loading) return;
    if (!force && loadedForDid === user.did) return;
    if (loadedForDid !== user.did) rooms = []; // never show another account's rooms
    loading = true;
    try {
      // Paint the last known lanes before the network is asked anything. Only
      // on a cold store: a refresh already has fresher rooms on screen.
      if (rooms.length === 0) {
        const cached = await fromCache(user.did);
        if (cached.length > 0 && rooms.length === 0) rooms = cached;
      }

      const mine = await fetchMyRooms(user.did, user.pdsUrl);
      // Null is "the PDS didn't answer", not "you left every room" — keep what
      // we're showing rather than clearing Home's lanes on a blip.
      if (mine === null) return;

      const infos = await Promise.allSettled(mine.map((r) => api.getRoom(r.subject)));
      const fresh = await Promise.all(
        mine.map(async (r, i) => {
          const res = infos[i];
          if (res.status === 'fulfilled') {
            void writeRoomSnapshot(r.subject, user.did, res.value, true);
            return { subject: r.subject, name: res.value.name ?? null, items: res.value.items };
          }
          // One room failing to load is not a reason to drop its lane: fall
          // back to its snapshot and try again next refresh.
          const cached = await readRoomSnapshot(r.subject, user.did);
          if (!cached) return null;
          return {
            subject: r.subject,
            name: cached.room.name ?? null,
            items: cached.room.items,
          };
        })
      );
      rooms = fresh.filter((r): r is JoinedRoom => r !== null);
      loadedForDid = user.did;
      void writeJoinedRoomsCache(
        user.did,
        mine.map((r) => r.subject)
      );
    } finally {
      loading = false;
    }
  }

  function applyRead(subject: string, urlNormalized: string, readByMe: boolean, delta: number) {
    rooms = rooms.map((room) =>
      room.subject === subject
        ? {
            ...room,
            items: room.items.map((i) =>
              i.urlNormalized === urlNormalized
                ? { ...i, readByMe, readCount: Math.max(0, i.readCount + delta) }
                : i
            ),
          }
        : room
    );
    void persistRead(subject, urlNormalized, readByMe, delta);
  }

  /** Keep the room's snapshot in step with the mark, so a reload doesn't paint
   *  the article unread again for the second or two before the refresh lands. */
  async function persistRead(
    subject: string,
    urlNormalized: string,
    readByMe: boolean,
    delta: number
  ): Promise<void> {
    const did = auth.user?.did;
    if (!did) return;
    const cached = await readRoomSnapshot(subject, did);
    if (!cached) return;
    await writeRoomSnapshot(
      subject,
      did,
      {
        ...cached.room,
        items: cached.room.items.map((i) =>
          i.urlNormalized === urlNormalized
            ? { ...i, readByMe, readCount: Math.max(0, i.readCount + delta) }
            : i
        ),
      },
      cached.joined
    );
  }

  /** The explicit "I'm done" signal, from a room article opened via Home.
   *  Optimistic; reverts on failure. Mirrors RoomPage's markRead. */
  async function markRead(subject: string, item: RoomItem): Promise<void> {
    if (item.readByMe) return;
    applyRead(subject, item.urlNormalized, true, 1);
    try {
      await api.recordRoomRead(subject, item.url);
    } catch {
      applyRead(subject, item.urlNormalized, false, -1);
      toastStore.update(toastStore.add('Could not mark as read'), 'error');
    }
  }

  /** A read was recorded on another surface (the room page); keep the cached
   *  copy honest without a refetch. */
  function noteReadElsewhere(subject: string, urlNormalized: string): void {
    const item = rooms
      .find((r) => r.subject === subject)
      ?.items.find((i) => i.urlNormalized === urlNormalized);
    if (item && !item.readByMe) applyRead(subject, urlNormalized, true, 1);
  }

  return {
    get rooms() {
      return rooms;
    },
    get loading() {
      return loading;
    },
    load,
    refresh: () => load(true),
    markRead,
    noteReadElsewhere,
  };
}

export const roomsStore = createRoomsStore();
