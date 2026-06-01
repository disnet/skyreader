<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { tick, onMount, onDestroy } from 'svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import Icon from './Icon.svelte';
  import AddDropdownMenu from './AddDropdownMenu.svelte';

  interface Props {
    currentTitle: string;
  }

  let { currentTitle }: Props = $props();

  // Derive data from stores
  let subscriptions = $derived(subscriptionsStore.subscriptions);

  let feedUnreadCounts = $derived(unreadCounts.feedCounts);
  let totalUnread = $derived(unreadCounts.totalArticles);

  let savedCount = $derived(itemLabelsStore.savedCount);

  let searchQuery = $state('');
  let highlightedIndex = $state(-1);
  let dropdownEl = $state<HTMLDivElement | null>(null);
  let searchInputEl = $state<HTMLInputElement | null>(null);
  let mobilePanelEl = $state<HTMLDivElement | null>(null);
  let isMobile = $state(false);

  // View context menu state (uses uuid for identification)
  let viewMenuUuid = $state<string | null>(null);
  let viewMenuX = $state(0);
  let viewMenuY = $state(0);
  let viewMenuRef = $state<HTMLDivElement | null>(null);
  let adjustedMenuX = $state(0);
  let adjustedMenuY = $state(0);
  let renamingViewUuid = $state<string | null>(null);
  let renameValue = $state('');
  let renameInputRef = $state<HTMLInputElement | null>(null);

  function openViewMenu(e: MouseEvent, viewUuid: string) {
    e.stopPropagation();
    e.preventDefault();
    viewMenuX = e.clientX;
    viewMenuY = e.clientY;
    viewMenuUuid = viewUuid;
  }

  $effect(() => {
    const targetX = viewMenuX;
    const targetY = viewMenuY;

    tick().then(() => {
      if (viewMenuRef) {
        const rect = viewMenuRef.getBoundingClientRect();
        const padding = 8;

        adjustedMenuX =
          targetX + rect.width > window.innerWidth - padding
            ? Math.max(padding, window.innerWidth - rect.width - padding)
            : targetX;

        adjustedMenuY =
          targetY + rect.height > window.innerHeight - padding
            ? Math.max(padding, window.innerHeight - rect.height - padding)
            : targetY;
      }
    });
  });

  function closeViewMenu() {
    viewMenuUuid = null;
  }

  function startRenameView(viewUuid: string) {
    const view = filteredViewsStore.getByUuid(viewUuid);
    if (!view) return;
    closeViewMenu();
    renamingViewUuid = viewUuid;
    renameValue = view.name;
    tick().then(() => {
      renameInputRef?.focus();
      renameInputRef?.select();
    });
  }

  function commitRenameView() {
    const trimmed = renameValue.trim();
    if (renamingViewUuid !== null && trimmed) {
      const view = filteredViewsStore.getByUuid(renamingViewUuid);
      if (view && view.id != null && trimmed !== view.name) {
        filteredViewsStore.update(view.id, { name: trimmed });
      }
    }
    renamingViewUuid = null;
    renameValue = '';
  }

  function cancelRenameView() {
    renamingViewUuid = null;
    renameValue = '';
  }

  async function deleteView(viewUuid: string) {
    closeViewMenu();
    if (!confirm('Are you sure you want to delete this channel?')) return;
    const view = filteredViewsStore.getByUuid(viewUuid);
    if (!view || view.id == null) return;
    await filteredViewsStore.remove(view.id);
    // If we're currently viewing the deleted view, navigate away
    const currentView = $page.url.searchParams.get('view');
    if (currentView === viewUuid) {
      goto('/');
    }
  }

  // Use store for open state so it can be controlled externally (keyboard shortcut)
  let isOpen = $derived(sidebarStore.navigationDropdownOpen);

  // Check if we're on mobile
  function checkMobile() {
    isMobile = window.matchMedia('(max-width: 1000px)').matches;
  }

  onMount(() => {
    checkMobile();
    window.addEventListener('resize', checkMobile);
  });

  onDestroy(() => {
    window.removeEventListener('resize', checkMobile);
  });

  // Icon names type (matches Icon.svelte)
  type IconName =
    | 'inbox'
    | 'bookmark'
    | 'share'
    | 'search'
    | 'bell'
    | 'settings'
    | 'rss'
    | 'newspaper'
    | 'plus'
    | 'filter'
    | 'layers'
    | 'folder';

  // Navigation item type
  type NavItem =
    | { type: 'view'; id: string; label: string; count?: number; icon: IconName; indent?: boolean }
    | {
        type: 'feed';
        id: number;
        label: string;
        count: number;
        iconUrl: string | null;
        indent?: boolean;
      }
    | {
        type: 'utility';
        id: string;
        label: string;
        count?: number;
        icon: IconName;
        indent?: boolean;
      }
    | { type: 'action'; id: string; label: string; icon: IconName; indent?: boolean }
    | { type: 'filteredView'; id: string; label: string; icon: IconName; indent?: boolean };

  // Section type with optional icon and click handler for styled section headers
  type SectionData = {
    section: string;
    icon?: IconName;
    onSectionClick?: () => void;
    items: NavItem[];
  };

  // Build filtered items list
  let filteredItems = $derived.by((): SectionData[] => {
    const query = searchQuery.toLowerCase().trim();

    const everythingItem: NavItem = {
      type: 'view',
      id: 'all',
      label: 'Everything',
      count: totalUnread,
      icon: 'inbox',
    };
    const savedItem: NavItem = {
      type: 'view',
      id: 'saved',
      label: 'Saved',
      count: savedCount,
      icon: 'bookmark',
    };
    const otherViews: NavItem[] = [
      { type: 'utility', id: 'sources', label: 'Manage Sources', icon: 'rss' },
      { type: 'utility', id: 'settings', label: 'Settings', icon: 'settings' },
    ];

    const sourceChannelItems: NavItem[] = filteredViewsStore.views
      .filter((v) => v.mode !== 'saved')
      .map((v) => ({
        type: 'filteredView' as const,
        id: v.uuid,
        label: v.name,
        icon: 'filter' as const,
        indent: true,
      }));

    const savedChannelItems: NavItem[] = filteredViewsStore.views
      .filter((v) => v.mode === 'saved')
      .map((v) => ({
        type: 'filteredView' as const,
        id: v.uuid,
        label: v.name,
        icon: 'bookmark' as const,
        indent: true,
      }));

    const addViewAction: NavItem = {
      type: 'action',
      id: 'add-channel',
      label: 'New channel',
      icon: 'plus',
    };

    function toFeedItem(s: (typeof subscriptions)[0]): NavItem & { type: 'feed' } {
      return {
        type: 'feed' as const,
        id: s.id!,
        label: s.customTitle || s.title,
        count: feedUnreadCounts.get(s.id!) || 0,
        iconUrl:
          s.customIconUrl ||
          (s.sourceType?.startsWith('atproto.')
            ? s.siteUrl
              ? getFaviconUrl(s.siteUrl)
              : '/icons/icon-192.svg'
            : getFaviconUrl(s.siteUrl || s.feedUrl || '')),
      };
    }

    // Group subscriptions by category
    const byCategory = new Map<string, typeof subscriptions>();
    const uncategorized: typeof subscriptions = [];
    for (const s of subscriptions) {
      if (s.category) {
        const existing = byCategory.get(s.category) || [];
        existing.push(s);
        byCategory.set(s.category, existing);
      } else {
        uncategorized.push(s);
      }
    }

    // Filter by search query
    const filterItem = (item: NavItem) => {
      if (!query) return true;
      return item.label.toLowerCase().includes(query);
    };

    const filterSection = (sectionName: string) => {
      if (!query) return true;
      return sectionName.toLowerCase().includes(query);
    };

    const sections: SectionData[] = [];

    // Everything group: Everything + nested source channels
    const everythingGroup = [everythingItem, ...sourceChannelItems].filter(filterItem);
    if (everythingGroup.length > 0) {
      sections.push({ section: '', items: everythingGroup });
    }

    // Saved group: Saved + nested saved channels
    const savedGroup = [savedItem, ...savedChannelItems].filter(filterItem);
    if (savedGroup.length > 0) {
      sections.push({ section: '', items: savedGroup });
    }

    // Other views + add action
    const otherGroup = [...otherViews, addViewAction].filter(filterItem);
    if (otherGroup.length > 0) {
      sections.push({ section: '', items: otherGroup });
    }

    // Categorized feeds - one section per folder
    const sortedCategories = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [category, subs] of sortedCategories) {
      const items = subs.map(toFeedItem).filter(filterItem);
      if (items.length > 0 || filterSection(category)) {
        sections.push({
          section: category,
          icon: 'folder' as IconName,
          items,
        });
      }
    }

    // Uncategorized feeds
    const uncategorizedItems = uncategorized.map(toFeedItem).filter(filterItem);
    if (uncategorizedItems.length > 0 || filterSection('Feeds')) {
      sections.push({
        section: sortedCategories.length > 0 ? 'Uncategorized' : 'Feeds',
        icon: 'rss',
        onSectionClick: () => {
          sidebarStore.toggleSection('feeds');
          close();
        },
        items: uncategorizedItems,
      });
    }

    return sections;
  });

  // Flat list of all items for keyboard navigation
  let flatItems = $derived(filteredItems.flatMap((s) => s.items));

  // Derive the current view's icon for the trigger button
  type TriggerIcon = { type: 'icon'; name: IconName } | { type: 'favicon'; url: string };

  let currentIcon = $derived.by((): TriggerIcon => {
    const pathname = $page.url.pathname;

    // Utility pages (separate routes)
    if (pathname === '/sources') return { type: 'icon', name: 'rss' };
    if (pathname === '/settings') return { type: 'icon', name: 'settings' };

    // Feed page filters (query params on /)
    const url = $page.url;
    const feed = url.searchParams.get('feed');
    const saved = url.searchParams.get('saved');
    const shared = url.searchParams.get('shared');
    const view = url.searchParams.get('view');

    if (view) return { type: 'icon', name: 'filter' };
    if (saved) return { type: 'icon', name: 'bookmark' };
    if (shared) return { type: 'icon', name: 'share' };

    if (feed) {
      const sub = subscriptions.find((s) => s.id === parseInt(feed));
      if (sub) {
        const iconUrl =
          sub.customIconUrl ||
          (sub.sourceType?.startsWith('atproto.')
            ? sub.siteUrl
              ? getFaviconUrl(sub.siteUrl)
              : '/icons/icon-192.svg'
            : getFaviconUrl(sub.siteUrl || sub.feedUrl || ''));
        return { type: 'favicon', url: iconUrl };
      }
      return { type: 'icon', name: 'rss' };
    }

    return { type: 'icon', name: 'inbox' };
  });

  // Get current filter from URL
  let currentFilter = $derived.by(() => {
    const url = $page.url;
    const feed = url.searchParams.get('feed');
    const saved = url.searchParams.get('saved');
    const shared = url.searchParams.get('shared');
    const view = url.searchParams.get('view');
    if (view) return { type: 'filteredView', id: view };
    if (feed) return { type: 'feed', id: parseInt(feed) };
    if (saved) return { type: 'saved' };
    if (shared) return { type: 'shared' };
    return { type: 'all' };
  });

  function isItemActive(item: NavItem): boolean {
    const filter = currentFilter;
    if (item.type === 'view') {
      if (item.id === 'all' && filter.type === 'all') return true;
      if (item.id === 'saved' && filter.type === 'saved') return true;
      if (item.id === 'shared' && filter.type === 'shared') return true;
    }
    if (item.type === 'feed' && filter.type === 'feed' && filter.id === item.id) return true;
    if (item.type === 'filteredView' && filter.type === 'filteredView' && filter.id === item.id)
      return true;
    return false;
  }

  function open() {
    searchQuery = '';
    highlightedIndex = 0;
    sidebarStore.toggleNavigationDropdown();
    // Focus search input after opening
    requestAnimationFrame(() => {
      searchInputEl?.focus();
    });
  }

  function toggle() {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }

  function close() {
    sidebarStore.closeNavigationDropdown();
    searchQuery = '';
    highlightedIndex = -1;
    closeViewMenu();
    cancelRenameView();
  }

  // When opened externally (keyboard shortcut), set up focus
  $effect(() => {
    if (isOpen) {
      searchQuery = '';
      highlightedIndex = 0;
      requestAnimationFrame(() => {
        searchInputEl?.focus();
      });
    }
  });

  function selectItem(item: NavItem) {
    if (item.type === 'action') {
      close();
      if (item.id === 'add-channel') {
        filteredViewsStore
          .create({
            name: 'new channel',
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
      }
      return;
    }
    let url = '/';
    if (item.type === 'view') {
      if (item.id === 'saved') url = '/?saved=true';
      else if (item.id === 'shared') url = '/?shared=true';
    } else if (item.type === 'feed') {
      url = `/?feed=${item.id}`;
    } else if (item.type === 'filteredView') {
      url = `/?view=${item.id}`;
    } else if (item.type === 'utility') {
      url = `/${item.id}`;
    }
    goto(url);
    close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!isOpen) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }

    // Arrow down or Ctrl+N
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, flatItems.length - 1);
      return;
    }

    // Arrow up or Ctrl+P
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, 0);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const index = highlightedIndex >= 0 ? highlightedIndex : 0;
      const item = flatItems[index];
      if (item) selectItem(item);
      return;
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (isOpen && dropdownEl && !dropdownEl.contains(e.target as Node)) {
      close();
    }
  }

  function handleBackdropClick() {
    close();
  }

  // Global click listener for click-outside
  $effect(() => {
    if (isOpen && !isMobile) {
      document.addEventListener('click', handleClickOutside);
      return () => {
        document.removeEventListener('click', handleClickOutside);
      };
    }
  });

  // Prevent body scroll on mobile when open
  $effect(() => {
    if (isMobile && isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  });

  // Adjust panel size when virtual keyboard appears (using Visual Viewport API)
  $effect(() => {
    if (!isMobile || !isOpen || !mobilePanelEl) return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    function updatePanelHeight() {
      if (!mobilePanelEl || !viewport) return;
      // Calculate available height from visual viewport (accounts for keyboard)
      const availableHeight = viewport.height - 24; // 24px for margins
      mobilePanelEl.style.maxHeight = `${availableHeight}px`;
    }

    updatePanelHeight();
    viewport.addEventListener('resize', updatePanelHeight);

    return () => {
      viewport.removeEventListener('resize', updatePanelHeight);
      if (mobilePanelEl) {
        mobilePanelEl.style.maxHeight = '';
      }
    };
  });

  function handlePanelTouchMove(e: TouchEvent) {
    // Allow scrolling within items-container, prevent elsewhere
    const target = e.target as HTMLElement;
    const itemsContainer = target.closest('.items-container');
    if (!itemsContainer) {
      e.preventDefault();
    }
  }

  // Portal action to move element to body
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

<div class="nav-dropdown" bind:this={dropdownEl}>
  <button class="trigger" onclick={toggle} aria-haspopup="listbox" aria-expanded={isOpen}>
    {#if currentIcon.type === 'icon'}
      <span class="trigger-icon"><Icon name={currentIcon.name} size={16} /></span>
    {:else if currentIcon.type === 'favicon'}
      <img src={currentIcon.url} alt="" class="trigger-favicon" />
    {/if}
    <span class="trigger-title">{currentTitle}</span>
    <svg
      class="trigger-chevron"
      class:open={isOpen}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2.5 4.5L6 8L9.5 4.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>

  {#if isOpen && !isMobile}
    <!-- Desktop dropdown (absolute positioned within container) -->
    <button class="backdrop" onclick={handleBackdropClick} aria-label="Close navigation"></button>
    <div class="dropdown-panel" role="listbox">
      <div class="search-container">
        <input
          bind:this={searchInputEl}
          type="text"
          class="search-input"
          placeholder="Quick switch..."
          bind:value={searchQuery}
        />
        <AddDropdownMenu />
      </div>
      <div class="items-container">
        {#each filteredItems as { section, icon, onSectionClick, items }, sectionIndex}
          {#if section}
            <button
              class="section-header"
              onclick={() => onSectionClick?.()}
              class:clickable={!!onSectionClick}
            >
              {#if icon}
                <span class="section-icon"><Icon name={icon} size={16} /></span>
              {/if}
              <span class="section-label">{section}</span>
            </button>
          {/if}
          {#each items as item, itemIndex}
            {@const flatIndex =
              filteredItems.slice(0, sectionIndex).reduce((acc, s) => acc + s.items.length, 0) +
              itemIndex}
            {#if item.type === 'filteredView' && renamingViewUuid === item.id}
              <div class="nav-item rename-row" class:section-child={item.indent || !!section}>
                <span class="item-icon"><Icon name={item.icon} size={16} /></span>
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  bind:this={renameInputRef}
                  bind:value={renameValue}
                  class="view-rename-input"
                  onclick={(e) => e.stopPropagation()}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRenameView();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRenameView();
                    }
                  }}
                  onblur={commitRenameView}
                />
              </div>
            {:else}
              <button
                class="nav-item"
                class:section-child={item.indent || !!section}
                class:active={isItemActive(item)}
                class:highlighted={flatIndex === highlightedIndex}
                role="option"
                aria-selected={isItemActive(item)}
                onclick={() => selectItem(item)}
                onmouseenter={() => (highlightedIndex = flatIndex)}
              >
                {#if item.type === 'view' || item.type === 'utility' || item.type === 'action' || item.type === 'filteredView'}
                  <span class="item-icon"><Icon name={item.icon} size={16} /></span>
                {:else if item.type === 'feed'}
                  {#if item.iconUrl}
                    <img src={item.iconUrl} alt="" class="feed-icon" />
                  {:else}
                    <span class="feed-icon-placeholder"></span>
                  {/if}
                {/if}
                <span class="item-label">{item.label}</span>
                {#if item.type !== 'action' && item.type !== 'filteredView' && item.count && item.count > 0}
                  <span class="item-count">{item.count}</span>
                {/if}
                {#if item.type === 'filteredView'}
                  <span
                    class="view-more-btn"
                    role="button"
                    tabindex="0"
                    onclick={(e) => openViewMenu(e, item.id)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        openViewMenu(e as unknown as MouseEvent, item.id);
                      }
                    }}
                    title="More options"
                  >
                    <Icon name="more-horizontal" size={14} />
                  </span>
                {/if}
              </button>
            {/if}
          {/each}
        {/each}
        {#if flatItems.length === 0}
          <div class="no-results">No matches found</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if viewMenuUuid !== null}
  <!-- View context menu (portaled to body to escape backdrop-filter containing block) -->
  <div class="view-menu-portal" use:portal>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="view-menu-backdrop" onclick={closeViewMenu} onkeydown={() => {}}></div>
    <div
      class="view-context-menu"
      bind:this={viewMenuRef}
      style="left: {adjustedMenuX}px; top: {adjustedMenuY}px;"
      role="menu"
    >
      <button class="view-menu-item" onclick={() => startRenameView(viewMenuUuid!)} role="menuitem">
        <span class="view-menu-icon"><Icon name="edit" size={16} /></span>
        Rename
      </button>
      <button
        class="view-menu-item danger"
        onclick={() => deleteView(viewMenuUuid!)}
        role="menuitem"
      >
        <span class="view-menu-icon"><Icon name="trash" size={16} /></span>
        Delete
      </button>
    </div>
  </div>
{/if}

{#if isOpen && isMobile}
  <!-- Mobile overlay (portaled to body to escape backdrop-filter containing block) -->
  <div class="mobile-portal" use:portal>
    <button class="backdrop mobile" onclick={handleBackdropClick} aria-label="Close navigation"
    ></button>
    <div
      class="dropdown-panel mobile"
      role="listbox"
      ontouchmove={handlePanelTouchMove}
      bind:this={mobilePanelEl}
    >
      <div class="search-container mobile">
        <input
          bind:this={searchInputEl}
          type="text"
          class="search-input"
          placeholder="Quick switch..."
          bind:value={searchQuery}
        />
        <AddDropdownMenu />
        <button class="mobile-close-btn" onclick={close} aria-label="Close">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M18 6L6 18M6 6l12 12"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <div class="items-container">
        {#each filteredItems as { section, icon, onSectionClick, items }, sectionIndex}
          {#if section}
            <button
              class="section-header"
              onclick={() => onSectionClick?.()}
              class:clickable={!!onSectionClick}
            >
              {#if icon}
                <span class="section-icon"><Icon name={icon} size={16} /></span>
              {/if}
              <span class="section-label">{section}</span>
            </button>
          {/if}
          {#each items as item, itemIndex}
            {@const flatIndex =
              filteredItems.slice(0, sectionIndex).reduce((acc, s) => acc + s.items.length, 0) +
              itemIndex}
            {#if item.type === 'filteredView' && renamingViewUuid === item.id}
              <div class="nav-item rename-row" class:section-child={item.indent || !!section}>
                <span class="item-icon"><Icon name={item.icon} size={16} /></span>
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  bind:this={renameInputRef}
                  bind:value={renameValue}
                  class="view-rename-input"
                  onclick={(e) => e.stopPropagation()}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRenameView();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRenameView();
                    }
                  }}
                  onblur={commitRenameView}
                />
              </div>
            {:else}
              <button
                class="nav-item"
                class:section-child={item.indent || !!section}
                class:active={isItemActive(item)}
                class:highlighted={flatIndex === highlightedIndex}
                role="option"
                aria-selected={isItemActive(item)}
                onclick={() => selectItem(item)}
                onmouseenter={() => (highlightedIndex = flatIndex)}
              >
                {#if item.type === 'view' || item.type === 'utility' || item.type === 'action' || item.type === 'filteredView'}
                  <span class="item-icon"><Icon name={item.icon} size={16} /></span>
                {:else if item.type === 'feed'}
                  {#if item.iconUrl}
                    <img src={item.iconUrl} alt="" class="feed-icon" />
                  {:else}
                    <span class="feed-icon-placeholder"></span>
                  {/if}
                {/if}
                <span class="item-label">{item.label}</span>
                {#if item.type !== 'action' && item.type !== 'filteredView' && item.count && item.count > 0}
                  <span class="item-count">{item.count}</span>
                {/if}
                {#if item.type === 'filteredView'}
                  <span
                    class="view-more-btn"
                    role="button"
                    tabindex="0"
                    onclick={(e) => openViewMenu(e, item.id)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        openViewMenu(e as unknown as MouseEvent, item.id);
                      }
                    }}
                    title="More options"
                  >
                    <Icon name="more-horizontal" size={14} />
                  </span>
                {/if}
              </button>
            {/if}
          {/each}
        {/each}
        {#if flatItems.length === 0}
          <div class="no-results">No matches found</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .nav-dropdown {
    position: relative;
    flex: 0 1 auto;
    min-width: 0;
  }

  .trigger {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    color: var(--color-text);
    max-width: 100%;
    min-width: 0;
    transition: color 0.15s;
  }

  .trigger:hover {
    color: var(--color-primary);
  }

  .trigger-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .trigger-favicon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 2px;
    object-fit: contain;
    display: block;
  }

  .trigger-title {
    font-size: 1rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .trigger-title {
      display: none;
    }
  }

  .trigger-chevron {
    flex-shrink: 0;
    transition: transform 0.2s ease;
    opacity: 0.6;
  }

  .trigger-chevron.open {
    transform: rotate(180deg);
  }

  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    z-index: 1000;
    border: none;
    cursor: default;
    -webkit-tap-highlight-color: transparent;
  }

  /* Mobile styles need :global because content is portaled to body */
  :global(.mobile-portal) {
    display: contents;
  }

  :global(.mobile-portal .backdrop.mobile) {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    border: none;
    cursor: pointer;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
  }

  .dropdown-panel {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 8px;
    width: 300px;
    max-height: 60vh;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 1001;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  :global(.mobile-portal .dropdown-panel.mobile) {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    left: 12px;
    right: 12px;
    bottom: auto;
    width: auto;
    max-height: calc(
      100vh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px
    );
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 20px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    z-index: 1001;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: slideDown 0.2s ease-out;
    overscroll-behavior: contain;
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .mobile-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    background: none;
    border: none;
    border-radius: 50%;
    color: var(--color-text);
    cursor: pointer;
  }

  .mobile-close-btn:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .search-container {
    padding: 0.75rem;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .search-container .search-input {
    flex: 1;
  }

  /* Match add button to other header buttons in desktop panel */
  .search-container :global(.add-trigger) {
    width: 2rem;
    height: 2rem;
    padding: 0;
  }

  .search-container.mobile {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .search-container.mobile .search-input {
    flex: 1;
  }

  .search-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font: inherit;
    font-size: 1rem; /* 16px prevents iOS auto-zoom */
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .search-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .items-container {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    margin-top: 0.25rem;
    background: none;
    border: none;
    text-align: left;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    cursor: default;
  }

  .section-header.clickable {
    cursor: pointer;
  }

  .section-header.clickable:hover {
    color: var(--color-text);
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .section-icon {
    width: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .section-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text);
    transition: background-color 0.1s;
  }

  .nav-item.section-child {
    padding-left: 2.5rem;
  }

  .nav-item:hover,
  .nav-item.highlighted {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .nav-item.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .item-icon {
    width: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .feed-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 2px;
    object-fit: contain;
    display: block;
  }

  .feed-icon-placeholder {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    background: var(--color-border);
    border-radius: 2px;
    display: block;
  }

  .item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-count {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .nav-item.active .item-count {
    color: var(--color-primary);
  }

  .no-results {
    padding: 1rem 0.75rem;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
  }

  @media (prefers-color-scheme: dark) {
    .nav-item:hover,
    .nav-item.highlighted {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }

    .section-header.clickable:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }

    .dropdown-panel {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
  }

  /* Global styles for mobile portal content */
  :global(.mobile-portal .search-container.mobile) {
    padding: 0.75rem;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  :global(.mobile-portal .search-input) {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font: inherit;
    font-size: 1rem;
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  :global(.mobile-portal .search-input:focus) {
    outline: none;
    border-color: var(--color-primary);
  }

  :global(.mobile-portal .mobile-close-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    background: none;
    border: none;
    border-radius: 50%;
    color: var(--color-text);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  :global(.mobile-portal .items-container) {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  :global(.mobile-portal .items-container::after) {
    content: '';
    display: block;
    height: calc(env(safe-area-inset-bottom, 0px) + 2rem);
  }

  :global(.mobile-portal .section-header) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    margin-top: 0.25rem;
    background: none;
    border: none;
    text-align: left;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    cursor: default;
    -webkit-tap-highlight-color: transparent;
  }

  :global(.mobile-portal .section-header.clickable) {
    cursor: pointer;
  }

  :global(.mobile-portal .section-header.clickable:hover) {
    color: var(--color-text);
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  :global(.mobile-portal .section-icon) {
    width: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  :global(.mobile-portal .section-label) {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.mobile-portal .nav-item) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text);
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  :global(.mobile-portal .nav-item.section-child) {
    padding-left: 2.5rem;
  }

  :global(.mobile-portal .nav-item.active) {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  :global(.mobile-portal .nav-item.highlighted) {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  :global(.mobile-portal .item-icon) {
    width: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  :global(.mobile-portal .feed-icon) {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 2px;
    object-fit: contain;
  }

  :global(.mobile-portal .feed-icon-placeholder) {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    background: var(--color-border);
    border-radius: 2px;
  }

  :global(.mobile-portal .item-label) {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.mobile-portal .item-count) {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  :global(.mobile-portal .nav-item.active .item-count) {
    color: var(--color-primary);
  }

  :global(.mobile-portal .no-results) {
    padding: 1rem 0.75rem;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
  }

  /* Match add button size to close button in mobile */
  :global(.mobile-portal .add-trigger) {
    width: 2.5rem;
    height: 2.5rem;
    padding: 0 !important;
  }

  :global(.mobile-portal .add-trigger :is(.icon, svg:first-child)) {
    width: 24px !important;
    height: 24px !important;
  }

  /* View more button */
  .view-more-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    padding: 0;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }

  .nav-item:hover .view-more-btn,
  .view-more-btn:focus {
    opacity: 1;
  }

  .view-more-btn:hover {
    color: var(--color-text);
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.1));
    border-radius: 4px;
  }

  @media (max-width: 1000px) {
    .view-more-btn {
      opacity: 1;
    }
  }

  :global(.mobile-portal .view-more-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    padding: 0;
    line-height: 1;
    opacity: 1;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }

  /* View rename input */
  .rename-row {
    cursor: default;
  }

  .view-rename-input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 0.875rem;
    padding: 0.125rem 0.25rem;
    border: 1px solid var(--color-primary);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
  }

  :global(.mobile-portal .view-rename-input) {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 1rem;
    padding: 0.125rem 0.25rem;
    border: 1px solid var(--color-primary);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
  }

  /* View context menu (portaled to body, needs :global) */
  :global(.view-menu-portal) {
    display: contents;
  }

  :global(.view-menu-portal .view-menu-backdrop) {
    position: fixed;
    inset: 0;
    z-index: 1100;
  }

  :global(.view-menu-portal .view-context-menu) {
    position: fixed;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.25rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 1101;
    min-width: 120px;
  }

  :global(.view-menu-portal .view-menu-item) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    font-size: 0.875rem;
    color: var(--color-text);
  }

  :global(.view-menu-portal .view-menu-item:hover) {
    background: var(--color-bg-secondary);
  }

  :global(.view-menu-portal .view-menu-item.danger) {
    color: var(--color-error, #dc2626);
  }

  :global(.view-menu-portal .view-menu-item.danger:hover) {
    background: rgba(220, 38, 38, 0.1);
  }

  :global(.view-menu-portal .view-menu-icon) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
  }

  @media (prefers-color-scheme: dark) {
    :global(.mobile-portal .nav-item.highlighted) {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }

    :global(.mobile-portal .backdrop.mobile) {
      background: rgba(0, 0, 0, 0.7);
    }

    :global(.mobile-portal .dropdown-panel.mobile) {
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }

    :global(.view-menu-portal .view-context-menu) {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
  }
</style>
