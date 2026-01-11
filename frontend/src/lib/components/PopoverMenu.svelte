<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface MenuItem {
    label: string;
    icon?: string;
    variant?: 'default' | 'danger';
    onclick: () => void;
  }

  interface Props {
    items: MenuItem[];
  }

  let { items }: Props = $props();

  let isOpen = $state(false);
  let menuRef: HTMLDivElement | null = $state(null);
  let buttonRef: HTMLButtonElement | null = $state(null);
  let closeTimeout: ReturnType<typeof setTimeout> | null = null;

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    isOpen = !isOpen;
  }

  function handleMouseLeave() {
    closeTimeout = setTimeout(() => {
      isOpen = false;
    }, 150);
  }

  function handleMouseEnter() {
    if (closeTimeout) {
      clearTimeout(closeTimeout);
      closeTimeout = null;
    }
  }

  function handleItemClick(item: MenuItem, e: MouseEvent) {
    e.stopPropagation();
    isOpen = false;
    item.onclick();
  }

  function handleClickOutside(e: MouseEvent) {
    if (
      isOpen &&
      menuRef &&
      buttonRef &&
      !menuRef.contains(e.target as Node) &&
      !buttonRef.contains(e.target as Node)
    ) {
      isOpen = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (isOpen && e.key === 'Escape') {
      isOpen = false;
      buttonRef?.focus();
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
    document.removeEventListener('keydown', handleKeydown);
    if (closeTimeout) clearTimeout(closeTimeout);
  });
</script>

<div class="popover-menu" onmouseleave={handleMouseLeave} onmouseenter={handleMouseEnter}>
  <button
    bind:this={buttonRef}
    class="menu-trigger"
    onclick={toggle}
    aria-haspopup="true"
    aria-expanded={isOpen}
  >
    <span class="dots">⋯</span>
  </button>

  {#if isOpen}
    <div bind:this={menuRef} class="menu-dropdown" role="menu">
      {#each items as item}
        <button
          class="menu-item"
          class:danger={item.variant === 'danger'}
          onclick={(e) => handleItemClick(item, e)}
          role="menuitem"
        >
          {#if item.icon}
            <span class="item-icon">{item.icon}</span>
          {/if}
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .popover-menu {
    position: relative;
    display: inline-block;
  }

  .menu-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background-color 0.2s, color 0.2s;
  }

  .menu-trigger:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .dots {
    font-size: 1.25rem;
    line-height: 1;
  }

  .menu-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    min-width: 140px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 50;
    overflow: hidden;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.625rem 0.875rem;
    border: none;
    background: transparent;
    color: var(--color-text);
    font-size: 0.875rem;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .menu-item:hover {
    background: var(--color-bg-secondary);
  }

  .menu-item.danger {
    color: var(--color-error);
  }

  .menu-item.danger:hover {
    background: rgba(244, 67, 54, 0.1);
  }

  .item-icon {
    font-size: 1rem;
  }
</style>
