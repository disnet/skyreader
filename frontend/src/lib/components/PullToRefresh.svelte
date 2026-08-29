<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { appScrollElement, appScrollTop } from '$lib/utils/appScroll';

  let {
    onRefresh,
    disabled = false,
    children,
  }: {
    onRefresh: () => Promise<unknown>;
    disabled?: boolean;
    children: Snippet;
  } = $props();

  const THRESHOLD = 70;
  const MAX_PULL = 130;
  const RESISTANCE = 0.4;

  let pulling = $state(false);
  let refreshing = $state(false);
  let pullDistance = $state(0);
  let startY = 0;
  let startScrollY = 0;
  let wrapperEl: HTMLDivElement | undefined = $state();

  let pastThreshold = $derived(pullDistance >= THRESHOLD);
  let indicatorOpacity = $derived(Math.min(pullDistance / THRESHOLD, 1));
  let indicatorRotation = $derived(pastThreshold ? 180 : (pullDistance / THRESHOLD) * 180);

  // Above the shell breakpoint the framed content card scrolls and the window
  // never does, so `window.scrollY` is a constant 0 there (see utils/appScroll).
  // Reading it directly would make the "page is at top" guard always pass on a
  // touch-capable desktop viewport (tablet in landscape, touchscreen laptop):
  // every downward drag would be swallowed as a pull, blocking the card's own
  // scroll and firing a spurious refresh. Pull-to-refresh is a mobile
  // affordance, so switch it off entirely once the pane is the scroller, and
  // measure through `appScrollTop()` for the position it still cares about.
  function inactive() {
    return disabled || refreshing || appScrollElement() !== null;
  }

  function handleTouchStart(e: TouchEvent) {
    if (inactive()) return;
    startScrollY = appScrollTop();
    if (startScrollY > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!pulling || inactive()) return;

    // If the page had scroll position when touch started, don't activate
    if (startScrollY > 0) {
      pulling = false;
      return;
    }

    // Only activate if page is at top
    if (appScrollTop() > 0) {
      pulling = false;
      pullDistance = 0;
      return;
    }

    const currentY = e.touches[0].clientY;
    const delta = currentY - startY;

    if (delta < 0) {
      // Scrolling up, cancel pull
      pullDistance = 0;
      return;
    }

    // Apply resistance and clamp
    pullDistance = Math.min(delta * RESISTANCE, MAX_PULL);

    // Prevent native scroll/pull-to-refresh while we're handling
    // This only works with { passive: false } listener
    if (pullDistance > 0) {
      e.preventDefault();
    }
  }

  async function handleTouchEnd() {
    if (!pulling) return;
    pulling = false;

    if (pastThreshold && !inactive()) {
      refreshing = true;
      pullDistance = THRESHOLD; // Hold at threshold during refresh
      try {
        await onRefresh();
      } finally {
        refreshing = false;
        pullDistance = 0;
      }
    } else {
      pullDistance = 0;
    }
  }

  // Register touchmove with { passive: false } so preventDefault() works in Safari
  onMount(() => {
    if (!wrapperEl) return;

    wrapperEl.addEventListener('touchstart', handleTouchStart, {
      passive: true,
    });
    wrapperEl.addEventListener('touchmove', handleTouchMove, {
      passive: false,
    });
    wrapperEl.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      wrapperEl!.removeEventListener('touchstart', handleTouchStart);
      wrapperEl!.removeEventListener('touchmove', handleTouchMove);
      wrapperEl!.removeEventListener('touchend', handleTouchEnd);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pull-to-refresh" bind:this={wrapperEl}>
  <div
    class="pull-indicator"
    class:past-threshold={pastThreshold}
    class:refreshing
    style:transform="translateY({pullDistance - THRESHOLD}px)"
    style:opacity={refreshing ? 1 : indicatorOpacity}
  >
    {#if refreshing}
      <div class="spinner"></div>
    {:else}
      <svg
        class="arrow"
        style:transform="rotate({indicatorRotation}deg)"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <polyline points="19 12 12 19 5 12"></polyline>
      </svg>
    {/if}
  </div>

  <div
    class="pull-content"
    style:transform={pullDistance > 0 ? `translateY(${pullDistance}px)` : ''}
  >
    {@render children()}
  </div>
</div>

<style>
  .pull-to-refresh {
    position: relative;
  }

  .pull-indicator {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 70px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    transition: opacity 0.1s;
    pointer-events: none;
    z-index: 1;
  }

  .pull-indicator.past-threshold {
    color: var(--color-primary);
  }

  .pull-content {
    position: relative;
    z-index: 0;
  }

  /* The pull gesture is touch-only, so above the shell breakpoint this wrapper
     has no layering to do — and `z-index: 0` there is actively harmful: it makes
     a stacking context that traps the fullscreen reader inside the content
     card's order, leaving it painted under the navigation rail. `auto` keeps the
     containing block and drops the context. */
  @media (min-width: 1001px) {
    .pull-content {
      z-index: auto;
    }
  }

  .arrow {
    transition: transform 0.15s ease-out;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2.5px solid var(--color-border, #e5e7eb);
    border-top-color: var(--color-primary, #0066cc);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
