import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import type { SavedItem } from '$lib/types';
import { savedItemLabelKeys } from '$lib/utils/savedPile';

/**
 * Every key the reading position of a reader item may be filed under.
 *
 * The reader writes `readProgress` under the display key of whichever surface
 * opened it: a feed article's guid, a save's AT-URI (or, for a save made a
 * moment ago that has none yet, its guid or rkey), a link's URL. So the same
 * article read on two devices, or reached from two surfaces, can hold its place
 * under different keys, and restoring from the open key alone started it at the
 * top while Home's Continue reading (which already looks across these) showed it
 * half read. Restore reads the newest position across all of them.
 *
 * `findSave` looks a save up by guid or URL (`savesStore.find`). For a save it
 * returns the live row, whose uri may have arrived since the reader was opened.
 */
export function readProgressKeys(
  item: FeedDisplayItem,
  findSave: (guidOrUrl: string) => SavedItem | undefined
): string[] {
  const keys = new Set<string>([item.key]);
  const add = (key: string | undefined | null) => {
    if (key) keys.add(key);
  };

  let guid: string | undefined;
  let url: string | undefined;
  if (item.type === 'saved') {
    for (const key of savedItemLabelKeys(item.item)) add(key);
    guid = item.item.itemGuid;
    url = item.item.url;
  } else if (item.type === 'article') {
    guid = item.item.guid;
    url = item.item.url;
  } else {
    guid = item.item.recordUri;
    url = item.item.canonicalUrl;
  }
  add(guid);
  add(url);

  const save = (guid ? findSave(guid) : undefined) ?? (url ? findSave(url) : undefined);
  if (save) for (const key of savedItemLabelKeys(save)) add(key);

  return [...keys];
}
