// The last few articles the reader has *read*, newest first: the likely other
// end of a Semble connection, offered as cards at the end of an article and in
// the Connect dialog. "That" is usually something just finished, not
// something saved for later.
//
// This device's reads, plus saves read anywhere (their read activity is
// server-side), so a fresh device still has something to offer. Only reading
// in the reader counts for a save: a `read` mark is also stamped by Mark all
// read and by read state arriving on a fetch, so it would put unopened saves
// on top as "Read just now".
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { recentReadsStore, sameArticle } from '$lib/stores/recentReads.svelte';
import { savesStore } from '$lib/stores/saves.svelte';
import { savedItemLabelKeys } from '$lib/utils/savedPile';
import { urlKey } from '$lib/utils/urlKey';
import type { SavedItem } from '$lib/types';

export interface RecentlyRead {
  key: string;
  url: string;
  title?: string;
  domain?: string;
  /** When it was last read (ms). */
  at: number;
}

/** Enough to choose from at a glance; the search is for the rest. */
export const RECENTLY_READ_LIMIT = 5;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** When a save was last read in the reader (scrolled through, or a PDF's place kept), or 0. */
function openedAt(item: SavedItem): number {
  let at = 0;
  for (const key of savedItemLabelKeys(item)) {
    if (!key) continue;
    for (const label of ['readProgress', 'pdfPlace']) {
      const found = itemLabelsStore.getLabel(key, label);
      if (!found) continue;
      at = Math.max(at, (found.props.lastReadAt as number) || found.updatedAt || 0);
    }
  }
  return at;
}

/**
 * The newest reads, one per article, leaving out `exclude` (in any URL
 * variant) before the cap, so what's left over keeps every slot. Reactive
 * inside a $derived.
 */
export function recentlyRead(
  exclude: Array<string | null | undefined>,
  limit = RECENTLY_READ_LIMIT
): RecentlyRead[] {
  const skip = exclude.filter((url): url is string => Boolean(url));
  const dated: RecentlyRead[] = [
    ...recentReadsStore.entries
      .filter((entry) => isHttpUrl(entry.url))
      .map((entry) => ({
        key: `recent:${entry.url}`,
        url: entry.url,
        title: entry.title,
        at: entry.at,
      })),
    ...savesStore.articles.flatMap((item) => {
      const at = openedAt(item);
      if (!at || !isHttpUrl(item.url)) return [];
      return [
        {
          // Not the uri: saves live only in D1 and have no record uri.
          key: `saved:${item.rkey}`,
          url: item.url,
          title: item.title ?? undefined,
          domain: item.domain ?? undefined,
          at,
        },
      ];
    }),
  ].sort((a, b) => b.at - a.at);
  const byKey = new Map<string, RecentlyRead>();
  for (const item of dated) {
    if (skip.some((url) => sameArticle(item.url, url))) continue;
    const key = urlKey(item.url) ?? item.url;
    const kept = byKey.get(key);
    if (kept) {
      // The newest entry stands; an older one can still lend it a title.
      if (!kept.title && item.title) byKey.set(key, { ...kept, title: item.title });
      continue;
    }
    if (byKey.size >= limit) continue;
    byKey.set(key, item);
  }
  return [...byKey.values()];
}
