// Open another item over the reader that's up, from inside it: a save's "From …"
// line, or a row of an article's "Saved from this" list.
//
// The reader stack (`useReaderStack`) already reopens a level from a history
// entry deeper than its stack (that's how Forward works), so a push one level
// down, with the item's key as `?read=`, opens it with Back to return.
import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';
import { readerUrl } from '$lib/utils/readerLink';

/**
 * Push the item with reader key `key` onto the open reader stack. False where
 * there is no page stack to take it (the search overlay keeps its own), so the
 * caller can open the page another way.
 */
export function openKeyInReader(key: string): boolean {
  if (page.state.searchOpen) return false;
  const depth = page.state.readerDepth ?? 0;
  pushState(readerUrl(new URL(location.href), key), { ...page.state, readerDepth: depth + 1 });
  return true;
}

// Seeded from the clock so a counter restarted by a reload never repeats one
// still sitting in an older history entry's state.
let swaps = Date.now();

/**
 * Put the item with reader key `key` in place of the one that's open, at the
 * same depth: a Desk switch. Replacing, not pushing, so flipping between two
 * pieces doesn't pile up history and Back still closes the reader. False when
 * no reader is open.
 */
export function switchKeyInReader(key: string): boolean {
  const depth = page.state.readerDepth ?? 0;
  if (depth === 0) return false;
  swaps += 1;
  replaceState(readerUrl(new URL(location.href), key), { ...page.state, readerSwap: swaps });
  return true;
}
