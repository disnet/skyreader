<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';

  interface Props {
    controlsVisible: boolean;
    currentTitle: string;
    onScrollToTop: () => void;
    onOpenFeedSwitcher: () => void;
    onOpenFilterSheet: () => void;
    hasActiveFilters: boolean;
    hideFilterButton?: boolean;
  }

  let {
    controlsVisible,
    currentTitle,
    onScrollToTop,
    onOpenFeedSwitcher,
    onOpenFilterSheet,
    hasActiveFilters,
    hideFilterButton = false,
  }: Props = $props();

  let addMenuOpen = $state(false);
  let addMenuRef = $state<HTMLDivElement | null>(null);

  function handleAddMenuClickOutside(e: MouseEvent) {
    if (addMenuOpen && addMenuRef && !addMenuRef.contains(e.target as Node)) {
      addMenuOpen = false;
    }
  }

  $effect(() => {
    if (addMenuOpen) {
      document.addEventListener('click', handleAddMenuClickOutside, true);
      return () => {
        document.removeEventListener('click', handleAddMenuClickOutside, true);
      };
    }
  });
</script>

<div class="mobile-bottom-bar" class:hidden={!controlsVisible}>
  <button class="left-pill" onclick={onOpenFeedSwitcher} aria-label="Switch feed">
    <span class="left-pill-icon"><Icon name="layers" size={20} /></span>
    <span class="view-name">{currentTitle}</span>
  </button>

  <div class="right-pill">
    <div class="add-menu-wrapper" bind:this={addMenuRef}>
      <button
        class="bar-btn"
        class:active={addMenuOpen}
        onclick={() => (addMenuOpen = !addMenuOpen)}
        aria-label="Add"
        title="Add"
      >
        <Icon name="plus" size={20} />
        <Icon name="chevron-down" size={12} />
      </button>
      {#if addMenuOpen}
        <div class="add-menu">
          <button
            class="add-menu-item"
            onclick={() => {
              addMenuOpen = false;
              sidebarStore.openAddFeedModal();
            }}
          >
            <Icon name="rss" size={16} />
            <span>Add RSS Feed</span>
          </button>
          <button
            class="add-menu-item"
            onclick={() => {
              addMenuOpen = false;
              sidebarStore.openAddHandleModal();
            }}
          >
            <Icon name="users" size={16} />
            <span>Add @handle</span>
          </button>
          <button
            class="add-menu-item"
            onclick={() => {
              addMenuOpen = false;
              sidebarStore.openSaveArticleModal();
            }}
          >
            <Icon name="bookmark" size={16} />
            <span>Save URL</span>
          </button>
        </div>
      {/if}
    </div>
    {#if !hideFilterButton}
      <span class="bar-divider"></span>
      <button
        class="bar-btn"
        class:has-filters={hasActiveFilters}
        onclick={onOpenFilterSheet}
        aria-label="Filters and style"
        title="Filters & Style"
      >
        <Icon name="sliders" size={20} />
        {#if hasActiveFilters}
          <span class="filter-dot"></span>
        {/if}
      </button>
    {/if}
    <span class="bar-divider"></span>
    <button
      class="bar-btn"
      onclick={onScrollToTop}
      aria-label="Scroll to top"
      title="Scroll to top"
    >
      <Icon name="arrow-up" size={20} />
    </button>
  </div>
</div>

<style>
  .mobile-bottom-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    padding: 0.75rem 1rem;
    padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
    z-index: 10;
    pointer-events: none;
    transition:
      transform 0.3s ease,
      opacity 0.3s ease;
  }

  .mobile-bottom-bar.hidden {
    transform: translateY(100%);
    opacity: 0;
    pointer-events: none;
  }

  /* The pills opt back into pointer events (the bar itself is none so taps fall
     through the gaps). When the bar is hidden, revoke that — otherwise the
     invisible, translated-away controls still hit-test and you tap buttons you
     can't see. pointer-events inherits, so the pills' buttons follow. */
  .mobile-bottom-bar.hidden .left-pill,
  .mobile-bottom-bar.hidden .right-pill {
    pointer-events: none;
  }

  .left-pill {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    padding: 0.25rem 0.75rem 0.25rem 0.5rem;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    pointer-events: auto;
    border: none;
    color: var(--color-text);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    max-width: 60%;
    min-width: 0;
  }

  .left-pill:active {
    background: rgba(240, 240, 240, 0.95);
  }

  .left-pill-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.6rem;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .view-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .right-pill {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    padding: 0.25rem 0.5rem;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    pointer-events: auto;
  }

  .bar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    background: none;
    border: none;
    padding: 0.6rem;
    border-radius: 999px;
    color: var(--color-text-secondary);
    transition: all 0.2s ease;
    gap: 0.125rem;
  }

  .bar-btn:active,
  .bar-btn.active {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .bar-divider {
    width: 1px;
    height: 1.25rem;
    background: var(--color-border, #e0e0e0);
    opacity: 0.5;
  }

  .filter-dot {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    width: 6px;
    height: 6px;
    background: var(--color-primary, #0066cc);
    border-radius: 50%;
  }

  /* Add menu */
  .add-menu-wrapper {
    position: relative;
  }

  .add-menu {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    right: 0;
    min-width: 200px;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    animation: menuSlideUp 0.15s ease;
  }

  .add-menu-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    background: none;
    border: none;
    color: var(--color-text);
    font-size: var(--text-lg);
    text-align: left;
    transition: background 0.1s;
  }

  .add-menu-item:active {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .add-menu-item + .add-menu-item {
    border-top: 1px solid var(--color-border);
  }

  .add-menu-item :global(.icon) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  @keyframes menuSlideUp {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-color-scheme: dark) {
    .left-pill,
    .right-pill {
      background: rgba(40, 40, 40, 0.95);
    }

    .left-pill:active {
      background: rgba(55, 55, 55, 0.95);
    }

    .bar-divider {
      background: rgba(255, 255, 255, 0.2);
    }

    .bar-btn:active,
    .bar-btn.active {
      background: rgba(255, 255, 255, 0.15);
    }

    .add-menu {
      background: var(--color-bg, #1a1a1a);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }

    .add-menu-item:active {
      background: rgba(255, 255, 255, 0.1);
    }
  }

  /* Only show on mobile */
  @media (min-width: 1001px) {
    .mobile-bottom-bar {
      display: none;
    }
  }
</style>
