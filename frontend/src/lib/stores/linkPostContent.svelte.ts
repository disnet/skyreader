// Inline full-article fetch for link posts (Linkblog Phase 2).
//
// A link post's primary content is an EXTERNAL article (see utils/linkPost.ts).
// When the user opens one, we fetch & render the full article in-app via the
// feed-proxy reader (api.extract), so reading stays inside Skyreader instead of
// bouncing to the browser.
//
// This is a session-scoped, in-memory cache keyed by external URL. The expensive
// work (fetch + Defuddle) is already persisted proxy-side in its extract_cache,
// so a per-session memo here is enough; no IndexedDB needed.

import { auth } from '$lib/stores/auth.svelte';
import { extractArticle, type ExtractedArticle } from '$lib/services/extract';

interface Entry {
  status: 'loading' | 'ready' | 'error';
  article?: ExtractedArticle;
}

function createLinkPostContentStore() {
  let entries = $state<Map<string, Entry>>(new Map());

  // Fetch the full article for `url`. No-op if it's already loading or loaded,
  // or if there's no session.
  //
  // Extraction is account-only, and deliberately so: /api/extract steers the
  // proxy into fetching a caller-named URL, which is exactly the thing
  // routes/guest.ts refuses to expose without an account. So this isn't a
  // gate worth routing around the way the mention lookups were — a guest reads
  // the RSS body, the same bargain their saves already make. Returning before
  // the map is touched also keeps `isFetching` false, so no spinner is raised
  // for a fetch that will never happen.
  //
  // Calling anyway costs more than a wasted 401: the api client answers one by
  // probing /api/auth/me, which 401s too and logs "Session expired or invalid,
  // logging out" for a logout that never happens.
  async function fetch(url: string) {
    if (!url || entries.has(url) || !auth.user) return;

    entries.set(url, { status: 'loading' });
    entries = new Map(entries);

    try {
      const article = await extractArticle(url);
      entries.set(url, { status: 'ready', article });
    } catch (e) {
      console.error('Failed to fetch link-post article:', e);
      // Drop the entry so a later open can retry rather than pinning an error.
      entries.delete(url);
    }
    entries = new Map(entries);
  }

  // The fetched article for `url`, or undefined if not loaded yet.
  function get(url: string): ExtractedArticle | undefined {
    const entry = entries.get(url);
    return entry?.status === 'ready' ? entry.article : undefined;
  }

  function isFetching(url: string): boolean {
    return entries.get(url)?.status === 'loading';
  }

  return { fetch, get, isFetching };
}

export const linkPostContentStore = createLinkPostContentStore();
