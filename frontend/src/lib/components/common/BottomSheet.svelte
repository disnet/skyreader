<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
    title?: string;
    maxHeight?: string;
    children: Snippet;
  }

  let { open, onclose, title, maxHeight = '75vh', children }: Props = $props();

  let sheetEl = $state<HTMLDivElement | null>(null);
  let dragStartY = $state(0);
  let dragCurrentY = $state(0);
  let isDragging = $state(false);

  const VIEWPORT_HEIGHT_RATIO = 0.75;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      onclose();
    }
  }

  // Lock body scroll when open
  $effect(() => {
    if (open) {
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

{#if open}
  <div class="bottom-sheet-portal" use:portal>
    <div class="backdrop" onclick={onclose} onkeydown={handleKeydown} role="presentation"></div>
    <div
      class="sheet"
      bind:this={sheetEl}
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Bottom sheet'}
      style:max-height={maxHeight}
      style:transform={dragCurrentY > 0 ? `translateY(${dragCurrentY}px)` : undefined}
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
  .bottom-sheet-portal {
    position: fixed;
    inset: 0;
    z-index: 1100;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    animation: fadeIn 0.2s ease;
  }

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
    animation: slideUp 0.25s ease;
    padding-bottom: env(safe-area-inset-bottom, 0px);
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
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text);
    text-align: center;
  }

  .sheet-content {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes slideUp {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
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
