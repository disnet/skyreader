// Position a fixed/floating element (popover, menu) against an anchor rect,
// flipping above/below to fit the viewport and clamping to the edges. Writes
// top/left (and optionally max-height) directly onto the element's style.
//
// Shared by the highlight popover and the share-note quotes popup, which both
// reimplemented the same measure → flip → clamp logic against a viewport-
// relative anchor.

export interface FloatingOptions {
  /** Space between the anchor and the element (px). Default 4. */
  gap?: number;
  /** Minimum inset from the viewport edges (px). Defaults to `gap`. */
  edge?: number;
  /** Horizontal alignment of the element to the anchor. Default 'center'. */
  align?: 'center' | 'start' | 'end';
  /**
   * Vertical placement:
   *  - 'below-first' keeps the element below the anchor, flipping above only
   *    when it would overflow the bottom.
   *  - 'larger-side' always places on whichever side has more room.
   * Default 'below-first'. Forced to 'larger-side' when `capHeight` is set.
   */
  placement?: 'below-first' | 'larger-side';
  /**
   * Cap the element's height to the room on its chosen side (implies
   * 'larger-side'). Pair with `minHeight` so it never collapses too far.
   */
  capHeight?: boolean;
  minHeight?: number;
}

export function positionFloating(
  anchor: DOMRect,
  el: HTMLElement,
  opts: FloatingOptions = {}
): void {
  const gap = opts.gap ?? 4;
  const edge = opts.edge ?? gap;
  const align = opts.align ?? 'center';
  const placement = opts.capHeight ? 'larger-side' : (opts.placement ?? 'below-first');
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceAbove = anchor.top - gap - edge;
  const spaceBelow = vh - anchor.bottom - gap - edge;
  let placeAbove = spaceAbove >= spaceBelow;

  // Cap height to the chosen side before measuring, so the flip math below uses
  // the real rendered size rather than an overflowing natural height.
  if (opts.capHeight) {
    const room = Math.max(opts.minHeight ?? 0, placeAbove ? spaceAbove : spaceBelow);
    el.style.maxHeight = `${Math.floor(room)}px`;
  }

  const rect = el.getBoundingClientRect();

  // 'below-first' only flips above when the element would overflow the bottom.
  if (placement === 'below-first') {
    placeAbove = anchor.bottom + gap + rect.height > vh;
  }

  let top: number;
  if (placeAbove) {
    top = Math.max(edge, anchor.top - gap - rect.height);
  } else if (placement === 'larger-side') {
    top = Math.min(anchor.bottom + gap, vh - rect.height - edge);
  } else {
    top = anchor.bottom + gap;
  }

  let left: number;
  if (align === 'end') {
    left = anchor.right - rect.width;
  } else if (align === 'start') {
    left = anchor.left;
  } else {
    left = anchor.left + anchor.width / 2 - rect.width / 2;
  }
  left = Math.min(left, vw - rect.width - edge);
  left = Math.max(edge, left);

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}
