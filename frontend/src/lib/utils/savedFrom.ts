// Where a save came from: the article the reader was in when they saved a link
// out of it (`SavedItem.savedFromUrl`, set by the reader's link menu). Three
// surfaces read it: the save's own "From …" line, the article's "Saved from
// this" list, and the Library's `?from=` filter. All three match the article
// by canonical URL, so `/post`, `/post/` and `/post?utm_source=…` are one.
import type { SavedItem } from '$lib/types';
import { urlKey } from '$lib/utils/urlKey';

/** The canonical key an article is matched on, or null for no web URL. */
export function savedFromKey(url: string | null | undefined): string | null {
  if (!url) return null;
  return urlKey(url) ?? url;
}

/** True when `save` was saved out of the article whose key is `key`. */
export function savedFromMatches(save: SavedItem, key: string | null): boolean {
  if (!key || !save.savedFromUrl) return false;
  return savedFromKey(save.savedFromUrl) === key;
}

/**
 * The saves made out of the article at `url`, newest first. Empty for an
 * article with no web URL.
 */
export function savesFrom(
  saves: readonly SavedItem[],
  url: string | null | undefined
): SavedItem[] {
  const key = savedFromKey(url);
  if (!key) return [];
  return saves
    .filter((save) => savedFromMatches(save, key))
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/** The source's name for a "From …" line: its title, else its host. */
export function savedFromLabel(save: Pick<SavedItem, 'savedFromUrl' | 'savedFromTitle'>): string {
  const title = save.savedFromTitle?.trim();
  if (title) return title;
  try {
    return new URL(save.savedFromUrl ?? '').hostname.replace(/^www\./, '');
  } catch {
    return save.savedFromUrl ?? '';
  }
}

/** The Library, filtered to what was saved out of the article at `url`. */
export function savedFromLibraryHref(url: string): string {
  return `/saved?from=${encodeURIComponent(url)}`;
}
