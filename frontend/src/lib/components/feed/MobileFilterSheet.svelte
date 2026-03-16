<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import AppearanceToolbar from './AppearanceToolbar.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { subscriptionSourceKey } from '$lib/utils/sourceKeys';
  import { goto } from '$app/navigation';
  import type { SubscriptionSourceType } from '$lib/types';

  const TYPE_OPTIONS: { value: SubscriptionSourceType; label: string }[] = [
    { value: 'rss', label: 'RSS Feeds' },
    { value: 'atproto.shares', label: 'Skyreader Shares' },
    { value: 'atproto.documents', label: 'Standard.site Documents' },
  ];

  interface Props {
    showSourceFilter: boolean;
    expandAllItems: boolean;
    onToggleExpandAll: (value: boolean) => void;
    isSavedView: boolean;
    onMarkAllAsRead?: () => void;
    onclose: () => void;
  }

  let {
    showSourceFilter,
    expandAllItems,
    onToggleExpandAll,
    isSavedView,
    onMarkAllAsRead,
    onclose,
  }: Props = $props();

  // Source filter state
  let ef = $derived(feedViewStore.effectiveFilters);
  let sourceKeySet = $derived(new Set(ef.sourceKeys));
  let sourcesExpanded = $state(false);
  let feedSearch = $state('');

  let filteredSubscriptions = $derived(
    feedSearch
      ? subscriptionsStore.subscriptions.filter((sub) => {
          const term = feedSearch.toLowerCase();
          return (
            (sub.customTitle || sub.title).toLowerCase().includes(term) ||
            (sub.feedUrl?.toLowerCase().includes(term) ?? false)
          );
        })
      : subscriptionsStore.subscriptions
  );

  function setSourceMode(mode: 'all' | 'include') {
    feedViewStore.setToolbarSourceFilter(mode, mode === 'all' ? [] : [...ef.sourceKeys]);
  }

  function toggleSourceKey(key: string) {
    const keys = sourceKeySet.has(key)
      ? ef.sourceKeys.filter((k) => k !== key)
      : [...ef.sourceKeys, key];
    feedViewStore.setToolbarSourceFilter(ef.sourceMode, keys);
  }

  // Type filter state
  let activeTypeFilter = $derived(feedViewStore.toolbarTypeFilter);
  let activeTypeSet = $derived(new Set(activeTypeFilter));

  function toggleTypeFilter(type: SubscriptionSourceType) {
    const newTypes = activeTypeSet.has(type)
      ? activeTypeFilter.filter((t) => t !== type)
      : [...activeTypeFilter, type];
    feedViewStore.setToolbarTypeFilter(newTypes);
  }

  // Tag filter state
  let allTags = $derived(itemLabelsStore.allTags);
  let activeTagFilter = $derived(feedViewStore.toolbarTagFilter);
  let activeTagSet = $derived(new Set(activeTagFilter));

  function toggleTagFilter(tag: string) {
    const newTags = activeTagSet.has(tag)
      ? activeTagFilter.filter((t) => t !== tag)
      : [...activeTagFilter, tag];
    feedViewStore.setToolbarTagFilter(newTags);
  }

  // Save view
  let isEditingView = $derived(!!feedViewStore.viewFilter);
  let isRenaming = $state(false);
  let renameValue = $state('');

  function startRename() {
    if (!feedViewStore.viewFilter) return;
    const id = parseInt(feedViewStore.viewFilter);
    const view = filteredViewsStore.getById(id);
    if (!view) return;
    renameValue = view.name;
    isRenaming = true;
    requestAnimationFrame(() => {
      const input = document.querySelector('.rename-input') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    });
  }

  async function commitRename() {
    if (!feedViewStore.viewFilter) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      isRenaming = false;
      return;
    }
    const id = parseInt(feedViewStore.viewFilter);
    const view = filteredViewsStore.getById(id);
    if (view && trimmed !== view.name) {
      await filteredViewsStore.update(id, { name: trimmed });
    }
    isRenaming = false;
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      isRenaming = false;
    }
  }

  async function handleDeleteView() {
    if (!feedViewStore.viewFilter) return;
    if (!confirm('Delete this view?')) return;
    const id = parseInt(feedViewStore.viewFilter);
    await filteredViewsStore.remove(id);
    onclose();
    goto('/');
  }

  async function handleSaveView() {
    if (isEditingView) {
      feedViewStore.syncToolbarToSavedView();
    } else {
      const id = await filteredViewsStore.create({
        name: 'new view',
        sourceMode: ef.sourceMode,
        sourceKeys: [...ef.sourceKeys],
        readFilter: feedViewStore.showOnlyUnread ? 'unread' : 'all',
        sortOrder: feedViewStore.currentSortOrder,
        tagFilter: activeTagFilter.length > 0 ? [...activeTagFilter] : undefined,
        typeFilter: activeTypeFilter.length > 0 ? [...activeTypeFilter] : undefined,
      });
      goto(`/?view=${id}`);
    }
    onclose();
  }

  let currentViewName = $derived.by(() => {
    if (!feedViewStore.viewFilter) return '';
    const id = parseInt(feedViewStore.viewFilter);
    return filteredViewsStore.getById(id)?.name || '';
  });

  let hasFilterChanges = $derived(
    isEditingView
      ? feedViewStore.hasUnsavedChanges
      : ef.sourceMode !== 'all' || activeTypeFilter.length > 0
  );
</script>

<div class="filter-sheet">
  {#if isSavedView}
    <div class="sheet-section">
      <div class="section-label">
        <Icon name="bookmark" size={12} />
        Saved
      </div>
      <div class="toggle-row">
        <button
          class="toggle-btn"
          class:active={feedViewStore.savedView === 'inbox'}
          onclick={() => feedViewStore.setSavedView('inbox')}
        >
          <Icon name="inbox" size={16} />
          Inbox
        </button>
        <button
          class="toggle-btn"
          class:active={feedViewStore.savedView === 'archive'}
          onclick={() => feedViewStore.setSavedView('archive')}
        >
          <Icon name="archive" size={16} />
          Archive
        </button>
        <button class="toggle-btn" onclick={() => feedViewStore.toggleSortOrder()}>
          <Icon
            name={feedViewStore.currentSortOrder === 'newest' ? 'arrow-down' : 'arrow-up'}
            size={16}
          />
          {feedViewStore.currentSortOrder === 'newest' ? 'Newest' : 'Oldest'}
        </button>
      </div>
    </div>
  {:else}
    <div class="sheet-section">
      <div class="section-label">View</div>
      <div class="toggle-row">
        <button
          class="toggle-btn"
          class:active={!expandAllItems}
          onclick={() => onToggleExpandAll(false)}
        >
          <Icon name="list" size={16} />
          List
        </button>
        <button
          class="toggle-btn"
          class:active={expandAllItems}
          onclick={() => onToggleExpandAll(true)}
        >
          <Icon name="newspaper" size={16} />
          Expanded
        </button>
      </div>
    </div>

    <div class="sheet-section">
      <div class="section-label">Appearance</div>
      <div class="toolbar-wrapper">
        <AppearanceToolbar />
      </div>
    </div>

    <div class="sheet-section">
      <div class="section-label">
        <Icon name="arrow-down" size={12} />
        Sort & Read
      </div>
      <div class="toggle-row">
        <button class="toggle-btn" onclick={() => feedViewStore.toggleSortOrder()}>
          <Icon
            name={feedViewStore.currentSortOrder === 'newest' ? 'arrow-down' : 'arrow-up'}
            size={16}
          />
          {feedViewStore.currentSortOrder === 'newest' ? 'Newest' : 'Oldest'}
        </button>
        <button
          class="toggle-btn"
          class:active={feedViewStore.showOnlyUnread}
          onclick={() => feedViewStore.setShowOnlyUnread(true)}
        >
          <Icon name="circle-dot" size={16} />
          Unread
        </button>
        <button
          class="toggle-btn"
          class:active={!feedViewStore.showOnlyUnread}
          onclick={() => feedViewStore.setShowOnlyUnread(false)}
        >
          <Icon name="inbox" size={16} />
          All
        </button>
      </div>
    </div>

    <div class="sheet-section">
      <div class="section-label">
        <Icon name="layers" size={12} />
        Type
      </div>
      <div class="filter-chips">
        {#each TYPE_OPTIONS as opt}
          <button
            class="chip"
            class:active={activeTypeSet.has(opt.value)}
            onclick={() => toggleTypeFilter(opt.value)}
          >
            <Icon
              name={opt.value === 'rss'
                ? 'rss'
                : opt.value === 'atproto.shares'
                  ? 'share'
                  : 'file-text'}
              size={14}
            />
            {opt.label}
          </button>
        {/each}
      </div>
    </div>

    {#if allTags.length > 0}
      <div class="sheet-section">
        <div class="section-label">
          <Icon name="tag" size={12} />
          Tags
        </div>
        <div class="filter-chips">
          {#each allTags as tag}
            <button
              class="chip"
              class:active={activeTagSet.has(tag)}
              onclick={() => toggleTagFilter(tag)}
            >
              <Icon name="tag" size={14} />
              {tag}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if showSourceFilter}
      <div class="sheet-section">
        <div class="section-label">
          <Icon name="filter" size={12} />
          Sources
        </div>
        <div class="source-filter">
          <div class="toggle-row">
            <button
              class="toggle-btn small"
              class:active={ef.sourceMode === 'all'}
              onclick={() => setSourceMode('all')}
            >
              All sources
            </button>
            <button
              class="toggle-btn small"
              class:active={ef.sourceMode === 'include'}
              onclick={() => setSourceMode('include')}
            >
              Include only
            </button>
          </div>

          {#if ef.sourceMode === 'include'}
            {#if subscriptionsStore.subscriptions.length > 0}
              {#if subscriptionsStore.subscriptions.length > 6}
                <input
                  type="text"
                  class="source-search"
                  placeholder="Search subscriptions..."
                  aria-label="Search subscriptions"
                  bind:value={feedSearch}
                />
              {/if}
              <div class="source-list">
                {#each filteredSubscriptions as sub}
                  {@const key = subscriptionSourceKey(sub)}
                  {#if key}
                    {@const isAtProto = sub.sourceType?.startsWith('atproto.') ?? false}
                    {@const iconUrl =
                      sub.customIconUrl ||
                      (isAtProto
                        ? sub.siteUrl
                          ? getFaviconUrl(sub.siteUrl)
                          : '/icons/icon-192.svg'
                        : getFaviconUrl(sub.siteUrl || sub.feedUrl || ''))}
                    <label class="source-item">
                      <input
                        type="checkbox"
                        checked={sourceKeySet.has(key)}
                        onchange={() => toggleSourceKey(key)}
                      />
                      {#if iconUrl}
                        <img src={iconUrl} alt="" class="source-icon" />
                      {/if}
                      <span class="source-name">{sub.customTitle || sub.title}</span>
                    </label>
                  {/if}
                {/each}
                {#if feedSearch && filteredSubscriptions.length === 0}
                  <div class="no-results">No subscriptions match</div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    {#if isEditingView}
      <div class="sheet-section">
        <div class="section-label">
          <Icon name="filter" size={12} />
          View
        </div>
        {#if isRenaming}
          <div class="rename-row">
            <input
              type="text"
              class="rename-input"
              bind:value={renameValue}
              onkeydown={handleRenameKeydown}
              onblur={commitRename}
            />
            <button class="rename-confirm-btn" onclick={commitRename}>
              <Icon name="check" size={16} />
            </button>
          </div>
        {:else}
          <div class="view-actions">
            <button class="view-name-btn" onclick={startRename}>
              <span class="view-name-text">{currentViewName}</span>
              <Icon name="edit" size={14} />
            </button>
            <button class="view-delete-btn" onclick={handleDeleteView}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        {/if}
        {#if hasFilterChanges}
          <button class="save-view-btn" onclick={handleSaveView}>
            <Icon name="save" size={16} />
            Update view
          </button>
        {/if}
      </div>
    {:else if hasFilterChanges}
      <div class="sheet-section">
        <button class="save-view-btn" onclick={handleSaveView}>
          <Icon name="save" size={16} />
          Save as view
        </button>
      </div>
    {/if}
  {/if}

  {#if onMarkAllAsRead}
    <div class="sheet-section">
      <button
        class="mark-all-btn"
        onclick={() => {
          onMarkAllAsRead?.();
          onclose();
        }}
      >
        <Icon name="check" size={16} />
        Mark all as read
      </button>
    </div>
  {/if}
</div>

<style>
  .filter-sheet {
    padding: 0.5rem 1rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .sheet-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sheet-section + .sheet-section {
    padding-top: 0.25rem;
    border-top: 1px solid var(--color-border);
  }

  .section-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-left: 0.25rem;
  }

  .toggle-row {
    display: flex;
    gap: 0.5rem;
  }

  .toggle-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.625rem;
    background: var(--color-bg-secondary, #f5f5f5);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.15s;
  }

  .toggle-btn.active {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .toggle-btn:active:not(.active) {
    background: var(--color-border);
  }

  .toolbar-wrapper {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  /* Override toolbar styles to not be pill-shaped in sheet context */
  .toolbar-wrapper :global(.appearance-toolbar) {
    background: none;
    box-shadow: none;
    backdrop-filter: none;
    padding: 0;
    border-radius: 0;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .toolbar-wrapper :global(.segment-btn) {
    padding: 0.6rem 0.75rem;
  }

  .toolbar-wrapper :global(.font-preview) {
    font-size: 1.125rem;
  }

  .toolbar-wrapper :global(.size-btn) {
    padding: 0.6rem;
  }

  .toolbar-wrapper :global(.size-btn .icon) {
    width: 18px;
    height: 18px;
  }

  .toolbar-wrapper :global(.size-label) {
    font-size: 0.9375rem;
    min-width: 1.75rem;
  }

  .toolbar-wrapper :global(.group-label) {
    display: block;
    font-size: 0.75rem;
  }

  .filter-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    background: var(--color-bg-secondary, #f5f5f5);
    border: 1px solid transparent;
    border-radius: 999px;
    color: var(--color-text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .chip.active {
    background: rgba(37, 99, 235, 0.08);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .chip:active:not(.active) {
    background: var(--color-border);
  }

  .source-filter {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .toggle-btn.small {
    font-size: 0.8125rem;
    padding: 0.5rem;
  }

  .source-search {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 1rem;
    outline: none;
  }

  .source-search:focus {
    border-color: var(--color-primary);
  }

  .source-search::placeholder {
    color: var(--color-text-secondary);
  }

  .source-list {
    display: flex;
    flex-direction: column;
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
  }

  .source-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    cursor: pointer;
    border-bottom: 1px solid var(--color-border);
  }

  .source-item:last-child {
    border-bottom: none;
  }

  .source-icon {
    width: 16px;
    height: 16px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .source-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .no-results {
    padding: 0.75rem;
    text-align: center;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .view-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .view-name-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    background: var(--color-bg-secondary, #f5f5f5);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-text);
    font-size: 0.875rem;
    font-weight: 500;
    text-align: left;
    min-width: 0;
  }

  .view-name-btn :global(.icon) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .view-name-btn:active {
    border-color: var(--color-primary);
  }

  .view-name-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .view-delete-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem;
    background: var(--color-bg-secondary, #f5f5f5);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .view-delete-btn:active {
    color: var(--color-error, #dc2626);
    border-color: var(--color-error, #dc2626);
    background: rgba(220, 38, 38, 0.08);
  }

  .rename-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .rename-input {
    flex: 1;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-primary);
    border-radius: 8px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 1rem;
    font-weight: 500;
    outline: none;
  }

  .rename-confirm-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem;
    background: var(--color-primary);
    border: none;
    border-radius: 8px;
    color: white;
    flex-shrink: 0;
  }

  .save-view-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.625rem;
    background: rgba(37, 99, 235, 0.08);
    border: 1px solid var(--color-primary);
    border-radius: 8px;
    color: var(--color-primary);
    font-size: 0.875rem;
    font-weight: 500;
    width: 100%;
  }

  .save-view-btn:active {
    background: rgba(37, 99, 235, 0.15);
  }

  .mark-all-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.75rem;
    background: var(--color-bg-secondary, #f5f5f5);
    border: none;
    border-radius: 8px;
    color: var(--color-text);
    font-size: 0.875rem;
    font-weight: 500;
    width: 100%;
  }

  .mark-all-btn:active {
    background: var(--color-border);
  }

  @media (prefers-color-scheme: dark) {
    .toggle-btn {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .toggle-btn.active {
      background: rgba(77, 166, 255, 0.15);
    }

    .toggle-btn:active:not(.active) {
      background: rgba(255, 255, 255, 0.1);
    }

    .chip {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .chip.active {
      background: rgba(37, 99, 235, 0.2);
    }

    .chip:active:not(.active) {
      background: rgba(255, 255, 255, 0.1);
    }

    .source-search {
      background: var(--color-bg, #1a1a1a);
    }

    .source-list {
      background: var(--color-bg, #1a1a1a);
    }

    .view-name-btn,
    .view-delete-btn {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .rename-input {
      background: var(--color-bg, #1a1a1a);
    }

    .save-view-btn {
      background: rgba(37, 99, 235, 0.15);
    }

    .save-view-btn:active {
      background: rgba(37, 99, 235, 0.25);
    }

    .mark-all-btn {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .mark-all-btn:active {
      background: rgba(255, 255, 255, 0.1);
    }
  }
</style>
