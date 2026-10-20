import { api } from '$lib/services/api';
import type { SavedConnectionActivity, SavedConnectionDetail, SavedItem } from '$lib/types';
import { auth } from './auth.svelte';
import { syncStore } from './sync.svelte';

/**
 * Semble connections other people drew off the reader's saves — Skyreader's take
 * on Semble's notification feed (backend routes/saved-connections.ts,
 * docs/plans/SEMBLE_CONNECTIONS.md).
 *
 * It isn't a feed: news about something you already have belongs on that thing.
 * Saved and Shelf cards show a quiet "new" mark, the Shelf can put recently
 * connected items first, and an opened save's discussion opens on Connections
 * with the new ones marked. The mark stays until the reader clears it (in the
 * discussion, on its Shelf tile, or every save at once from the Shelf), not
 * merely on opening.
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
  // rkey → the new connections a save had when the reader cleared it this
  // session, so the discussion can keep showing them while Semble's own index
  // (which the panel reads, through a cache) catches up.
  let clearedNewest = $state<Map<string, SavedConnectionDetail[]>>(new Map());
  // rkey → when the reader cleared it here. A list fetched before that can't
  // know about it, and mustn't bring the badge back.
  let clearedAt = new Map<string, number>();
  // Clears the server hasn't recorded yet.
  const pending = new Set<string>();
  let loadedFor: string | null = null;
  let loadedAt = 0;
  let inFlight: { did: string; promise: Promise<void> } | null = null;

  function reset() {
    byRkey = new Map();
    clearedNewest = new Map();
    clearedAt = new Map();
    pending.clear();
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
          const cleared = clearedAt.get(item.rkey);
          // A list from before the clear, or from before the server recorded it.
          next.set(
            item.rkey,
            cleared !== undefined && (cleared >= startedAt || pending.has(item.rkey))
              ? { ...item, unseen: 0, seenAt: cleared, newest: [] }
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
   * What "new" means for this save's connections while it has any: the
   * reader's last clear, or the save itself. Null once cleared. Opening a save
   * doesn't clear it; the reader says when they're done (`markSeen`).
   */
  function newSince(rkey: string, savedAt: string | null | undefined): number | null {
    const activity = byRkey.get(rkey);
    if (!activity || activity.unseen === 0) return null;
    if (activity.seenAt !== null) return activity.seenAt;
    const saved = savedAt ? Date.parse(savedAt) : NaN;
    return Number.isFinite(saved) ? saved : 0;
  }

  /** The new connections to show for this save: unseen ones, or the ones just cleared. */
  function newest(rkey: string): SavedConnectionDetail[] {
    const activity = byRkey.get(rkey);
    if (activity && activity.unseen > 0) return activity.newest;
    return clearedNewest.get(rkey) ?? [];
  }

  /** Clear these saves' new connections, here and on the server. */
  function clear(rkeys: string[]): void {
    if (!rkeys.some((rkey) => (byRkey.get(rkey)?.unseen ?? 0) > 0)) return;
    const now = Date.now();
    const nextActivity = new Map(byRkey);
    const nextNewest = new Map(clearedNewest);
    for (const rkey of rkeys) {
      const activity = byRkey.get(rkey);
      if (!activity || activity.unseen === 0) continue;
      clearedAt.set(rkey, now);
      if (activity.newest.length > 0) nextNewest.set(rkey, activity.newest);
      nextActivity.set(rkey, { ...activity, unseen: 0, seenAt: now, newest: [] });
      pending.add(rkey);
      api
        .markSavedConnectionsSeen(rkey)
        .catch((e) => {
          // The mark comes back on the next load; nothing to roll back here.
          console.error('[savedConnections] Failed to mark seen:', e);
        })
        .finally(() => pending.delete(rkey));
    }
    byRkey = nextActivity;
    clearedNewest = nextNewest;
  }

  /** The reader is done with this save's new connections. */
  function markSeen(rkey: string): void {
    clear([rkey]);
  }

  /** Clear every save's new connections. */
  function markAllSeen(): void {
    clear([...byRkey.values()].filter((a) => a.unseen > 0).map((a) => a.rkey));
  }

  return {
    load,
    unseen,
    latestAt,
    newSince,
    newest,
    markSeen,
    markAllSeen,
    /**
     * The saves among `saves` with new connections, most recently connected
     * first: the New connections lane on the Shelf and on Home.
     */
    unseenFor(saves: SavedItem[]): { save: SavedItem; activity: SavedConnectionActivity }[] {
      const news = [...byRkey.values()].filter((activity) => activity.unseen > 0);
      // Most of the time there's no news, so skip indexing the whole library.
      if (news.length === 0) return [];
      const saveByRkey = new Map(saves.map((save) => [save.rkey, save]));
      return news
        .filter((activity) => saveByRkey.has(activity.rkey))
        .sort((a, b) => b.latestAt - a.latestAt)
        .map((activity) => ({ save: saveByRkey.get(activity.rkey)!, activity }));
    },
  };
}

export const savedConnectionsStore = createSavedConnectionsStore();
