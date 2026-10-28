// A long nav list (the Shelf's collections, in the sidebar and the mobile
// switcher) shows a few rows and a "Show N more" row, so the Library doesn't
// push everything below it off the screen. The few are the pinned ones (the
// Shelf row's pins), topped up from the top of the list; the row you're on
// shows too, on top of those, so the list never hides where you are. Rows keep
// their places in the list's order. Reordering waits for the whole list: moved
// among a few, a row could land among the hidden ones and vanish.

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
  if (items.length <= limit + 1) return { shown: items, hidden: 0, collapsible: false };
  const pinned = items.map(keep.pinned);
  let room = limit - pinned.filter(Boolean).length;
  const shown = items.filter((item, i) => {
    if (pinned[i]) return true;
    if (room > 0) {
      room--;
      return true;
    }
    return keep.open(item);
  });
  const hidden = items.length - shown.length;
  if (hidden < 2) return { shown: items, hidden: 0, collapsible: false };
  return showAll
    ? { shown: items, hidden: 0, collapsible: true }
    : { shown, hidden, collapsible: true };
}
