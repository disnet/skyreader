<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    mode: 'create' | 'remove';
    anchorRect: DOMRect;
    onHighlight?: () => void;
    onRemove?: () => void;
    onClose: () => void;
  }

  let { mode, anchorRect, onHighlight, onRemove, onClose }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);

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

  function handleClickOutside(e: MouseEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('scroll', onClose, true);
    requestAnimationFrame(positionMenu);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('mousedown', handleClickOutside, true);
    document.removeEventListener('scroll', onClose, true);
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
      class="popover-btn"
      onclick={() => {
        onHighlight?.();
        onClose();
      }}
    >
      <Icon name="highlighter" size={14} />
      <span>Highlight</span>
    </button>
  {:else}
    <button
      class="popover-btn remove"
      onclick={() => {
        onRemove?.();
        onClose();
      }}
    >
      <Icon name="x" size={14} />
      <span>Remove</span>
    </button>
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
    font-size: 12px;
    color: var(--color-text, #1a1a1a);
    white-space: nowrap;
  }

  .popover-btn:hover {
    background: var(--color-hover, #f1f5f9);
  }

  .popover-btn.remove:hover {
    background: #fef2f2;
    color: #dc2626;
  }
</style>
