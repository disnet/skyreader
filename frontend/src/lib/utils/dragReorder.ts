/**
 * Geometry for dragging a row through a list, the rows laid out top to bottom.
 * `rects` are the rows' boxes measured when the drag lifted, in list order, and
 * the list keeps that DOM order for the whole drag: the dragged row follows the
 * pointer by `dy`, and the rows it passes slide aside by a transform, so nothing
 * is re-laid-out (and nothing jumps) until the drop commits the new order.
 */
export interface RowRect {
  top: number;
  bottom: number;
}

const mid = (r: RowRect) => (r.top + r.bottom) / 2;

/** How far the dragged row may travel: from the top of the list to its bottom. */
export function clampDrag(rects: RowRect[], from: number, dy: number): number {
  const min = rects[0].top - rects[from].top;
  const max = rects[rects.length - 1].bottom - rects[from].bottom;
  return Math.max(min, Math.min(max, dy));
}

/**
 * The slot the row from `from` would drop into, its centre moved by `dy`: it
 * takes a neighbour's place once its centre reaches the neighbour's. Reaching
 * counts, since a row held at the end of the list (clampDrag) sits exactly there.
 */
export function dragSlot(rects: RowRect[], from: number, dy: number): number {
  const centre = mid(rects[from]) + dy;
  let slot = from;
  while (slot < rects.length - 1 && centre >= mid(rects[slot + 1])) slot++;
  while (slot > 0 && centre <= mid(rects[slot - 1])) slot--;
  return slot;
}

/** How far a row the drag passes slides to make room: the dragged row's height plus the gap. */
export function makeWayOffset(rects: RowRect[], from: number, slot: number, index: number): number {
  if (index === from) return 0;
  const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 0;
  const pitch = rects[from].bottom - rects[from].top + gap;
  if (index > from && index <= slot) return -pitch;
  if (index < from && index >= slot) return pitch;
  return 0;
}

/** Where the dragged row comes to rest in `slot`, as an offset from where it started. */
export function settleOffset(rects: RowRect[], from: number, slot: number): number {
  if (slot > from) return rects[slot].bottom - rects[from].bottom;
  if (slot < from) return rects[slot].top - rects[from].top;
  return 0;
}
