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

  // Measure against the *visual* viewport, not the layout viewport. On mobile
  // the on-screen keyboard overlays the layout viewport without shrinking
  // window.innerHeight, so an anchor near the bottom still "has room below" and
  // the element gets placed behind the keyboard. visualViewport.height excludes
  // the keyboard; offsetTop/Left handle pinch-zoom panning. Anchor rects and
  // position:fixed are both in layout-viewport coords, which the offsets map into.
  const vv = window.visualViewport;
  const viewTop = vv?.offsetTop ?? 0;
  const viewLeft = vv?.offsetLeft ?? 0;
  const vw = vv?.width ?? window.innerWidth;
  const vh = vv?.height ?? window.innerHeight;
  const viewBottom = viewTop + vh;
  const viewRight = viewLeft + vw;

  const spaceAbove = anchor.top - viewTop - gap - edge;
  const spaceBelow = viewBottom - anchor.bottom - gap - edge;
  let placeAbove = spaceAbove >= spaceBelow;

  // Cap height to the chosen side before measuring, so the flip math below uses
  // the real rendered size rather than an overflowing natural height.
  if (opts.capHeight) {
    const room = Math.max(opts.minHeight ?? 0, placeAbove ? spaceAbove : spaceBelow);
    el.style.maxHeight = `${Math.floor(room)}px`;
  }

  // Measure with offsetWidth/Height, not getBoundingClientRect — the latter
  // includes any live CSS transform, so an element measured mid-entry-animation
  // (e.g. a popover scaling in) reports a smaller size, gets clamped against it,
  // then grows past the viewport edge. offset* gives the final layout size.
  const width = el.offsetWidth;
  const height = el.offsetHeight;

  // 'below-first' only flips above when the element would overflow the bottom.
  if (placement === 'below-first') {
    placeAbove = anchor.bottom + gap + height > viewBottom;
  }

  let top: number;
  if (placeAbove) {
    top = anchor.top - gap - height;
  } else if (placement === 'larger-side') {
    top = anchor.bottom + gap;
  } else {
    top = anchor.bottom + gap;
  }
  // Clamp into the visible band. The lower clamp matters when the anchor sits
  // *below* the visible area (e.g. it's behind the just-raised keyboard): placing
  // "above" it still overflows, so pull the element up to rest just above the
  // keyboard. Mirrors the horizontal clamp below.
  top = Math.min(top, viewBottom - height - edge);
  top = Math.max(viewTop + edge, top);

  let left: number;
  if (align === 'end') {
    left = anchor.right - width;
  } else if (align === 'start') {
    left = anchor.left;
  } else {
    left = anchor.left + anchor.width / 2 - width / 2;
  }
  left = Math.min(left, viewRight - width - edge);
  left = Math.max(viewLeft + edge, left);

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

/**
 * Keep a floating element pinned to a live anchor while the page scrolls.
 *
 * `positionFloating` places the element once, against the rect its anchor had
 * when it opened. The reader body scrolls inside its own overlay while the
 * popover is `position: fixed`, so the text a popover belongs to slides out from
 * under it. Re-measuring each scroll frame keeps the two together, and `onLost`
 * fires once the anchor is gone or has left the viewport entirely — at which
 * point there is nothing left to pin to.
 *
 * Returns a cleanup function; call it when the floating element unmounts.
 */
export function followAnchor(
  getEl: () => HTMLElement | null,
  getAnchorRect: () => DOMRect | null,
  opts: FloatingOptions & { onLost?: () => void } = {}
): () => void {
  let frame: number | null = null;

  const update = () => {
    frame = null;
    const el = getEl();
    if (!el) return;
    const rect = getAnchorRect();
    const vv = window.visualViewport;
    const viewTop = vv?.offsetTop ?? 0;
    const viewBottom = viewTop + (vv?.height ?? window.innerHeight);
    // A detached anchor measures as an all-zero rect, which would pin the
    // element to the top-left corner — treat that as lost too (the callers'
    // rect getters return null for it).
    if (!rect || rect.bottom < viewTop || rect.top > viewBottom) {
      opts.onLost?.();
      return;
    }
    positionFloating(rect, el, opts);
  };

  const schedule = () => {
    if (frame == null) frame = requestAnimationFrame(update);
  };

  // Capture phase: the reader body scrolls in its own overlay, and scroll events
  // from a nested scroller never reach window.
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);

  return () => {
    if (frame != null) cancelAnimationFrame(frame);
    document.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
  };
}
