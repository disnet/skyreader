import type { SavedItem } from '$lib/types';
import type { FeedDisplayItem } from './feedView.svelte';
import { auth } from './auth.svelte';
import { savesStore } from './saves.svelte';

/**
 * Multi-select in the Library (Queue and Shelf), for filing many saves in a
 * collection, or taking them out, at once.
 *
 * Selection is by the save's rkey, the same key collections hold. A page shows
 * one list at a time, so the store keeps one set; each page reads it through
 * its own list (`selectedIn`), which means a selected save that's filtered out
 * of view is never acted on unseen. Leaving the page, or another collection,
 * ends the selection.
 */

/** The save behind a Queue row: a feed article or document is saved under its
 *  guid / record uri, or its url. */
export function saveForRow(row: FeedDisplayItem): SavedItem | undefined {
  if (row.type === 'saved') return row.item;
  const url = row.type === 'article' ? row.item.url : row.item.canonicalUrl || row.item.path || '';
  return savesStore.find(row.key) ?? (url ? savesStore.find(url) : undefined);
}

function createLibrarySelection() {
  let active = $state(false);
  let selected = $state<ReadonlySet<string>>(new Set());

  return {
    /** Whether select mode is on offer: collections are account-only, so it is too. */
    get available() {
      return Boolean(auth.user) && !auth.isGuest;
    },
    /** Whether the Library is in select mode: a tap toggles instead of opening. */
    get active() {
      return active && Boolean(auth.user) && !auth.isGuest;
    },
    start() {
      active = true;
    },
    /** Leave select mode, dropping the selection. */
    end() {
      active = false;
      if (selected.size) selected = new Set();
    },
    has(rkey: string): boolean {
      return selected.has(rkey);
    },
    toggle(rkey: string) {
      const next = new Set(selected);
      if (!next.delete(rkey)) next.add(rkey);
      selected = next;
    },
    /** Select every save in `saves` (keeping any already selected). */
    selectAll(saves: Pick<SavedItem, 'rkey'>[]) {
      const next = new Set(selected);
      for (const save of saves) next.add(save.rkey);
      selected = next;
    },
    clear() {
      if (selected.size) selected = new Set();
    },
    /** The selected saves among `saves`, in their order. */
    selectedIn<T extends Pick<SavedItem, 'rkey'>>(saves: T[]): T[] {
      if (selected.size === 0) return [];
      return saves.filter((save) => selected.has(save.rkey));
    },
  };
}

export const librarySelection = createLibrarySelection();
