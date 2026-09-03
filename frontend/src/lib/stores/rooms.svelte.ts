import { api } from '$lib/services/api';
import { auth } from './auth.svelte';
import { toastStore } from './toast.svelte';
import { fetchMyRooms } from '$lib/services/rooms';
import type { RoomItem } from '$lib/types';

// The rooms this user has joined, with each room's article list — the cache
// behind Home's per-room lanes. Loaded once per session (per account): the room
// list comes from the user's own readAlong records on their PDS, each room's
// articles from GET /api/rooms (the backing-read snapshot), so a Home mount
// after the first render costs nothing. `refresh()` refetches on demand; the
// room page itself still fetches fresh (it's the dedicated surface) and pushes
// its read marks back into this cache via noteReadElsewhere.
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

  async function load(force = false): Promise<void> {
    const user = auth.user;
    if (!user || loading) return;
    if (!force && loadedForDid === user.did) return;
    if (loadedForDid !== user.did) rooms = []; // never show another account's rooms
    loading = true;
    try {
      const mine = await fetchMyRooms(user.did, user.pdsUrl);
      const infos = await Promise.allSettled(mine.map((r) => api.getRoom(r.subject)));
      rooms = mine.flatMap((r, i) => {
        const res = infos[i];
        if (res.status !== 'fulfilled') return [];
        return [{ subject: r.subject, name: res.value.name ?? null, items: res.value.items }];
      });
      loadedForDid = user.did;
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
