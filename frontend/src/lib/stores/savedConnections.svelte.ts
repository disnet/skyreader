import { api } from '$lib/services/api';
import type { SavedConnectionActivity } from '$lib/types';
import { auth } from './auth.svelte';
import { syncStore } from './sync.svelte';

/**
 * Semble connections other people drew off the reader's saves — Skyreader's take
 * on Semble's notification feed (backend routes/saved-connections.ts,
 * docs/plans/SEMBLE_CONNECTIONS.md).
 *
 * It isn't a feed: news about something you already have belongs on that thing.
 * Saved and Shelf cards show a quiet "new" mark, the Shelf can put recently
 * connected items first, and opening a save clears its mark and hands the
 * reader's discussion the time "new" is measured from, so it can open on the
 * Connections tab with the new ones marked.
 *
 * Online-only and uncached: the list is small, and a stale badge offline is
 * worse than none.
 */

/** A list fetched this recently is fresh enough for another page to reuse. */
const FRESH_MS = 60_000;

function sameActivity(
  a: Map<string, SavedConnectionActivity>,
  b: Map<string, SavedConnectionActivity>
): boolean {
  if (a.size !== b.size) return false;
  for (const [rkey, x] of b) {
    const y = a.get(rkey);
    if (
      !y ||
      y.unseen !== x.unseen ||
      y.latestAt !== x.latestAt ||
      y.seenAt !== x.seenAt ||
      // An edited note or type keeps its uri, so compare the details whole.
      JSON.stringify(y.newest) !== JSON.stringify(x.newest)
    ) {
      return false;
    }
  }
  return true;
}

function createSavedConnectionsStore() {
  let byRkey = $state<Map<string, SavedConnectionActivity>>(new Map());
  // rkey → the moment "new" was measured from when the reader opened it this
  // session (their previous look, or the save). Kept after the mark clears so
  // the discussion can still say which connections were the new ones.
  let openedSince = $state<Map<string, number>>(new Map());
  // rkey → when the reader opened it here. A list fetched before that can't
  // know about the look, and mustn't bring the badge back.
  let openedAt = new Map<string, number>();
  let loadedFor: string | null = null;
  let loadedAt = 0;
  let inFlight: { did: string; promise: Promise<void> } | null = null;

  function reset() {
    byRkey = new Map();
    openedSince = new Map();
    openedAt = new Map();
    loadedFor = null;
  }

  async function load(force = false): Promise<void> {
    const did = auth.user?.did ?? null;
    if (!did || auth.isGuest) {
      if (loadedFor !== null) reset();
      return;
    }
    if (loadedFor !== null && loadedFor !== did) reset();
    if (!syncStore.isOnline) return;
    if (!force && loadedFor === did && Date.now() - loadedAt < FRESH_MS) return;
    if (inFlight?.did === did) return inFlight.promise;
    const startedAt = Date.now();
    const promise = (async () => {
      try {
        const { items } = await api.getSavedConnections();
        // An account switch mid-request must not land the old reader's list.
        if (auth.user?.did !== did) return;
        const next = new Map<string, SavedConnectionActivity>();
        for (const raw of items) {
          // A backend from before `newest` sends none.
          const item = { ...raw, newest: raw.newest ?? [] };
          const opened = openedAt.get(item.rkey);
          next.set(
            item.rkey,
            opened !== undefined && opened >= startedAt
              ? { ...item, unseen: 0, seenAt: opened, newest: [] }
              : item
          );
        }
        // Every card reads this map, so leave it alone when nothing changed.
        if (!sameActivity(byRkey, next)) byRkey = next;
        loadedFor = did;
        loadedAt = Date.now();
      } catch (e) {
        console.error('[savedConnections] Failed to load:', e);
      } finally {
        // Only one request per account runs at a time, so this one is it.
        if (inFlight?.did === did) inFlight = null;
      }
    })();
    inFlight = { did, promise };
    return promise;
  }

  function unseen(rkey: string): number {
    return byRkey.get(rkey)?.unseen ?? 0;
  }

  function latestAt(rkey: string): number {
    return byRkey.get(rkey)?.latestAt ?? 0;
  }

  /**
   * The reader opened this save. If it had new connections, remember what they
   * were new since and clear the mark here and on the server.
   */
  function open(rkey: string, savedAt: string | null | undefined): void {
    const activity = byRkey.get(rkey);
    if (!activity || activity.unseen === 0) return;
    const saved = savedAt ? Date.parse(savedAt) : NaN;
    const since = activity.seenAt ?? (Number.isFinite(saved) ? saved : 0);
    openedSince = new Map(openedSince).set(rkey, since);
    const now = Date.now();
    openedAt.set(rkey, now);
    byRkey = new Map(byRkey).set(rkey, { ...activity, unseen: 0, seenAt: now, newest: [] });
    api.markSavedConnectionsSeen(rkey).catch((e) => {
      // The mark comes back on the next load; nothing to roll back here.
      console.error('[savedConnections] Failed to mark seen:', e);
    });
  }

  /** What "new" means for this save's connections in the open reader, or null. */
  function newSince(rkey: string): number | null {
    return openedSince.get(rkey) ?? null;
  }

  return {
    load,
    unseen,
    latestAt,
    open,
    newSince,
    /** Saves with connections by other people. */
    get items(): SavedConnectionActivity[] {
      return [...byRkey.values()];
    },
  };
}

export const savedConnectionsStore = createSavedConnectionsStore();
