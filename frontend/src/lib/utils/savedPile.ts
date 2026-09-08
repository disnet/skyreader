import type { SavedItem } from '$lib/types';

/**
 * The saved pile's shared rules.
 *
 * Two surfaces render the same pile — the Saved list (`feedView`'s
 * `computeSavedItems`) and Home's "Recently saved" lane — and they used to
 * decide membership and order independently. Every rule they disagreed on was
 * visible as the same item sitting in one surface and missing from the other,
 * or the two showing different "newest" items. These helpers are the single
 * definition both consume.
 */

/**
 * Every key a save can carry a label under.
 *
 * One save is reachable by several identities: the feed item's guid, its
 * atproto record uri, the article url, and the record rkey. Whichever one the
 * surface writing an `archived` label happened to hold is the one the label
 * landed on — the `e` shortcut writes the display key alone, while the list
 * rows write the display key *and* the itemGuid. `rkey` belongs in the set
 * because an optimistic save has no `uri` yet (`saveArticle` leaves it empty)
 * and every display-key helper falls back to the rkey.
 *
 * Order matters: callers take `[0]` as the item's primary key.
 */
export function savedItemLabelKeys(item: SavedItem): string[] {
  return [item.itemGuid, item.uri, item.url, item.rkey].filter(
    (key): key is string => typeof key === 'string' && key.length > 0
  );
}

/**
 * The one archived test for a save. Testing a single key is what let the Home
 * lane and the Saved list disagree about the same item: archive it with `e` in
 * the list (which labels the record uri) and the list kept showing it while
 * Home dropped it.
 */
export function isSavedItemArchived(
  item: SavedItem,
  isArchived: (key: string) => boolean
): boolean {
  return savedItemLabelKeys(item).some((key) => isArchived(key));
}

/**
 * Put every identity for a save into one archive state.
 *
 * Archive membership is true when any alias is archived, so toggling just the
 * key a row happens to display cannot reliably undo it. In particular, an old
 * URL- or rkey-backed label would keep the item in Archive after the row's
 * guid/uri was unarchived. Callers provide the store mutation so this rule
 * stays independently testable and every UI path uses the same alias set.
 */
export async function setSavedItemArchived(
  item: SavedItem,
  archived: boolean,
  setArchived: (key: string, archived: boolean) => void | Promise<void>
): Promise<void> {
  for (const key of new Set(savedItemLabelKeys(item))) {
    await setArchived(key, archived);
  }
}

/** `savedAt` in epoch ms; 0 when missing or unparseable, so it sorts last. */
export function savedAtMs(item: Pick<SavedItem, 'savedAt'>): number {
  const ms = item.savedAt ? Date.parse(item.savedAt) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Newest-first by `savedAt` — what the Saved list's default sort means and what
 * "Recently saved" claims to show. The rkey tie-break keeps a bulk import (a
 * backed collection can stamp many rows with the same second) in one stable
 * order instead of whatever order each surface happened to build its array in.
 */
export function compareSavedNewestFirst(a: SavedItem, b: SavedItem): number {
  const diff = savedAtMs(b) - savedAtMs(a);
  if (diff !== 0) return diff;
  return (b.rkey || '').localeCompare(a.rkey || '');
}
