// Drag a row of a sidebar list to a new place, so it feels like moving a thing:
// the row lifts and follows the pointer, the rows it passes slide aside to make
// room, and on release it settles into the gap before the new order commits.
// The list keeps its DOM order for the whole gesture (utils/dragReorder.ts), so
// nothing re-lays-out mid-drag and nothing jumps at the drop.
//
// Mouse and pen only: on touch a drag would fight the drawer's scroll, so the
// lists offer Move up / Move down on a long-press instead. A row lifts after a
// few pixels of travel, so a click still opens it, and the click that ends a
// drag is swallowed. Move/up are for the window to hear (see the caller's
// <svelte:window>): pointer capture would be lost if the list re-rendered.
import {
  clampDrag,
  dragSlot,
  makeWayOffset,
  settleOffset,
  type RowRect,
} from '$lib/utils/dragReorder';

const LIFT_PX = 5;
const SETTLE_MS = 180;

interface Drag {
  ids: string[];
  from: number;
  startY: number;
  rects: RowRect[] | null;
  dy: number;
  slot: number;
  settling: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

function swallowClick(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * `rows` returns the list's row elements in order (one per id); `onDrop` gets
 * the ids in their new order, only when it changed.
 */
export function useListDrag(options: {
  rows: () => HTMLElement[];
  onDrop: (order: string[]) => void;
}) {
  let drag = $state<Drag | null>(null);

  function start(e: PointerEvent, ids: string[], id: string) {
    if (drag || e.pointerType === 'touch' || e.button !== 0 || ids.length < 2) return;
    const from = ids.indexOf(id);
    if (from === -1) return;
    drag = { ids, from, startY: e.clientY, rects: null, dy: 0, slot: from, settling: false };
  }

  function move(e: PointerEvent) {
    const d = drag;
    if (!d || d.settling) return;
    if (!d.rects) {
      if (Math.abs(e.clientY - d.startY) < LIFT_PX) return;
      const rows = options.rows();
      if (rows.length !== d.ids.length) {
        drag = null;
        return;
      }
      d.rects = rows.map((row) => {
        const r = row.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
    }
    // The page mustn't select text out from under the drag.
    e.preventDefault();
    d.dy = clampDrag(d.rects, d.from, e.clientY - d.startY);
    d.slot = dragSlot(d.rects, d.from, d.dy);
  }

  function end() {
    const d = drag;
    if (!d || d.settling) return;
    if (!d.rects) {
      drag = null;
      return;
    }
    // The release lands as a click on the row, which would open it.
    window.addEventListener('click', swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }));

    const commit = () => {
      const order = [...d.ids];
      const [moved] = order.splice(d.from, 1);
      order.splice(d.slot, 0, moved);
      // Re-order first, then drop the transforms in the same frame: every row is
      // already drawn where its new place is, so the swap doesn't show.
      if (d.slot !== d.from) options.onDrop(order);
      drag = null;
    };
    if (prefersReducedMotion()) {
      commit();
      return;
    }
    d.settling = true;
    d.dy = settleOffset(d.rects, d.from, d.slot);
    setTimeout(commit, SETTLE_MS);
  }

  function cancel() {
    if (drag && !drag.settling) drag = null;
  }

  return {
    /** A drag is under way (lifted), so listen for move/up. */
    get active() {
      return drag !== null;
    },
    get lifted() {
      return drag?.rects != null;
    },
    start,
    move,
    end,
    cancel,
    /** The row's transform while a drag is lifted; 0 otherwise. */
    offset(index: number): number {
      const d = drag;
      if (!d?.rects) return 0;
      if (index === d.from) return d.dy;
      return makeWayOffset(d.rects, d.from, d.slot, index);
    },
    isLifted(index: number): boolean {
      return drag?.rects != null && drag.from === index;
    },
    /** Whether the row eases to its offset (the others always; the dragged one only as it settles). */
    eases(index: number): boolean {
      return drag?.rects != null && (index !== drag.from || drag.settling);
    },
  };
}
