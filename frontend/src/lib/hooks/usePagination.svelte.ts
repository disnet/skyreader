import { onDestroy } from 'svelte';

/**
 * Kindle-style column pagination for a block of prose.
 *
 * The mechanic (CSS multicol horizontal-overflow): the content element is given a
 * fixed height (the viewport height) plus `column-width` + `column-gap`, so its
 * text flows into columns. With a fixed height and `column-fill: auto` (set by the
 * host CSS), the columns that don't fit in the element's width overflow
 * *horizontally* — `scrollWidth` then spans every column end to end. We show one
 * "page" (1 or 2 columns, whichever the width allows) at a time by translating the
 * content sideways. No scrolling involved.
 *
 * The host component supplies the viewport + content elements and owns the static
 * CSS (`overflow: hidden`, `column-fill: auto`, `break-inside` on media); this
 * controller owns every *measured* value (column width, gap, height, transform)
 * and the page bookkeeping.
 */

// A comfortable single-column measure. Two columns kick in once the viewport is
// wide enough to hold two of these plus a gap (~roughly 950px+).
const IDEAL_COLUMN_PX = 420;

function computeGap(width: number): number {
  return Math.min(56, Math.max(24, Math.round(width * 0.05)));
}

interface PaginationParams {
  getViewportEl: () => HTMLElement | undefined;
  getContentEl: () => HTMLElement | undefined;
  // Read inside an effect so the layout recomputes when the content (or anything
  // else the caller wants to depend on, e.g. font size) changes.
  deps?: () => unknown;
  onPageChange?: (page: number, total: number) => void;
}

export function usePagination(params: PaginationParams) {
  let currentPage = $state(0);
  let totalPages = $state(1);

  // Last measured layout — kept so pageOfElement() can map a DOM node to a page
  // without re-measuring.
  let colWidth = 0;
  let gap = 0;
  let cols = 1;
  let pageStride = 0; // horizontal distance between two consecutive pages (px)

  // A target element to keep at the top of the page across reflows (jump-to /
  // restore). Late-loading images repaginate the flow, so a one-shot goToPage can
  // land short; we re-resolve this element's page on every measure until the user
  // turns a page.
  let pendingElement: HTMLElement | null = null;

  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let imgCleanups: Array<() => void> = [];
  let recalcRaf: number | null = null;
  const deferredTimers: Array<ReturnType<typeof setTimeout>> = [];

  function applyTransform() {
    const content = params.getContentEl();
    if (!content) return;
    content.style.transform = `translateX(${-currentPage * pageStride}px)`;
  }

  function measure() {
    const viewport = params.getViewportEl();
    const content = params.getContentEl();
    if (!viewport || !content) return;

    const W = viewport.clientWidth;
    const H = viewport.clientHeight;
    if (W <= 0 || H <= 0) return;

    gap = computeGap(W);
    cols = Math.max(1, Math.min(2, Math.floor((W + gap) / (IDEAL_COLUMN_PX + gap))));
    colWidth = (W - (cols - 1) * gap) / cols;

    // Force the frame width so exactly `cols` columns fill one page; the rest
    // overflow horizontally.
    content.style.width = `${W}px`;
    content.style.height = `${H}px`;
    content.style.columnGap = `${gap}px`;
    content.style.columnWidth = `${colWidth}px`;

    const colStride = colWidth + gap;
    pageStride = cols * colStride;

    // scrollWidth = C*colWidth + (C-1)*gap = C*colStride - gap, so total columns
    // C = round((scrollWidth + gap) / colStride). Pages = ceil(C / cols).
    const totalColumns = Math.max(1, Math.round((content.scrollWidth + gap) / colStride));
    totalPages = Math.max(1, Math.ceil(totalColumns / cols));

    if (currentPage > totalPages - 1) currentPage = totalPages - 1;
    if (currentPage < 0) currentPage = 0;

    // Keep a jumped-to / restored element pinned to the top of its page as the
    // flow reflows (images loading, fonts settling) — otherwise the turn lands
    // short of where the element ends up.
    if (pendingElement?.isConnected) {
      currentPage = Math.max(0, Math.min(totalPages - 1, pageOfElement(pendingElement)));
    }

    applyTransform();
    params.onPageChange?.(currentPage, totalPages);
  }

  function scheduleMeasure() {
    if (recalcRaf != null) return;
    recalcRaf = requestAnimationFrame(() => {
      recalcRaf = null;
      measure();
    });
  }

  function watchImages() {
    for (const cleanup of imgCleanups) cleanup();
    imgCleanups = [];
    const content = params.getContentEl();
    if (!content) return;
    const imgs = Array.from(content.querySelectorAll('img'));
    for (const img of imgs) {
      // Paged mode never scrolls, so `loading="lazy"` images translated off the
      // current page would never enter the viewport and never load — leaving their
      // columns measured at ~0 height and page counts (and jump targets) wrong.
      // Force them to load so the flow is stable.
      if (img.loading === 'lazy') img.loading = 'eager';
      if (img.complete) continue;
      const onLoad = () => scheduleMeasure();
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onLoad);
      imgCleanups.push(() => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onLoad);
      });
    }
  }

  // Recompute whenever the viewport resizes or the caller's deps change.
  $effect(() => {
    params.deps?.();
    const viewport = params.getViewportEl();
    if (!viewport) return;

    resizeObserver = new ResizeObserver(() => scheduleMeasure());
    resizeObserver.observe(viewport);

    // Content can grow/shrink after first paint — embeds hydrate, and the
    // discussion rail expands when Atmosphere data loads or the user shares. Watch
    // the subtree so the page count stays correct. We observe childList/text only
    // (NOT attributes) so measure()'s own inline style writes don't re-trigger it.
    const content = params.getContentEl();
    if (content) {
      mutationObserver = new MutationObserver(() => scheduleMeasure());
      mutationObserver.observe(content, { childList: true, subtree: true, characterData: true });
    }

    watchImages();
    scheduleMeasure();
    // Late images / web fonts can change the flow after first paint; re-measure a
    // couple of times to settle without a visible reflow jump.
    for (const delay of [150, 500]) {
      deferredTimers.push(setTimeout(scheduleMeasure, delay));
    }

    return () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      mutationObserver?.disconnect();
      mutationObserver = null;
      for (const cleanup of imgCleanups) cleanup();
      imgCleanups = [];
      while (deferredTimers.length) clearTimeout(deferredTimers.pop());
    };
  });

  function goToPage(page: number) {
    pendingElement = null; // a deliberate page turn drops any pinned target
    const clamped = Math.max(0, Math.min(totalPages - 1, page));
    if (clamped === currentPage) return;
    currentPage = clamped;
    applyTransform();
    params.onPageChange?.(currentPage, totalPages);
  }

  // Turn to the page an element sits on and keep it pinned there through any
  // reflow until the reader turns a page (see `pendingElement` in measure()).
  function goToElement(el: HTMLElement) {
    pendingElement = el;
    const clamped = Math.max(0, Math.min(totalPages - 1, pageOfElement(el)));
    if (clamped !== currentPage) {
      currentPage = clamped;
      params.onPageChange?.(currentPage, totalPages);
    }
    applyTransform();
  }

  function next() {
    goToPage(currentPage + 1);
  }

  function prev() {
    goToPage(currentPage - 1);
  }

  // --- Physical drag: the page follows the finger, then completes the turn or
  // springs back on release (distance past ~20% of a page, or a quick flick). ---

  // Fraction of a page you must drag to commit a turn on release.
  const DRAG_COMMIT_FRACTION = 0.2;
  // Flick velocity (px/ms) that commits a turn regardless of distance.
  const FLICK_VELOCITY = 0.4;
  // Rubber-band factor when dragging past the first/last page.
  const OVERSCROLL_DAMP = 0.35;

  function setTransition(on: boolean) {
    const content = params.getContentEl();
    if (content) content.style.transition = on ? '' : 'none';
  }

  function startDrag() {
    pendingElement = null; // the reader is turning by hand — stop pinning
    setTransition(false); // 1:1 with the finger — no easing lag while dragging
  }

  function updateDrag(dx: number) {
    const content = params.getContentEl();
    if (!content || pageStride <= 0) return;
    const atStart = currentPage <= 0;
    const atEnd = currentPage >= totalPages - 1;
    // Rubber-band the edges so there's nowhere-to-go feedback rather than a dead stop.
    const offset = (atStart && dx > 0) || (atEnd && dx < 0) ? dx * OVERSCROLL_DAMP : dx;
    content.style.transform = `translateX(${-currentPage * pageStride + offset}px)`;
  }

  function endDrag(dx: number, velocity: number) {
    const content = params.getContentEl();
    setTransition(true); // restore the eased transition for the settle animation
    if (content) void content.offsetWidth; // reflow so the next transform transitions
    if (pageStride <= 0) {
      applyTransform();
      return;
    }
    const threshold = pageStride * DRAG_COMMIT_FRACTION;
    let target = currentPage;
    if (dx < -threshold || velocity < -FLICK_VELOCITY) target = currentPage + 1;
    else if (dx > threshold || velocity > FLICK_VELOCITY) target = currentPage - 1;
    target = Math.max(0, Math.min(totalPages - 1, target));
    if (target === currentPage) {
      applyTransform(); // spring back to the current page
    } else {
      currentPage = target;
      applyTransform(); // animate to the committed page
      params.onPageChange?.(currentPage, totalPages);
    }
  }

  /**
   * Which page a given element's start sits on. Used to restore reading position
   * (map a saved paragraph → its page) and to derive the "active" article in the
   * multi-article magazine. Accounts for the current translate so it's correct
   * from any page.
   */
  function pageOfElement(el: HTMLElement): number {
    const content = params.getContentEl();
    if (!content || pageStride <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    // Both rects carry the same translateX, so their difference is the element's
    // offset within the untranslated column flow (no page term to add back).
    const x = rect.left - contentRect.left;
    // Every element in a multicol column shares that column's left edge, so x is
    // ~an exact multiple of colStride. Snap to the nearest *column* (robust to
    // sub-pixel), then floor to its containing page. Rounding straight to the
    // nearest page would push an element in the right-hand column of a two-column
    // page onto the next page — landing you a page past the article's start.
    const colStride = pageStride / cols;
    const columnIndex = Math.max(0, Math.round(x / colStride));
    return Math.floor(columnIndex / cols);
  }

  onDestroy(() => {
    if (recalcRaf != null) cancelAnimationFrame(recalcRaf);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    for (const cleanup of imgCleanups) cleanup();
    while (deferredTimers.length) clearTimeout(deferredTimers.pop());
  });

  return {
    get currentPage() {
      return currentPage;
    },
    get totalPages() {
      return totalPages;
    },
    next,
    prev,
    goToPage,
    goToElement,
    startDrag,
    updateDrag,
    endDrag,
    pageOfElement,
    recalc: scheduleMeasure,
  };
}
