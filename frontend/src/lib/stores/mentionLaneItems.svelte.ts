// The people inside one mention lane (Phase 5 "see existing items").
//
// The always-on counts come from articleMentions; this store resolves the
// *actual references* for a single lane — who noted / posted / highlighted /
// saved this URL, with their note and a link out — only when the user expands
// that lane. It's the expensive path (a per-record PDS fetch each), so it's
// strictly lazy: nothing loads until expand, results are memoized per
// (url, lane) for the session, and an in-flight request is shared. Adornment
// only: a failure degrades to an empty list.

import { api } from '$lib/services/api';
import type { MentionLaneEntry } from '$lib/types';

export type LaneItemsState = {
  loading: boolean;
  loaded: boolean;
  /**
   * The resolve failed. Kept (rather than dropping the key) so the surface can
   * say so instead of showing an empty lane or spinning forever — and so an
   * automatic re-read can't turn a failing lane into a retry loop. `load` skips
   * a failed lane unless the caller forces it.
   */
  failed: boolean;
  entries: MentionLaneEntry[];
};

const LOADING: LaneItemsState = { loading: true, loaded: false, failed: false, entries: [] };

function keyFor(url: string, lane: string): string {
  return `${lane}|${url}`;
}

function createMentionLaneItemsStore() {
  let cache = $state<Map<string, LaneItemsState>>(new Map());
  // Shared in-flight promises so two expands of the same lane don't double-fetch.
  const inFlight = new Map<string, Promise<void>>();

  function set(key: string, state: LaneItemsState) {
    const next = new Map(cache);
    next.set(key, state);
    cache = next;
  }

  // Kick off resolution for a lane. No-op once loaded or in flight. Safe to call
  // every time a lane is expanded.
  function load(url: string, lane: string, options?: { force?: boolean }): void {
    if (!url) return;
    const key = keyFor(url, lane);
    const existing = cache.get(key);
    if (existing?.loaded || inFlight.has(key)) return;
    if (existing?.failed && !options?.force) return;

    set(key, LOADING);
    const p = api
      .fetchMentionLaneItems(url, lane)
      .then((res) => {
        set(key, { loading: false, loaded: true, failed: false, entries: res.entries ?? [] });
      })
      .catch((e) => {
        console.error('Failed to fetch mention lane items:', e);
        // Adornment, so this never breaks the read — but it is recorded, so the
        // surface can offer the retry rather than pretending nobody wrote.
        set(key, { loading: false, loaded: false, failed: true, entries: [] });
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, p);
  }

  // The resolved state for a (url, lane), or undefined before the first load.
  // Reactive.
  function get(url: string, lane: string): LaneItemsState | undefined {
    return cache.get(keyFor(url, lane));
  }

  return { load, get };
}

export const mentionLaneItemsStore = createMentionLaneItemsStore();
