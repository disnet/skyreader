<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { usePagination } from '$lib/hooks/usePagination.svelte';

  export interface PagedController {
    goToPage: (page: number) => void;
    next: () => void;
    prev: () => void;
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
  // ignored so taps and text selection still work.
  let touchStartX = 0;
  let touchStartY = 0;
  let touchTracking = false;

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) {
      touchTracking = false;
      return;
    }
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchTracking = true;
  }

  function onTouchEnd(e: TouchEvent) {
    if (!touchTracking) return;
    touchTracking = false;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < 0) pagination.next();
    else pagination.prev();
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
</script>

<div class="paged-root" style:padding-bottom={bottomInset ? `${bottomInset}px` : undefined}>
  <div
    class="paged-viewport"
    bind:this={viewportEl}
    ontouchstart={onTouchStart}
    ontouchend={onTouchEnd}
  >
    <div class="paged-content" bind:this={contentEl}>
      {@render children()}
    </div>

    <button
      class="turn-zone turn-prev"
      onclick={() => pagination.prev()}
      disabled={atStart}
      aria-label="Previous page"
      title="Previous page"
    >
      <span class="turn-chevron"><Icon name="chevron-left" size={22} /></span>
    </button>
    <button
      class="turn-zone turn-next"
      onclick={() => pagination.next()}
      disabled={atEnd}
      aria-label="Next page"
      title="Next page"
    >
      <span class="turn-chevron"><Icon name="chevron-right" size={22} /></span>
    </button>
  </div>

  <div class="paged-nav" aria-live="polite">
    <span class="paged-count">Page {pagination.currentPage + 1} of {pagination.totalPages}</span>
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
  }

  /* The paginated flow. Every measured value (width, height, column-width,
     column-gap, transform) is set imperatively by usePagination; the static
     multicol behavior lives here. `column-fill: auto` is load-bearing — it makes
     the overflow columns spill horizontally instead of balancing. */
  .paged-content {
    box-sizing: border-box;
    column-fill: auto;
    transform: translateX(0);
    transition: transform 0.28s ease;
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
  .paged-content :global(blockquote) {
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

  /* Edge tap/click zones. Narrow so they don't swallow text selection across the
     column; the chevron only fades in on hover (desktop) or stays faint (touch). */
  .turn-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    width: clamp(40px, 8%, 72px);
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: 0;
  }

  .turn-prev {
    left: 0;
    justify-content: flex-start;
  }

  .turn-next {
    right: 0;
    justify-content: flex-end;
  }

  .turn-zone:disabled {
    cursor: default;
  }

  .turn-chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 999px;
    background: var(--color-bg, #fff);
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.12);
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .turn-zone:hover:not(:disabled) .turn-chevron {
    opacity: 1;
  }

  .turn-zone:disabled .turn-chevron {
    opacity: 0;
  }

  /* Touch devices don't hover — keep the chevrons quietly visible so the page-turn
     affordance is discoverable. */
  @media (hover: none) {
    .turn-chevron {
      opacity: 0.5;
    }
  }

  .paged-nav {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom, 0px));
  }

  .paged-count {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
    letter-spacing: var(--tracking-wide);
  }

  @media (prefers-color-scheme: dark) {
    .turn-chevron {
      background: var(--color-bg-secondary, #2a2a2a);
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
    }
  }
</style>
