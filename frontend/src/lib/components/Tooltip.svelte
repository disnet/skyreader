<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    text: string;
  }

  let { text }: Props = $props();

  let open = $state(false);
  let btnRef: HTMLButtonElement | null = $state(null);
  let tooltipRef: HTMLDivElement | null = $state(null);
  let position = $state<{ top: number; left: number }>({ top: 0, left: 0 });

  function toggle(e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    open = !open;
    if (open) {
      requestAnimationFrame(updatePosition);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(e);
    } else if (e.key === 'Escape' && open) {
      open = false;
    }
  }

  function updatePosition() {
    if (!btnRef) return;
    const rect = btnRef.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const tooltipWidth = 200;

    let top = rect.bottom + 4;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;

    if (left + tooltipWidth > viewportWidth - 8) {
      left = viewportWidth - tooltipWidth - 8;
    }
    if (left < 8) left = 8;

    position = { top, left };
  }

  function handleClickOutside(e: MouseEvent) {
    if (
      open &&
      btnRef &&
      tooltipRef &&
      !btnRef.contains(e.target as Node) &&
      !tooltipRef.contains(e.target as Node)
    ) {
      open = false;
    }
  }

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
  });
</script>

<button
  bind:this={btnRef}
  class="tooltip-trigger"
  onclick={toggle}
  onkeydown={handleKeydown}
  aria-label="Info"
  aria-expanded={open}
>
  ?
</button>

{#if open}
  <div use:portal>
    <div
      bind:this={tooltipRef}
      class="tooltip-popup"
      role="tooltip"
      style="top: {position.top}px; left: {position.left}px;"
    >
      {text}
    </div>
  </div>
{/if}

<style>
  .tooltip-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--color-text-secondary);
    background: none;
    cursor: pointer;
    font-size: 0.5625rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    padding: 0;
    line-height: 1;
    flex-shrink: 0;
    opacity: 0.6;
    transition: opacity 0.15s;
  }

  .tooltip-trigger:hover {
    opacity: 1;
  }

  :global(.tooltip-popup) {
    position: fixed;
    width: 200px;
    padding: 0.5rem 0.625rem;
    background: var(--color-bg);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    font-size: 0.75rem;
    line-height: 1.4;
    z-index: 9999;
  }

  @media (prefers-color-scheme: dark) {
    :global(.tooltip-popup) {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
  }
</style>
