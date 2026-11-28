import { api } from '$lib/services/api';
import type { SaveWatch, SavedItem, WatchRefusal } from '$lib/types';
import { auth } from './auth.svelte';
import { syncStore } from './sync.svelte';
import { toastStore } from './toast.svelte';

/**
 * Watch for updates: saves the reader asked to hear about, and what's new on
 * them (backend routes/save-watches.ts, docs/plans/SAVE_WATCHES.md).
 *
 * The checks run server-side (mentions daily, citations weekly), so this only
 * holds the list: which saves are watched, for the switch in the save panel and
 * the card menus, and their unseen updates, for the Watching lane, the card
 * badge and one bell entry a day. Like New connections, an update stays until
 * the reader clears it.
 *
 * Online-only and uncached: the list is small (the plan caps it), and a stale
 * switch offline is worse than none.
 */

/** A list fetched this recently is fresh enough for another page to reuse. */
const FRESH_MS = 60_000;

function sameWatches(a: Map<string, SaveWatch>, b: Map<string, SaveWatch>): boolean {
  if (a.size !== b.size) return false;
  for (const [rkey, x] of b) {
    const y = a.get(rkey);
    if (!y || JSON.stringify(y) !== JSON.stringify(x)) return false;
  }
  return true;
}

/** What the reader is told when a save can't be watched. */
export function refusalMessage(reason: WatchRefusal, limit: number, count = 1): string {
  switch (reason) {
    case 'limit':
      return `You can watch ${limit} saves on your plan. Stop watching one to watch another.`;
    case 'no_url':
      return count === 1
        ? 'An uploaded file has no page to watch.'
        : `${count} uploaded files have no page to watch.`;
    default:
      return count === 1 ? 'That save is gone.' : `${count} saves are gone.`;
  }
}

function createSavedWatchesStore() {
  let byRkey = $state<Map<string, SaveWatch>>(new Map());
  let limit = $state(0);
  // rkey → when the reader cleared it here; a list fetched before that mustn't
  // bring its updates back.
  let clearedAt = new Map<string, number>();
  // rkey → watch state the reader just set, until a list from after it lands.
  let toggledAt = new Map<string, { watching: boolean; at: number }>();
  let loadedFor: string | null = null;
  let loadedAt = 0;
  let inFlight: { did: string; promise: Promise<void> } | null = null;

  function reset() {
    byRkey = new Map();
    limit = 0;
    clearedAt = new Map();
    toggledAt = new Map();
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
        const res = await api.getSaveWatches();
        if (auth.user?.did !== did) return;
        const next = new Map<string, SaveWatch>();
        for (const item of res.items) {
          const toggled = toggledAt.get(item.rkey);
          if (toggled && toggled.at >= startedAt && !toggled.watching) continue;
          const cleared = clearedAt.get(item.rkey);
          next.set(
            item.rkey,
            cleared !== undefined && cleared >= startedAt
              ? { ...item, unseen: 0, events: [], seenAt: cleared }
              : item
          );
        }
        // A switch flipped on after this request left isn't in its answer yet.
        for (const [rkey, toggled] of toggledAt) {
          if (toggled.at >= startedAt && toggled.watching && !next.has(rkey)) {
            const kept = byRkey.get(rkey);
            if (kept) next.set(rkey, kept);
          }
        }
        if (!sameWatches(byRkey, next)) byRkey = next;
        limit = res.limit;
        loadedFor = did;
        loadedAt = Date.now();
      } catch (e) {
        console.error('[savedWatches] Failed to load:', e);
      } finally {
        if (inFlight?.did === did) inFlight = null;
      }
    })();
    inFlight = { did, promise };
    return promise;
  }

  function placeholder(rkey: string, now: number): SaveWatch {
    return {
      rkey,
      watchedAt: now,
      seenAt: null,
      unseen: 0,
      latestAt: null,
      events: [],
      citations: false,
    };
  }

  /**
   * Watch (or stop watching) these saves. Optimistic: the switch moves at once,
   * and what the server refuses (over the cap, an upload) moves back with a
   * toast saying why.
   */
  async function setWatching(rkeys: string[], watching: boolean): Promise<void> {
    const wanted = [...new Set(rkeys)];
    if (wanted.length === 0) return;
    const now = Date.now();
    const before = byRkey;
    const next = new Map(byRkey);
    for (const rkey of wanted) {
      toggledAt.set(rkey, { watching, at: now });
      if (watching) {
        if (!next.has(rkey)) next.set(rkey, placeholder(rkey, now));
      } else {
        next.delete(rkey);
      }
    }
    byRkey = next;
    try {
      const res = await api.setSaveWatches(wanted, watching);
      limit = res.limit;
      if (res.refused.length === 0) {
        if (watching) void load(true);
        return;
      }
      const after = new Map(byRkey);
      for (const { rkey } of res.refused) after.delete(rkey);
      byRkey = after;
      const reasons = new Map<WatchRefusal, number>();
      for (const { reason } of res.refused) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      const [reason, count] = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      toastStore.add(refusalMessage(reason, res.limit, count));
      if (res.watched.length > 0) void load(true);
    } catch (e) {
      console.error('[savedWatches] Failed to update:', e);
      byRkey = before;
      for (const rkey of wanted) toggledAt.delete(rkey);
      toastStore.add(
        watching ? "Couldn't start watching. Try again." : "Couldn't stop watching. Try again."
      );
    }
  }

  /** Clear these saves' updates, here and on the server. */
  function clear(rkeys: string[] | 'all'): void {
    const targets =
      rkeys === 'all'
        ? [...byRkey.values()].filter((w) => w.unseen > 0).map((w) => w.rkey)
        : rkeys.filter((rkey) => (byRkey.get(rkey)?.unseen ?? 0) > 0);
    if (targets.length === 0) return;
    const now = Date.now();
    const next = new Map(byRkey);
    for (const rkey of targets) {
      const watch = byRkey.get(rkey)!;
      clearedAt.set(rkey, now);
      next.set(rkey, { ...watch, unseen: 0, events: [], seenAt: now });
    }
    byRkey = next;
    api.markSaveWatchesSeen(rkeys === 'all' ? 'all' : targets).catch((e) => {
      // The updates come back on the next load; nothing to roll back here.
      console.error('[savedWatches] Failed to mark seen:', e);
    });
  }

  return {
    load,
    setWatching,
    get limit() {
      return limit;
    },
    get count() {
      return byRkey.size;
    },
    /** Whether the list has loaded for this account (so a switch can show its state). */
    get loaded() {
      return loadedFor !== null && loadedFor === (auth.user?.did ?? null);
    },
    isWatched(rkey: string): boolean {
      return byRkey.has(rkey);
    },
    unseen(rkey: string): number {
      return byRkey.get(rkey)?.unseen ?? 0;
    },
    get(rkey: string): SaveWatch | undefined {
      return byRkey.get(rkey);
    },
    markSeen(rkey: string): void {
      clear([rkey]);
    },
    markAllSeen(): void {
      clear('all');
    },
    /** Every watched save's updates, for the bell's daily digest. */
    get withNews(): SaveWatch[] {
      return [...byRkey.values()].filter((w) => w.unseen > 0);
    },
    /** The saves among `saves` with unseen updates, newest news first: the Watching lane. */
    unseenFor(saves: SavedItem[]): { save: SavedItem; watch: SaveWatch }[] {
      const news = [...byRkey.values()].filter((w) => w.unseen > 0);
      if (news.length === 0) return [];
      const saveByRkey = new Map(saves.map((save) => [save.rkey, save]));
      return news
        .filter((w) => saveByRkey.has(w.rkey))
        .sort((a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0))
        .map((watch) => ({ save: saveByRkey.get(watch.rkey)!, watch }));
    },
  };
}

export const savedWatchesStore = createSavedWatchesStore();
