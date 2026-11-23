import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import { getItemTitle } from '$lib/utils/displayItem';
import { readProgressKeys } from '$lib/utils/readProgressKeys';
import { FINISHED_FRACTION, progressFraction } from '$lib/utils/shelf';
import {
  DESK_FULL_LINE,
  EMPTY_DESK,
  addToDesk,
  deskStorageKey,
  noteOpened,
  parseDesk,
  previousPiece,
  removeFromDesk,
  type DeskEntry,
  type DeskState,
} from '$lib/utils/desk';
import { auth } from './auth.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { savesStore } from './saves.svelte';
import { toastStore } from './toast.svelte';

/**
 * The Desk: the handful of pieces a reader has open in one sitting, to flip
 * between from inside the reader (its Desk button, or `` ` `` for the piece open
 * before this one). Not a pile: the Queue and the Shelf are where things are
 * kept. A piece leaves the Desk when it's read through or archived.
 *
 * Kept per device, per account, in localStorage: a sitting happens on one
 * screen, and nothing about it needs the server. Switching pieces goes through
 * the reader stack (`switchKeyInReader`), which reopens each at its saved place.
 */

function ownerKey(): string | null {
  const did = auth.user?.did;
  if (did) return did;
  return auth.isGuest ? 'guest' : null;
}

function readStored(owner: string): DeskState {
  try {
    const raw = localStorage.getItem(deskStorageKey(owner));
    return raw ? parseDesk(JSON.parse(raw)) : EMPTY_DESK;
  } catch {
    return EMPTY_DESK;
  }
}

function writeStored(owner: string, state: DeskState) {
  try {
    localStorage.setItem(deskStorageKey(owner), JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the Desk still works for this tab.
  }
}

/** The Desk row for a reader item, from what the reader already knows about it. */
export function deskEntryFor(item: FeedDisplayItem, source: string): DeskEntry {
  return {
    key: item.key,
    title: getItemTitle(item),
    source,
    progressKeys: readProgressKeys(item, (k) => savesStore.find(k)),
  };
}

/** How far through an entry is, 0–1, or null when it hasn't been started. */
export function deskProgress(entry: DeskEntry): number | null {
  const activity = itemLabelsStore.getReadActivity(entry.progressKeys);
  return progressFraction(activity?.progress);
}

function isDone(entry: DeskEntry): boolean {
  if (entry.stays) return false;
  return isFinishedOrArchived(entry);
}

function isFinishedOrArchived(entry: DeskEntry): boolean {
  const fraction = deskProgress(entry);
  if (fraction !== null && fraction >= FINISHED_FRACTION) return true;
  return entry.progressKeys.some((k) => itemLabelsStore.isArchived(k));
}

function createDeskStore() {
  let owner = $state<string | null>(null);
  // The items behind this session's rows. Most keys resolve from the stores, but
  // some pieces exist only in the stack that opened them (a follows link's or a
  // room's extracted page), so a switch back to one needs the item itself. Not
  // persisted: after a reload such a row says it's unavailable.
  const items = new Map<string, FeedDisplayItem>();
  let desk = $state<DeskState>(EMPTY_DESK);

  $effect.root(() => {
    $effect(() => {
      const next = ownerKey();
      if (next === owner) return;
      owner = next;
      items.clear();
      desk = next ? readStored(next) : EMPTY_DESK;
    });
  });

  function commit(next: DeskState) {
    if (next === desk) return;
    desk = next;
    if (owner) writeStored(owner, next);
  }

  return {
    get entries(): DeskEntry[] {
      return desk.entries;
    },
    has(key: string): boolean {
      return desk.entries.some((e) => e.key === key);
    },
    /** Put a piece on the Desk. False (with a toast) when it's full. */
    add(entry: DeskEntry): boolean {
      const next = addToDesk(desk, isFinishedOrArchived(entry) ? { ...entry, stays: true } : entry);
      if (!next) {
        toastStore.update(toastStore.add(''), 'error', DESK_FULL_LINE);
        return false;
      }
      commit(next);
      return true;
    },
    remove(key: string) {
      commit(removeFromDesk(desk, key));
    },
    /** The reader opened `entry`: remember it for the toggle. */
    noteOpened(entry: DeskEntry, item: FeedDisplayItem) {
      items.set(entry.key, item);
      commit(noteOpened(desk, entry));
    },
    /** The item behind a row this session opened, for keys the stores can't resolve. */
    itemFor(key: string): FeedDisplayItem | undefined {
      return items.get(key);
    },
    /** The piece open before `currentKey`, if any. */
    previous(currentKey: string): DeskEntry | null {
      return previousPiece(desk, currentKey);
    },
    /**
     * Take finished and archived pieces off, except the open one: you may be
     * reading its last lines. Run when the reader opens something.
     */
    tidy(currentKey: string) {
      let next = desk;
      for (const entry of desk.entries) {
        if (entry.key !== currentKey && isDone(entry)) next = removeFromDesk(next, entry.key);
      }
      commit(next);
    },
  };
}

export const deskStore = createDeskStore();
