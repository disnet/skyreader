import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import type { SavedItem } from '$lib/types';
import { savedItemLabelKeys } from '$lib/utils/savedPile';

/**
 * Every key the reading position of a reader item may be filed under.
 *
 * The reader writes `readProgress` under the display key of whichever surface
 * opened it, and a save has several: its AT-URI (or, for a save made a moment
 * ago that has none yet, its guid or rkey), or its URL from a link. So the same
 * save read on two devices, or reached from two surfaces, can hold its place
 * under different keys, and restoring from the open key alone started it at the
 * top while Home's Continue reading (which already looks across these) showed it
 * half read. Restore reads the newest position across all of them.
 *
 * Only a save's own identities count. A paragraph index means something only in
 * the body it was counted in, and a feed article's RSS body and the save's
 * extracted one differ, so a feed article or document keeps its own key.
 *
 * `findSave` looks a save up by guid or URL (`savesStore.find`): the live row,
 * whose uri may have arrived since the reader was opened.
 */
export function readProgressKeys(
  item: FeedDisplayItem,
  findSave: (guidOrUrl: string) => SavedItem | undefined
): string[] {
  if (item.type !== 'saved') return [item.key];
  const keys = new Set<string>([item.key, ...savedItemLabelKeys(item.item)]);
  const { itemGuid, url } = item.item;
  const live = (itemGuid ? findSave(itemGuid) : undefined) ?? (url ? findSave(url) : undefined);
  if (live) for (const key of savedItemLabelKeys(live)) keys.add(key);
  return [...keys];
}
