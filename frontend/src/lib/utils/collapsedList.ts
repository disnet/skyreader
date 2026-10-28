// A long nav list (the Shelf's collections, in the sidebar and the mobile
// switcher) shows a few rows and a "Show N more" row, so the Library doesn't
// push everything below it off the screen. The few are the pinned ones (the
// Shelf row's pins), topped up from the top of the list; the row you're on
// shows too, on top of those, so the list never hides where you are. Rows keep
// their places in the list's order.

/** Rows a collapsed list shows (pins past it all show). */
export const COLLAPSED_LIMIT = 5;

/**
 * The rows to show and how many are hidden. A list only collapses when it
 * would hide at least two: "Show 1 more" takes the row it saves.
 */
export function collapseList<T>(
  items: T[],
  showAll: boolean,
  keep: { pinned: (item: T) => boolean; open: (item: T) => boolean },
  limit = COLLAPSED_LIMIT
): { shown: T[]; hidden: number; collapsible: boolean } {
  const collapsible = items.length > limit + 1;
  if (!collapsible || showAll) return { shown: items, hidden: 0, collapsible };
  let room = limit - items.filter(keep.pinned).length;
  const shown = items.filter((item) => {
    if (keep.pinned(item)) return true;
    if (room > 0) {
      room--;
      return true;
    }
    return keep.open(item);
  });
  return { shown, hidden: items.length - shown.length, collapsible };
}

/**
 * The full order after `id` moved within the shown rows to where it sits in
 * `shownOrder`: it lands next to its new neighbour there (after the one above,
 * or before the one below when it's first), and the hidden rows keep their
 * places. With every row shown that is just `shownOrder`.
 */
export function moveAmongShown(full: string[], shownOrder: string[], id: string): string[] {
  const k = shownOrder.indexOf(id);
  if (k === -1 || !full.includes(id)) return full;
  const rest = full.filter((x) => x !== id);
  const at =
    k > 0
      ? rest.indexOf(shownOrder[k - 1]) + 1
      : shownOrder.length > 1
        ? rest.indexOf(shownOrder[1])
        : 0;
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
