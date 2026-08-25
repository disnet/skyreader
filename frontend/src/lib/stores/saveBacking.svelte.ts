// Which engine backs the Saved list, cached for surfaces that only need to read it.
//
// The collection picker needs this to protect one row: if the user's Saved list IS
// a Semble/Margin collection, unchecking that collection here would silently unsave
// the article on the next membership poll. The picker locks that row instead, and to
// do that it has to know the backing target.
//
// Best-effort by design: a failed lookup leaves `backing` null and the picker simply
// renders no locked row. The settings page owns changing the backing; this store only
// reads it, refreshing in the background whenever a caller asks.
import { api } from '$lib/services/api';
import type { SaveBacking } from '$lib/types';

function createSaveBackingStore() {
  let backing = $state<SaveBacking | null>(null);
  let loaded = $state(false);
  let inFlight: Promise<void> | null = null;

  /** Refresh from the server, deduping concurrent callers. Never throws. */
  async function load(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const settings = await api.getSettings();
        backing = settings.backing;
      } catch (err) {
        console.error('Failed to load save backing:', err);
      } finally {
        loaded = true;
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** Push a known-good value (the settings page just changed it). */
  function set(next: SaveBacking) {
    backing = next;
  }

  return {
    get backing() {
      return backing;
    },
    get loaded() {
      return loaded;
    },
    load,
    set,
  };
}

export const saveBackingStore = createSaveBackingStore();
