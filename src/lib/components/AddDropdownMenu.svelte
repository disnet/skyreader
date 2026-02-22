<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';

  let isOpen = $state(false);
  let menuRef: HTMLDivElement | null = $state(null);
  let buttonRef: HTMLButtonElement | null = $state(null);
  let menuPosition = $state<{ top: number; left: number }>({ top: 0, left: 0 });

  function updateMenuPosition() {
    if (!buttonRef) return;

    const buttonRect = buttonRef.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const menuWidth = 200; // min-width of menu

    let top = buttonRect.bottom + 4;
    let left = buttonRect.left;

    // If menu would overflow right edge, align to right edge of button
    if (left + menuWidth > viewportWidth - 8) {
      left = buttonRect.right - menuWidth;
    }

    // Clamp left to avoid going off screen
    if (left < 8) left = 8;

    menuPosition = { top, left };
  }

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    isOpen = !isOpen;
    if (isOpen) {
      requestAnimationFrame(() => {
        updateMenuPosition();
      });
    }
  }

  function handleItemClick(action: () => void, e: MouseEvent) {
    e.stopPropagation();
    isOpen = false;
    // Close navigation dropdown first so modals render on top
    sidebarStore.closeNavigationDropdown();
    action();
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

  // Portal action to move element to body (escapes overflow:hidden ancestors)
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
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
    document.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="add-dropdown" role="group">
  <button
    bind:this={buttonRef}
    class="add-trigger"
    onclick={toggle}
    aria-haspopup="true"
    aria-expanded={isOpen}
    aria-label="Add"
  >
    <Icon name="plus" size={16} />
    <svg class="chevron" width="8" height="8" viewBox="0 0 8 8" fill="none">
      <path
        d="M1.5 3L4 5.5L6.5 3"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>

  {#if isOpen}
    <div use:portal>
      <div
        bind:this={menuRef}
        class="add-menu"
        role="menu"
        style="top: {menuPosition.top}px; left: {menuPosition.left}px;"
      >
        <button
          class="add-menu-item"
          onclick={(e) => handleItemClick(() => sidebarStore.openAddFeedModal(), e)}
          role="menuitem"
        >
          <span class="item-icon"><Icon name="rss" size={16} /></span>
          Add RSS Feed
        </button>
        <button
          class="add-menu-item"
          onclick={(e) => handleItemClick(() => sidebarStore.openFollowUserModal(), e)}
          role="menuitem"
        >
          <span class="item-icon"><Icon name="users" size={16} /></span>
          Add Bluesky Account
        </button>
        <button
          class="add-menu-item"
          onclick={(e) => handleItemClick(() => sidebarStore.openSaveArticleModal(), e)}
          role="menuitem"
        >
          <span class="item-icon"><Icon name="bookmark" size={16} /></span>
          Save Article by URL
        </button>
        <button
          class="add-menu-item"
          onclick={(e) =>
            handleItemClick(() => {
              filteredViewsStore
                .create({
                  name: 'new view',
                  sourceMode: 'include',
                  sourceKeys: [],
                  readFilter: 'unread',
                  sortOrder: 'newest',
                })
                .then((id) => {
                  goto(`/?view=${id}`);
                  feedViewStore.setFilterToolbarOpen(true);
                  feedViewStore.setSourcePopoverOpen(true);
                });
            }, e)}
          role="menuitem"
        >
          <span class="item-icon"><Icon name="layers" size={16} /></span>
          New View
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .add-dropdown {
    position: relative;
    display: inline-flex;
  }

  .add-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.125rem;
    padding: 0.25rem 0.375rem;
    border: none;
    background: transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.2s,
      color 0.2s;
  }

  .add-trigger:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .chevron {
    opacity: 0.6;
  }

  /* Menu is portaled to body, so styles must be global */
  :global(.add-menu) {
    position: fixed;
    min-width: 200px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 9999;
    overflow: hidden;
  }

  :global(.add-menu-item) {
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

  :global(.add-menu-item:hover) {
    background: var(--color-bg-secondary);
  }

  :global(.add-menu .item-icon) {
    display: flex;
    align-items: center;
  }

  @media (prefers-color-scheme: dark) {
    :global(.add-menu) {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
  }
</style>
