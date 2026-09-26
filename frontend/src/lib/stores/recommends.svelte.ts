// Recommends — the reader's one-tap public recommendations.
//
// A recommend is an app.skyreader.social.recommend record in the reader's own
// repo (backend: /api/recommends), keyed by the article's URL so anything with a
// URL can be recommended. For a standard.site document the backend also writes a
// site.standard.graph.recommend, so the author sees it too.
//
// The server's list is the source of truth (it lives in D1, so it's the same on
// every device); this store mirrors it for the button state and toggles
// optimistically, rolling back if the write fails.

import { api, ScopeUpgradeError } from '$lib/services/api';
import { toastStore } from '$lib/stores/toast.svelte';
import { auth } from '$lib/stores/auth.svelte';

/**
 * The key two spellings of one article share: host case, a trailing slash and
 * the fragment don't make a different article. The backend normalizes harder
 * (tracking params), so this only has to agree with it on the common cases.
 */
function keyOf(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    let key = u.toString();
    if (u.pathname !== '/' && key.endsWith('/')) key = key.slice(0, -1);
    return key;
  } catch {
    return url;
  }
}

/** Only http(s) links can be recommended (the record's subject is a URL). */
export function isRecommendable(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function createRecommendsStore() {
  let keys = $state<Set<string>>(new Set());
  // Whose recommends `keys` holds. The set lives only in memory, so a sign-out
  // (which clears IndexedDB, not module state) must not leave one account's
  // recommends lit for the next.
  let owner = $state<string | undefined>(undefined);
  // Toggles in flight, by key, so a double tap doesn't race itself.
  const pending = new Set<string>();

  /** Point the store at the signed-in account, dropping another's state. */
  function claim(): string | undefined {
    const did = auth.user?.did;
    if (did !== owner) {
      owner = did;
      keys = new Set();
    }
    return did;
  }

  /** Pull the reader's recommends from the server (the cross-device truth). */
  async function load(): Promise<void> {
    const did = claim();
    if (!did || auth.isGuest) return;
    try {
      const { recommends } = await api.getRecommends();
      if (owner !== did) return;
      const next = new Set<string>();
      for (const r of recommends) next.add(keyOf(r.url));
      // A toggle still in flight is newer than the list.
      for (const key of pending) {
        if (keys.has(key)) next.add(key);
        else next.delete(key);
      }
      keys = next;
    } catch (e) {
      console.warn('Failed to load recommends:', e);
    }
  }

  function isRecommended(url: string | undefined): boolean {
    return Boolean(url) && owner === auth.user?.did && keys.has(keyOf(url!));
  }

  function set(key: string, on: boolean) {
    const next = new Set(keys);
    if (on) next.add(key);
    else next.delete(key);
    keys = next;
  }

  /**
   * Recommend, or take a recommend back. `documentUri` is the site.standard.document
   * the article is, when it is one.
   */
  async function toggle(article: { url: string; title?: string; documentUri?: string }) {
    if (!claim()) return;
    const key = keyOf(article.url);
    if (pending.has(key)) return;
    pending.add(key);
    const wasOn = keys.has(key);
    set(key, !wasOn);
    try {
      if (wasOn) await api.unrecommend(article.url);
      else
        await api.recommend({
          url: article.url,
          title: article.title,
          documentUri: article.documentUri,
        });
    } catch (e) {
      set(key, wasOn);
      // The API client has already offered "Allow access" for a missing scope.
      if (!(e instanceof ScopeUpgradeError)) {
        toastStore.update(
          toastStore.add(''),
          'error',
          wasOn ? 'Couldn’t remove your recommend' : 'Couldn’t recommend this'
        );
      }
    } finally {
      pending.delete(key);
    }
  }

  return {
    load,
    isRecommended,
    toggle,
  };
}

export const recommendsStore = createRecommendsStore();
