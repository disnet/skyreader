<script lang="ts">
  import { type Snippet } from 'svelte';
  import { perfEndOnPaint, perfCancel, PERF_SHEET_OPEN } from '$lib/utils/perfMarks';

  interface Props {
    open: boolean;
    onclose: () => void;
    title?: string;
    maxHeight?: string;
    /**
     * Keep the sheet in the DOM once it has been opened, so every later open is
     * a class toggle (compositor work) instead of a mount. Opt-in: a sheet whose
     * content is cheap to build, or whose content should start fresh each time,
     * is better off with the default lazy behavior.
     *
     * The tradeoff for a warm sheet is that its content's store subscriptions
     * stay live while it's hidden, so background changes re-render rows nobody
     * is looking at. Turn it on only where the mount is the cost being paid —
     * the feed switcher, which rebuilds a nav tree over the whole library.
     */
    keepMounted?: boolean;
    children: Snippet;
  }

  let { open, onclose, title, maxHeight = '75vh', keepMounted = false, children }: Props = $props();

  let sheetEl = $state<HTMLDivElement | null>(null);
  let dragStartY = $state(0);
  let dragCurrentY = $state(0);
  let isDragging = $state(false);

  // Latched by the first open of a keepMounted sheet. Before that the sheet has
  // never been wanted, so it shouldn't cost a mount — a surface hosting three
  // sheets would otherwise build all three during page load.
  let everOpened = $state(false);
  $effect(() => {
    if (open) everOpened = true;
  });

  // `rendered` = in the DOM. `shown` = visible. The same thing for a lazy sheet;
  // for a warm one the sheet stays rendered and only `shown` toggles, which is
  // what makes the second open free.
  let rendered = $derived(open || (keepMounted && everOpened));
  let shown = $state(false);

  const VIEWPORT_HEIGHT_RATIO = 0.75;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      onclose();
    }
  }

  // Flip into the open state only after the closed state has actually been
  // computed, so the transition has a starting style to run from. On a fresh
  // mount the element is inserted already-open otherwise, and a transition with
  // no "before" simply doesn't play. Reading offsetHeight forces that style
  // resolution synchronously — no wasted frame, unlike a rAF hop.
  $effect(() => {
    if (!open) {
      shown = false;
      // A warm sheet outlives its closes, so a drag that never got its touchend
      // (an interrupted gesture) would otherwise carry `transition: none` into
      // the next open and make it snap instead of slide.
      isDragging = false;
      dragCurrentY = 0;
      return;
    }
    if (!sheetEl) return;
    void sheetEl.offsetHeight;
    shown = true;
  });

  // Close the tap→painted-sheet measurement once the open frame lands. No-ops
  // unless something marked the start (dev only — see perfMarks).
  $effect(() => {
    if (open) perfEndOnPaint(PERF_SHEET_OPEN);
    else perfCancel(PERF_SHEET_OPEN);
  });

  // Still covering the page: `open` plus the exit transition. A warm sheet is
  // held on screen for EXIT_MS after `open` goes false while it slides out, and
  // it is `pointer-events: none` by then — so anything keyed to `open` (the body
  // scroll lock below especially) would let a touch started in that window
  // scroll the page behind a sheet that still visually covers it. A lazy sheet
  // is removed from the DOM in the same frame, so it must not lag.
  const EXIT_MS = 250;
  let covering = $state(false);
  // Plain mirror of `covering`, so the effect below can branch on the current
  // value without taking a reactive dependency on the state it also writes.
  let coveringNow = false;
  function setCovering(next: boolean) {
    coveringNow = next;
    covering = next;
  }
  $effect(() => {
    if (open) {
      setCovering(true);
      return;
    }
    if (!coveringNow) return;
    if (!keepMounted) {
      setCovering(false);
      return;
    }
    const timer = setTimeout(() => setCovering(false), EXIT_MS);
    return () => clearTimeout(timer);
  });

  // Lock body scroll for as long as the sheet is on screen.
  $effect(() => {
    if (covering) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  });

  // Visual Viewport API for keyboard adjustment
  $effect(() => {
    if (!open || !sheetEl) return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    function updateHeight() {
      if (!sheetEl || !viewport) return;
      const availableHeight = viewport.height * VIEWPORT_HEIGHT_RATIO;
      sheetEl.style.maxHeight = `${availableHeight}px`;
    }

    updateHeight();
    viewport.addEventListener('resize', updateHeight);

    return () => {
      viewport.removeEventListener('resize', updateHeight);
    };
  });

  function handleDragStart(e: TouchEvent) {
    dragStartY = e.touches[0].clientY;
    dragCurrentY = 0;
    isDragging = true;
  }

  function handleDragMove(e: TouchEvent) {
    if (!isDragging) return;
    const delta = e.touches[0].clientY - dragStartY;
    dragCurrentY = Math.max(0, delta); // Only allow downward drag
  }

  function handleDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    if (dragCurrentY > 100) {
      onclose();
    }
    dragCurrentY = 0;
  }

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if rendered}
  <!-- `inert` while closed is what makes keepMounted safe: without it the hidden
       dialog stays tab-focusable and in the accessibility tree, sitting in front
       of the page the reader is actually on. -->
  <div class="bottom-sheet-portal" class:shown inert={!open} use:portal>
    <div class="backdrop" onclick={onclose} onkeydown={handleKeydown} role="presentation"></div>
    <div
      class="sheet"
      bind:this={sheetEl}
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Bottom sheet'}
      style:max-height={maxHeight}
      style:transform={open && dragCurrentY > 0 ? `translateY(${dragCurrentY}px)` : undefined}
      style:transition={isDragging ? 'none' : undefined}
    >
      <div
        class="drag-handle-area"
        role="button"
        aria-label="Drag to dismiss"
        tabindex={0}
        ontouchstart={handleDragStart}
        ontouchmove={handleDragMove}
        ontouchend={handleDragEnd}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onclose();
        }}
      >
        <div class="drag-handle"></div>
        {#if title}
          <div class="sheet-title">{title}</div>
        {/if}
      </div>
      <div class="sheet-content">
        {@render children()}
      </div>
    </div>
  </div>
{/if}

<style>
  /* Hidden is the base state, so a kept-mounted sheet costs no paint between
     opens. `visibility` (not `display: none`) keeps the subtree transitionable,
     and delaying it on the way out is what lets the exit animation finish — the
     old `{#if open}` sheet had no exit at all, it was yanked. */
  .bottom-sheet-portal {
    position: fixed;
    inset: 0;
    z-index: 1100;
    visibility: hidden;
    pointer-events: none;
    transition: visibility 0.25s;
  }

  .bottom-sheet-portal.shown {
    visibility: visible;
    pointer-events: auto;
    transition: visibility 0s;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .bottom-sheet-portal.shown .backdrop {
    opacity: 1;
  }

  /* Transform only, so open/close is compositor work rather than a one-shot
     keyframe that has to run against a subtree being built in the same frame. */
  .sheet {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--color-bg, #fff);
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transform: translateY(100%);
    transition: transform 0.25s ease;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .bottom-sheet-portal.shown .sheet {
    transform: translateY(0);
  }

  @media (prefers-reduced-motion: reduce) {
    .bottom-sheet-portal,
    .backdrop,
    .sheet {
      transition: none;
    }
  }

  .drag-handle-area {
    flex-shrink: 0;
    padding: 0.75rem 1rem 0.5rem;
    cursor: grab;
    touch-action: none;
  }

  .drag-handle {
    width: 36px;
    height: 4px;
    background: var(--color-border, #e0e0e0);
    border-radius: 2px;
    margin: 0 auto 0.5rem;
  }

  .sheet-title {
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    text-align: center;
  }

  .sheet-content {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  @media (prefers-color-scheme: dark) {
    .sheet {
      background: var(--color-bg, #1a1a1a);
      box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.4);
    }

    .backdrop {
      background: rgba(0, 0, 0, 0.6);
    }

    .drag-handle {
      background: var(--color-border, #404040);
    }
  }
</style>
