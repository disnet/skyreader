// The open article, as a URL.
//
// The reader stays an overlay stack rather than a route (see the Reader FDR and
// `useReaderStack`), but each level now rides a shallow-routed URL: the current
// path and query, plus `?read=<item key>`. That makes a reading session
// reloadable, linkable and bookmarkable — and lets Forward reopen what Back
// closed — without unmounting the list underneath or losing its scroll position.
//
// The key in the URL is exactly `FeedDisplayItem.key` (article → guid, document →
// at:// record uri, save → uri/itemGuid/rkey), the same key `item_labels_cache`
// and the highlight aliases use. Resolution matches every alias of a save, so a
// link written before an external backing engine attached a `uri` still opens.
import { savedItemDisplayKey } from '$lib/utils/dailyMagazine';
import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import type { Article, SavedItem, SocialDocument } from '$lib/types';

/** The query parameter carrying the open article's key. */
export const READ_PARAM = 'read';

/**
 * `url` with `read` set to `key` (or removed when null), as a path+query string
 * suitable for `pushState`/`replaceState`. Every other parameter is preserved,
 * so the surface (`?feed=`, `?view=`, `?category=`) survives an open and a close.
 */
export function readerUrl(url: URL, key: string | null): string {
  const next = new URL(url);
  if (key === null) next.searchParams.delete(READ_PARAM);
  else next.searchParams.set(READ_PARAM, key);
  return next.pathname + next.search + next.hash;
}

/** The stores a reader key is resolved against, in the order they're consulted. */
export interface ReaderKeySources {
  /** Saved items (`savesStore.articles`). */
  saves: SavedItem[];
  /** Article lookup by guid (`articlesStore.getByGuid`). */
  getArticle: (guid: string) => Article | undefined;
  /** Loaded documents (`socialStore.documents`). */
  documents: SocialDocument[];
}

/**
 * Resolve a `read` key against the local stores, saves first.
 *
 * Deliberately bypasses `feedViewStore.currentItems`: that list is filter- and
 * pagination-dependent, so a link to an item outside the current filter (or below
 * the loaded page) would not resolve. The reader opens over the list either way;
 * the list underneath simply won't contain the item, and closing lands on its top.
 */
export function resolveReaderItem(key: string, sources: ReaderKeySources): FeedDisplayItem | null {
  const save = sources.saves.find(
    (item) => item.uri === key || item.itemGuid === key || item.rkey === key
  );
  // The item is re-keyed to the save's *current* preferred key, so a link written
  // under a stale alias reopens under (and rewrites to) the canonical one.
  if (save) return { type: 'saved', item: save, key: savedItemDisplayKey(save) };

  const article = sources.getArticle(key);
  if (article) return { type: 'article', item: article, key: article.guid };

  const doc = sources.documents.find((item) => item.recordUri === key);
  if (doc) return { type: 'document', item: doc, key: doc.recordUri };

  return null;
}

/**
 * Network fallback for a key no store knows: documents are public, so a shared
 * `at://` link opens even when the recipient has never loaded that document.
 * Everything else (feed items, saves) is personal to its owner and can only come
 * from the local stores, so those keys resolve to null and the caller gives up.
 */
export async function fetchReaderDocument(
  key: string,
  fetchDoc: (uri: string) => Promise<SocialDocument | null>
): Promise<FeedDisplayItem | null> {
  if (!key.startsWith('at://')) return null;
  try {
    const doc = await fetchDoc(key);
    return doc ? { type: 'document', item: doc, key: doc.recordUri } : null;
  } catch {
    return null;
  }
}
