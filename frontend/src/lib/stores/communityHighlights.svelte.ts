import { api } from '$lib/services/api';
import { auth } from '$lib/stores/auth.svelte';
import type { CommunityHighlightNote, TextQuoteSelector } from '$lib/types';

export interface CommunityHighlightGroup {
  id: string;
  selector: TextQuoteSelector;
  people: CommunityHighlightNote[];
}
export interface CommunityHighlightsState {
  loading: boolean;
  loaded: boolean;
  failed: boolean;
  capped: boolean;
  groups: CommunityHighlightGroup[];
}

function createStore() {
  let cache = $state(new Map<string, CommunityHighlightsState>());
  const inFlight = new Map<string, Promise<void>>();
  const keyFor = (url: string) => {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  };
  const set = (key: string, value: CommunityHighlightsState) => {
    cache = new Map(cache).set(key, value);
  };
  function load(url: string, options?: { force?: boolean }) {
    if (!url || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
    const key = keyFor(url);
    const old = cache.get(key);
    if (old?.loaded || inFlight.has(key) || (old?.failed && !options?.force)) return;
    set(key, { loading: true, loaded: false, failed: false, capped: false, groups: [] });
    // Same public answer either way; a guest has no session for the /api/v2
    // path, and calling it without one 401s and drags the client through a
    // /api/auth/me probe that logs a logout which never happens.
    const promise = (
      auth.user ? api.fetchCommunityHighlights(url) : api.fetchGuestCommunityHighlights(url)
    )
      .then((res) => {
        const ownDid = auth.user?.did;
        const merged = new Map<string, CommunityHighlightGroup>();
        for (const note of res.notes.filter((n) => n.did !== ownDid)) {
          const group = merged.get(note.selector.exact);
          if (group) group.people.push(note);
          else
            merged.set(note.selector.exact, {
              id: `community-${merged.size}`,
              selector: note.selector,
              people: [note],
            });
        }
        set(key, {
          loading: false,
          loaded: true,
          failed: false,
          capped: res.capped,
          groups: [...merged.values()],
        });
      })
      .catch(() =>
        set(key, { loading: false, loaded: false, failed: true, capped: false, groups: [] })
      )
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
  }
  return { load, get: (url: string) => cache.get(keyFor(url)) };
}
export const communityHighlightsStore = createStore();
