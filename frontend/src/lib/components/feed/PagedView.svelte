<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { usePagination } from '$lib/hooks/usePagination.svelte';

  export interface PagedController {
    goToPage: (page: number) => void;
    goToElement: (el: HTMLElement) => void;
    next: () => void;
    prev: () => void;
    startDrag: () => void;
    updateDrag: (dx: number) => void;
    endDrag: (dx: number, velocity: number) => void;
    pageOfElement: (el: HTMLElement) => number;
    recalc: () => void;
    readonly currentPage: number;
    readonly totalPages: number;
  }

  let {
    children,
    // Extra bottom padding (px) so the paged column + nav clear any fixed chrome
    // the host floats over the bottom (e.g. the mobile reader bar).
    bottomInset = 0,
    // Read reactively by the paginator so it re-flows when the content changes.
    deps,
    currentPage = $bindable(0),
    totalPages = $bindable(1),
    oncontroller,
    onpagechange,
  }: {
    children: Snippet;
    bottomInset?: number;
    deps?: () => unknown;
    currentPage?: number;
    totalPages?: number;
    oncontroller?: (controller: PagedController) => void;
    onpagechange?: (page: number, total: number) => void;
  } = $props();

  let viewportEl = $state<HTMLElement>();
  let contentEl = $state<HTMLElement>();

  const pagination = usePagination({
    getViewportEl: () => viewportEl,
    getContentEl: () => contentEl,
    deps: () => deps?.(),
    onPageChange: (page, total) => onpagechange?.(page, total),
  });

  // Mirror the paginator's state onto the bindable props so host chrome (the
  // reader header / magazine chrome) can show "Page X / N" too.
  $effect(() => {
    currentPage = pagination.currentPage;
    totalPages = pagination.totalPages;
  });

  // Hand the controller to the host once, so it can restore position / drive the
  // active article without re-implementing any of the paging math.
  $effect(() => {
    oncontroller?.(pagination satisfies PagedController);
  });

  let atStart = $derived(pagination.currentPage <= 0);
  let atEnd = $derived(pagination.currentPage >= pagination.totalPages - 1);

  // Touch swipe: horizontal drag turns the page; vertical / small drags are
  // ignored so taps and text selection still work. The page follows the finger
  // (physical drag); on release the paginator commits the turn or springs back.
  // We decide the axis after a small movement, then drag until touchend/cancel.
  const AXIS_DECIDE_PX = 8;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchLastX = 0;
  let touchLastT = 0;
  let touchVelocity = 0;
  let touchDecided = false;
  let dragging = false;

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) {
      dragging = false;
      touchDecided = false;
      return;
    }
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchLastX = touchStartX;
    touchLastT = performance.now();
    touchVelocity = 0;
    touchDecided = false;
    dragging = false;
  }

  function hasActiveSelection(): boolean {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
  }

  function onTouchMove(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    const dx = x - touchStartX;
    const dy = y - touchStartY;
    if (!touchDecided) {
      if (Math.abs(dx) < AXIS_DECIDE_PX && Math.abs(dy) < AXIS_DECIDE_PX) return;
      touchDecided = true;
      // Horizontal intent → drive a physical page drag; vertical → leave it be.
      // But never hijack the gesture while text is selected (a long-press selects
      // a word on touch): let the native selection handles be dragged instead.
      if (Math.abs(dx) > Math.abs(dy) && !hasActiveSelection()) {
        dragging = true;
        pagination.startDrag();
      }
    }
    if (!dragging) return;
    // A selection appearing mid-drag (rare) hands the gesture back to the browser.
    if (hasActiveSelection()) {
      dragging = false;
      pagination.endDrag(0, 0); // settle back to the current page
      return;
    }
    if (e.cancelable) e.preventDefault(); // claim the horizontal gesture
    pagination.updateDrag(dx);
    const now = performance.now();
    const dt = now - touchLastT;
    if (dt > 0) touchVelocity = (x - touchLastX) / dt;
    touchLastX = x;
    touchLastT = now;
  }

  // A touch that never became a horizontal drag is left entirely alone: taps in the
  // reading area belong to the text (selection, links, highlights), not to paging.
  // Swiping and the bottom pager are the page-turn affordances.
  function onTouchEnd(e: TouchEvent) {
    const wasDragging = dragging;
    dragging = false;
    touchDecided = false;
    if (!wasDragging) return;
    const t = e.changedTouches && e.changedTouches[0];
    const endX = t ? t.clientX : touchLastX;
    pagination.endDrag(endX - touchStartX, touchVelocity);
  }

  // Scroll wheel / trackpad turns pages. One turn per gesture (a short lock keeps
  // a fast wheel or inertial trackpad from skipping several pages at once).
  let wheelLocked = false;
  function onWheel(e: WheelEvent) {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 8) return;
    e.preventDefault();
    if (wheelLocked) return;
    wheelLocked = true;
    if (delta > 0) pagination.next();
    else pagination.prev();
    setTimeout(() => (wheelLocked = false), 420);
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT')
    ) {
      return;
    }
    let handled = true;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') pagination.next();
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') pagination.prev();
    else if (e.key === ' ') {
      if (e.shiftKey) pagination.prev();
      else pagination.next();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  $effect(() => {
    document.addEventListener('keydown', handleKeydown, true);
    return () => document.removeEventListener('keydown', handleKeydown, true);
  });

  // Wheel + touch need non-passive listeners to preventDefault, so attach them
  // manually rather than via the (passive-by-default) on* attributes.
  $effect(() => {
    const vp = viewportEl;
    if (!vp) return;
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('touchstart', onTouchStart, { passive: true });
    vp.addEventListener('touchmove', onTouchMove, { passive: false });
    vp.addEventListener('touchend', onTouchEnd, { passive: true });
    vp.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('touchstart', onTouchStart);
      vp.removeEventListener('touchmove', onTouchMove);
      vp.removeEventListener('touchend', onTouchEnd);
      vp.removeEventListener('touchcancel', onTouchEnd);
    };
  });
</script>

<div class="paged-root" style:padding-bottom={bottomInset ? `${bottomInset}px` : undefined}>
  <div class="paged-viewport" bind:this={viewportEl}>
    <div class="paged-content" bind:this={contentEl}>
      {@render children()}
    </div>
  </div>

  <div class="paged-nav">
    <button
      class="page-btn"
      onclick={() => pagination.prev()}
      disabled={atStart}
      aria-label="Previous page"
      title="Previous page"
    >
      <Icon name="chevron-left" size={18} />
    </button>
    <span class="paged-count" aria-live="polite"
      >Page {pagination.currentPage + 1} of {pagination.totalPages}</span
    >
    <button
      class="page-btn"
      onclick={() => pagination.next()}
      disabled={atEnd}
      aria-label="Next page"
      title="Next page"
    >
      <Icon name="chevron-right" size={18} />
    </button>
  </div>
</div>

<style>
  .paged-root {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    max-width: 1200px;
    margin: 0 auto;
    padding: 0.5rem clamp(1rem, 4vw, 3rem) 0;
    box-sizing: border-box;
  }

  .paged-viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    /* Let JS own horizontal swipes (no browser back-gesture hijack); vertical is
       free but nothing scrolls here. */
    touch-action: pan-y;
  }

  /* The paginated flow. Every measured value (width, height, column-width,
     column-gap, transform) is set imperatively by usePagination; the static
     multicol behavior lives here. `column-fill: auto` is load-bearing — it makes
     the overflow columns spill horizontally instead of balancing. */
  .paged-content {
    box-sizing: border-box;
    column-fill: auto;
    transform: translateX(0);
    /* Physical settle: decelerating ease-out so a committed turn or spring-back
       glides in and eases to rest (like flicking a page). Disabled inline by the
       paginator while a finger is actively dragging. */
    transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
  }

  @media (prefers-reduced-motion: reduce) {
    .paged-content {
      transition: none;
    }
  }

  /* Keep media and unbreakable blocks whole within a column, and never let a tall
     image exceed the column height (which would clip the page). */
  .paged-content :global(img),
  .paged-content :global(svg),
  .paged-content :global(video),
  .paged-content :global(iframe),
  .paged-content :global(figure),
  .paged-content :global(pre),
  .paged-content :global(table),
  .paged-content :global(blockquote),
  .paged-content :global(button),
  /* Keep the share-to-linkblog / discussion rail whole rather than split across
     a column break where it can. */
  .paged-content :global(.reader-share-cta),
  .paged-content :global(.reader-discussion-divider) {
    break-inside: avoid;
  }

  .paged-content :global(img),
  .paged-content :global(svg),
  .paged-content :global(video) {
    max-height: 100%;
    object-fit: contain;
  }

  .paged-content :global(h1),
  .paged-content :global(h2),
  .paged-content :global(h3),
  .paged-content :global(h4) {
    break-after: avoid;
  }

  /* Bottom bar: ‹  Page X of N  › — the only page-turn affordance in the reading
     surface (plus wheel / swipe / keys). No floating overlay buttons. */
  .paged-nav {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom, 0px));
  }

  .page-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .page-btn:hover:not(:disabled) {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .page-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .paged-count {
    min-width: 8ch;
    text-align: center;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
    letter-spacing: var(--tracking-wide);
  }

  @media (prefers-color-scheme: dark) {
    .page-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
    }
  }
</style>
