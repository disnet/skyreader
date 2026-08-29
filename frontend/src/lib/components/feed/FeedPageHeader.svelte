<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import FilterToolbar from './FilterToolbar.svelte';
  import AppearanceToolbar from './AppearanceToolbar.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { formatRelativeTime } from '$lib/utils/date';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { savedSearchStore } from '$lib/stores/savedSearch.svelte';
  import { shellToolbar } from '$lib/actions/shell-toolbar';

  interface Props {
    title: string;
    feedId?: number;
    expandAllItems?: boolean;
    lastRefreshAt?: number | null;
    isRefreshing?: boolean;
    onToggleExpandAll?: (value: boolean) => void;
    onRefresh?: () => void;
    onMarkAllAsRead?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    showSourceFilter?: boolean;
    hideControls?: boolean;
    onEditChannel?: (id: number) => void;
  }

  let {
    title,
    feedId,
    expandAllItems = false,
    lastRefreshAt,
    isRefreshing = false,
    onToggleExpandAll,
    onRefresh,
    onMarkAllAsRead,
    onEdit,
    onDelete,
    showSourceFilter = true,
    hideControls = false,
    onEditChannel,
  }: Props = $props();

  // Tick counter to force re-evaluation of relative time
  let tick = $state(0);
  let intervalId: ReturnType<typeof setInterval> | null = null;

  // Debounce refresh button
  let lastRefreshClick = 0;
  const DEBOUNCE_MS = 2000;

  function handleRefresh() {
    const now = Date.now();
    if (now - lastRefreshClick < DEBOUNCE_MS) return;
    lastRefreshClick = now;
    onRefresh?.();
  }

  onMount(() => {
    // Update relative time every minute
    intervalId = setInterval(() => {
      tick++;
    }, 60000);
    document.addEventListener('click', handleClickOutside);
  });

  onDestroy(() => {
    if (intervalId) clearInterval(intervalId);
    document.removeEventListener('click', handleClickOutside);
  });

  // Use tick to force re-evaluation (void to suppress unused warning)
  let relativeTime = $derived(
    lastRefreshAt ? (void tick, formatRelativeTime(lastRefreshAt)) : null
  );

  let styleToolbarOpen = $state(false);
  let headerRef: HTMLDivElement | undefined = $state();

  function handleClickOutside(e: MouseEvent) {
    if (
      (styleToolbarOpen || feedViewStore.filterToolbarOpen) &&
      headerRef &&
      !headerRef.contains(e.target as Node) &&
      document.contains(e.target as Node)
    ) {
      styleToolbarOpen = false;
      feedViewStore.setFilterToolbarOpen(false);
      feedViewStore.setSourcePopoverOpen(false);
    }
  }

  let dropdownOpen = $derived(sidebarStore.navigationDropdownOpen);
  let isSavedView = $derived(Boolean(feedViewStore.savedFilter) || feedViewStore.isSavedChannel);

  let menuItems = $derived.by(() => {
    const items: Array<{
      label: string;
      icon: string;
      onclick: () => void;
      variant?: 'danger';
    }> = [];
    if (onMarkAllAsRead) {
      items.push({
        label: 'Mark all as read',
        icon: '✓',
        onclick: onMarkAllAsRead,
      });
    }
    if (onEdit) {
      items.push({
        label: 'Edit',
        icon: '✏',
        onclick: onEdit,
      });
    }
    if (onDelete) {
      items.push({
        label: 'Delete',
        icon: '🗑',
        variant: 'danger',
        onclick: onDelete,
      });
    }
    return items;
  });
</script>

<div class="feed-header-fixed" bind:this={headerRef} use:shellToolbar>
  <div class="feed-header-controls">
    <div class="control-left feed-title-group" class:dropdown-open={dropdownOpen}>
      <NavigationDropdown currentTitle={title} />
      {#if menuItems.length > 0}
        <PopoverMenu items={menuItems} />
      {/if}
      {#if relativeTime}
        <span class="divider"></span>
      {/if}
      {#if relativeTime}
        <div class="last-updated">
          <span class="last-updated-text">Updated {relativeTime}</span>
          {#if onRefresh}
            <button
              class="refresh-btn"
              onclick={handleRefresh}
              disabled={isRefreshing || !syncStore.isOnline}
              aria-label="Refresh feeds"
            >
              <span class:spinning={isRefreshing}>↻</span>
            </button>
          {/if}
          {#if !syncStore.isOnline}
            <span class="offline-badge">Offline</span>
          {/if}
        </div>
      {/if}
      {#if !relativeTime && !syncStore.isOnline}
        <div class="last-updated">
          <span class="offline-badge">Offline</span>
        </div>
      {/if}
    </div>

    {#if !hideControls}
      <div class="control-right">
        {#if isSavedView}
          <div class="view-toggle" role="group" aria-label="Saved view">
            <button
              class:active={feedViewStore.savedView === 'inbox'}
              onclick={() => feedViewStore.setSavedView('inbox')}
              aria-label="Inbox"
              title="Inbox"
            >
              <Icon name="inbox" size={16} />
              <span class="btn-label">Inbox</span>
            </button>
            <button
              class:active={feedViewStore.savedView === 'archive'}
              onclick={() => feedViewStore.setSavedView('archive')}
              aria-label="Archive"
              title="Archive"
            >
              <Icon name="archive" size={16} />
              <span class="btn-label">Archive</span>
            </button>
            {#if !feedViewStore.isSavedChannel}
              <span class="toggle-divider"></span>
              <button
                onclick={() => feedViewStore.toggleSortOrder()}
                title={feedViewStore.currentSortOrder === 'newest'
                  ? 'Newest first'
                  : 'Oldest first'}
              >
                <Icon
                  name={feedViewStore.currentSortOrder === 'newest' ? 'arrow-down' : 'arrow-up'}
                  size={16}
                />
                <span class="btn-label"
                  >{feedViewStore.currentSortOrder === 'newest' ? 'New' : 'Old'}</span
                >
              </button>
            {/if}
            <span class="toggle-divider"></span>
            <button
              class:active={savedSearchStore.open || savedSearchStore.active}
              onclick={() => savedSearchStore.toggle()}
              aria-label="Search saved items"
              aria-pressed={savedSearchStore.open}
              title="Search saved (/)"
            >
              <Icon name="search" size={16} />
              <span class="btn-label">Search</span>
            </button>
            <span class="toggle-divider"></span>
            <button
              onclick={() => sidebarStore.openSaveArticleModal()}
              aria-label="Save article by URL"
              title="Save article by URL"
            >
              <Icon name="plus" size={16} />
              <span class="btn-label">Add</span>
            </button>
            {#if feedViewStore.isSavedChannel && onEditChannel}
              <span class="toggle-divider"></span>
              <button
                onclick={() => onEditChannel(parseInt(feedViewStore.viewFilter!))}
                aria-label="Edit channel"
                title="Edit channel"
              >
                <Icon name="edit" size={16} />
                <span class="btn-label">Edit</span>
              </button>
            {/if}
          </div>
        {:else}
          <div class="view-toggle" role="group" aria-label="View controls">
            {#if onToggleExpandAll}
              <button
                class:active={!expandAllItems}
                onclick={() => onToggleExpandAll(false)}
                aria-label="List view"
                title="List view"
              >
                <Icon name="list" size={16} />
                <span class="btn-label">List</span>
              </button>
              <button
                class:active={expandAllItems}
                onclick={() => onToggleExpandAll(true)}
                aria-label="Expanded view"
                title="Expanded view"
              >
                <Icon name="newspaper" size={16} />
                <span class="btn-label">Expand</span>
              </button>
              <span class="toggle-divider"></span>
            {/if}
            <button
              class:active={styleToolbarOpen}
              onclick={() => {
                styleToolbarOpen = !styleToolbarOpen;
                if (styleToolbarOpen) feedViewStore.setFilterToolbarOpen(false);
              }}
              aria-label="Toggle style"
              title="Style"
            >
              <Icon name="type" size={16} />
              <span class="btn-label">Style</span>
            </button>
            <span class="toggle-divider"></span>
            <button
              class="filter-toggle-btn"
              class:active={feedViewStore.filterToolbarOpen}
              onclick={() => {
                const opening = !feedViewStore.filterToolbarOpen;
                feedViewStore.setFilterToolbarOpen(opening);
                if (opening) {
                  styleToolbarOpen = false;
                } else {
                  feedViewStore.setSourcePopoverOpen(false);
                }
              }}
              aria-label="Toggle filters"
              title="Filter"
            >
              <Icon name="filter" size={16} />
              <span class="btn-label">Filter</span>
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if !isSavedView && styleToolbarOpen}
    <div class="filter-toolbar-row">
      <AppearanceToolbar />
    </div>
  {/if}
  {#if !feedViewStore.isSavedChannel && feedViewStore.filterToolbarOpen}
    <div class="filter-toolbar-row">
      <FilterToolbar {showSourceFilter} {onEditChannel} />
    </div>
  {/if}
</div>

<style>
  /* The page's control bar. `shellToolbar` moves it out of the content card
     and into the shell's toolbar strip, where it sits on the ground colour
     directly above the card — so the card's top edge stays put and no divider
     or scroll-aware state is needed to separate the two. The strip is the
     bar's background; the bar itself is transparent. */
  .feed-header-fixed {
    background: transparent;
  }

  /* The bar spans the card's full width rather than tracking the 800px reading
     column: the title anchors the card's left edge and the controls its right,
     so the strip frames the card instead of floating a second column above it. */
  .feed-header-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    min-height: var(--shell-bar-height);
    padding: 0.25rem var(--shell-bar-inset);
  }

  .control-left {
    min-width: 0;
    flex: 0 1 auto;
  }

  /* The buttons carry their own 0.6rem of padding; pulling it back out lands
     their glyphs on the same inset as the title on the other edge, instead of
     leaving the right side visibly further from the card than the left. */
  .control-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    margin-right: -0.6rem;
  }

  .feed-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    max-width: 100%;
  }

  .feed-title-group.dropdown-open {
    z-index: 1002;
  }

  .divider {
    width: 1px;
    height: 1rem;
    background: var(--color-border);
    opacity: 0.5;
    flex-shrink: 0;
  }

  /* Below 1000px the mobile bottom bar takes over. */
  @media (max-width: 1000px) {
    .feed-header-fixed {
      display: none;
    }
  }

  /* On narrower desktops, drop the control labels to icons so the bar never
     crowds against the title group. */
  @media (max-width: 1100px) {
    .btn-label {
      display: none;
    }

    .view-toggle button {
      padding: 0.4rem;
    }

    .control-right {
      margin-right: -0.4rem;
    }
  }

  .last-updated {
    font-size: var(--text-2xs);
    color: var(--color-text-muted, var(--color-text-secondary));
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .last-updated-text {
    white-space: nowrap;
  }

  .offline-badge {
    font-size: var(--text-3xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    color: var(--color-warning-text, #92400e);
    background: var(--color-warning-bg, #fef3c7);
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    white-space: nowrap;
  }

  .refresh-btn {
    background: none;
    border: none;
    padding: 0.125rem;
    cursor: pointer;
    color: inherit;
    font-size: var(--text-base);
    line-height: var(--leading-none);
    opacity: 0.8;
    transition: opacity 0.15s;
  }

  .refresh-btn:hover:not(:disabled) {
    opacity: 1;
  }

  .refresh-btn:disabled {
    cursor: default;
  }

  .refresh-btn .spinning {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .view-toggle {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .view-toggle button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    background: none;
    border: none;
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  /* On the ground colour a Sunken fill would be invisible, so the selected
     control takes the card's own surface — it reads as the chip being lifted
     to the same plane as the content it controls. */
  .view-toggle button.active {
    background: var(--color-bg);
    color: var(--color-text);
  }

  .view-toggle button:hover:not(.active) {
    color: var(--color-text);
  }

  .btn-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .toggle-divider {
    width: 1px;
    height: 1rem;
    background: var(--color-border, #e0e0e0);
    margin: 0 0.25rem;
    opacity: 0.5;
  }

  /* Filter toggle button */
  .filter-toggle-btn {
    position: relative;
  }

  /* Secondary control row (filters / appearance), inline beneath the main bar.
     The child toolbars carry a floating glass-pill style for mobile/reader use;
     strip it here so they read as a flat extension of the solid bar. */
  .filter-toolbar-row {
    padding: 0 var(--shell-bar-inset) 0.5rem;
    display: flex;
    justify-content: flex-end;
  }

  .filter-toolbar-row :global(.filter-toolbar),
  .filter-toolbar-row :global(.appearance-toolbar) {
    background: transparent;
    backdrop-filter: none;
    box-shadow: none;
    border-radius: 0;
    padding: 0;
  }

  @media (prefers-color-scheme: dark) {
    .offline-badge {
      color: #fbbf24;
      background: rgba(251, 191, 36, 0.15);
    }
  }
</style>
