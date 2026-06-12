<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { tooltip } from '$lib/actions/tooltip';

  interface Props {
    mode: 'create' | 'remove';
    anchorRect: DOMRect;
    onHighlight?: () => void;
    onHighlightToMargin?: () => void;
    onRemove?: () => void;
    onSaveToMargin?: () => void;
    marginSaved?: boolean;
    onClose: () => void;
  }

  let {
    mode,
    anchorRect,
    onHighlight,
    onHighlightToMargin,
    onRemove,
    onSaveToMargin,
    marginSaved = false,
    onClose,
  }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let scrollArmed = false;
  let scrollArmTimer: ReturnType<typeof setTimeout> | undefined;

  function handleScroll() {
    if (scrollArmed) onClose();
  }

  function positionMenu() {
    if (!menuEl) return;
    const menuRect = menuEl.getBoundingClientRect();
    const gap = 4;

    let top: number;
    if (anchorRect.bottom + gap + menuRect.height > window.innerHeight) {
      top = Math.max(gap, anchorRect.top - gap - menuRect.height);
    } else {
      top = anchorRect.bottom + gap;
    }

    let left = Math.min(
      anchorRect.left + anchorRect.width / 2 - menuRect.width / 2,
      window.innerWidth - menuRect.width - gap
    );
    left = Math.max(gap, left);

    menuEl.style.top = `${top}px`;
    menuEl.style.left = `${left}px`;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function handleClickOutside(e: MouseEvent | TouchEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('touchstart', handleClickOutside, true);
    document.addEventListener('scroll', handleScroll, true);
    requestAnimationFrame(positionMenu);
    // Delay arming the scroll-to-close so residual scroll momentum
    // (e.g. from trackpad inertia) doesn't immediately dismiss the popover
    scrollArmTimer = setTimeout(() => {
      scrollArmed = true;
    }, 300);
  });

  onDestroy(() => {
    clearTimeout(scrollArmTimer);
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('mousedown', handleClickOutside, true);
    document.removeEventListener('touchstart', handleClickOutside, true);
    document.removeEventListener('scroll', handleScroll, true);
  });
</script>

<div
  class="highlight-popover"
  style="position: fixed; z-index: 200;"
  bind:this={menuEl}
  onclick={(e) => e.stopPropagation()}
  onmousedown={(e) => e.stopPropagation()}
>
  {#if mode === 'create'}
    <button
      class="popover-btn icon-only"
      use:tooltip={'Save private highlight'}
      aria-label="Save private highlight"
      onclick={() => {
        onHighlight?.();
        onClose();
      }}
    >
      <Icon name="highlighter" size={16} />
    </button>
    {#if onHighlightToMargin}
      <button
        class="popover-btn icon-only"
        use:tooltip={'Save public margin highlight'}
        aria-label="Save public margin highlight"
        onclick={() => {
          onHighlightToMargin?.();
          onClose();
        }}
      >
        <Icon name="margin" size={16} />
      </button>
    {/if}
  {:else}
    <button
      class="popover-btn icon-only remove"
      use:tooltip={'Remove highlight'}
      aria-label="Remove highlight"
      onclick={() => {
        onRemove?.();
        onClose();
      }}
    >
      <Icon name="x" size={16} />
    </button>
    {#if onSaveToMargin}
      {#if marginSaved}
        <span
          class="popover-status icon-only"
          use:tooltip={'Saved to Margin'}
          aria-label="Saved to Margin"
        >
          <Icon name="check" size={16} />
        </span>
      {:else}
        <button
          class="popover-btn icon-only"
          use:tooltip={'Save public margin highlight'}
          aria-label="Save public margin highlight"
          onclick={() => {
            onSaveToMargin?.();
            onClose();
          }}
        >
          <Icon name="margin" size={16} />
        </button>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .highlight-popover {
    display: flex;
    gap: 2px;
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 6px;
    padding: 2px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .popover-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: none;
    background: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--text-xs);
    color: var(--color-text, #1a1a1a);
    white-space: nowrap;
  }

  .popover-btn:hover {
    background: var(--color-hover, #f1f5f9);
  }

  .popover-btn.icon-only,
  .popover-status.icon-only {
    padding: 6px;
  }

  .popover-btn.remove:hover {
    background: #fef2f2;
    color: #dc2626;
  }

  .popover-status {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    font-size: var(--text-xs);
    color: var(--color-text-muted, #64748b);
    white-space: nowrap;
  }
</style>
