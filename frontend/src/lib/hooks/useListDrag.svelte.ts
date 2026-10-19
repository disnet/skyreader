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
  /** The pointer's distance below the held row's top, fixed at lift. */
  grab: number;
  /** The rows' boxes as laid out at lift, and where their container was then. */
  lifted: { rects: RowRect[]; anchorTop: number } | null;
  /** The rows' boxes as laid out now (scroll included); null until lift. */
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
 * `ids` and `rows` return the list's ids and row elements, in order; `onDrop`
 * gets the ids in their new order, only when it changed. If the list itself
 * changes mid-drag (a sync lands), the drag is dropped rather than committing an
 * order built on rows that have moved.
 */
export function useListDrag(options: {
  ids: () => string[];
  rows: () => HTMLElement[];
  onDrop: (order: string[]) => void;
}) {
  let drag = $state<Drag | null>(null);

  function listChanged(d: Drag): boolean {
    const now = options.ids();
    return now.length !== d.ids.length || now.some((id, i) => id !== d.ids[i]);
  }

  /**
   * The rows' boxes where layout puts them. Measured once, at lift (the
   * transforms that follow would skew a live read, and an easing row would
   * read halfway), then moved by however far the list has scrolled since, as
   * read off a box the drag doesn't transform: the rows' container.
   */
  function measure(d: Drag): RowRect[] | null {
    const rows = options.rows();
    if (rows.length !== d.ids.length) return null;
    const anchor = rows[0].closest('.nav-children') ?? rows[0].parentElement;
    const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    if (!d.lifted) {
      d.lifted = {
        rects: rows.map((row) => {
          const r = row.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        }),
        anchorTop,
      };
    }
    const shift = anchorTop - d.lifted.anchorTop;
    return d.lifted.rects.map((r) => ({ top: r.top + shift, bottom: r.bottom + shift }));
  }

  function offsetOf(d: Drag, index: number): number {
    if (!d.rects) return 0;
    if (index === d.from) return d.dy;
    return makeWayOffset(d.rects, d.from, d.slot, index);
  }

  function start(e: PointerEvent, id: string) {
    if (drag || e.pointerType === 'touch' || e.button !== 0) return;
    const ids = options.ids();
    const from = ids.indexOf(id);
    if (from === -1 || ids.length < 2) return;
    drag = {
      ids,
      from,
      startY: e.clientY,
      grab: 0,
      lifted: null,
      rects: null,
      dy: 0,
      slot: from,
      settling: false,
    };
  }

  function move(e: PointerEvent) {
    const d = drag;
    if (!d || d.settling) return;
    // The button came up somewhere we didn't hear it (a release during another
    // list's settle, or outside the window): a pending press is nothing, and a
    // lifted row drops where it is.
    if ((e.buttons & 1) === 0) {
      if (d.rects) end();
      else drag = null;
      return;
    }
    if (!d.rects && Math.abs(e.clientY - d.startY) < LIFT_PX) return;
    const rects = listChanged(d) ? null : measure(d);
    if (!rects) {
      drag = null;
      return;
    }
    if (!d.rects) d.grab = d.startY - rects[d.from].top;
    d.rects = rects;
    // The page mustn't select text out from under the drag.
    e.preventDefault();
    d.dy = clampDrag(rects, d.from, e.clientY - d.grab - rects[d.from].top);
    d.slot = dragSlot(rects, d.from, d.dy);
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
      if (drag !== d) return;
      if (listChanged(d)) {
        drag = null;
        return;
      }
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
      return drag ? offsetOf(drag, index) : 0;
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
