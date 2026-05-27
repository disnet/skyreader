<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import FilterPopover from './FilterPopover.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { goto } from '$app/navigation';
  import { subscriptionSourceKey } from '$lib/utils/sourceKeys';
  import { filterSubscriptionsBySearch, subscriptionIconUrl } from '$lib/utils/subscriptionDisplay';
  import {
    TYPE_OPTIONS,
    SAVED_SOURCE_OPTIONS,
    DATE_PRESET_OPTIONS,
    READING_LENGTH_OPTIONS,
    SAVED_SORT_OPTIONS,
  } from '$lib/constants/channelOptions';

  interface Props {
    showSourceFilter: boolean;
    onEditChannel?: (id: number) => void;
  }

  let { showSourceFilter, onEditChannel }: Props = $props();

  let ef = $derived(feedViewStore.effectiveFilters);
  let sourceKeySet = $derived(new Set(ef.sourceKeys));

  // Search state for filtering lists
  let feedSearch = $state('');
  let domainSearchText = $state('');

  // Clear search when source popover closes
  $effect(() => {
    if (!feedViewStore.sourcePopoverOpen) {
      feedSearch = '';
    }
  });

  let filteredSubscriptions = $derived(
    filterSubscriptionsBySearch(subscriptionsStore.subscriptions, feedSearch)
  );

  let activeTypeFilter = $derived(feedViewStore.toolbarTypeFilter);
  let activeTypeSet = $derived(new Set(activeTypeFilter));
  let typeFilterLabel = $derived(
    activeTypeFilter.length === 0 ? 'Type' : `Type (${activeTypeFilter.length})`
  );

  let isSavedChannel = $derived(feedViewStore.isSavedChannel);
  let activeSavedSourceFilter = $derived(feedViewStore.toolbarSavedSourceFilter);
  let activeSavedSourceSet = $derived(new Set(activeSavedSourceFilter));
  let savedSourceFilterLabel = $derived(
    activeSavedSourceFilter.length === 0 ? 'Source' : `Source (${activeSavedSourceFilter.length})`
  );

  let activeDateFilter = $derived(feedViewStore.toolbarDateFilter);
  let dateFilterLabel = $derived.by(() => {
    if (!activeDateFilter) return 'Date';
    return DATE_PRESET_OPTIONS.find((o) => o.value === activeDateFilter)?.label ?? 'Date';
  });

  let activeReadingLength = $derived(feedViewStore.toolbarReadingLength);
  let activeReadingLengthSet = $derived(new Set(activeReadingLength));
  let readingLengthLabel = $derived(
    activeReadingLength.length === 0 ? 'Length' : `Length (${activeReadingLength.length})`
  );

  let activeDomainFilter = $derived(feedViewStore.toolbarDomainFilter);
  let activeDomainSet = $derived(new Set(activeDomainFilter));
  let domainFilterLabel = $derived(
    activeDomainFilter.length === 0 ? 'Domain' : `Domain (${activeDomainFilter.length})`
  );
  let availableDomains = $derived(feedViewStore.availableSavedDomains);

  let savedSortLabel = $derived(
    SAVED_SORT_OPTIONS.find((o) => o.value === feedViewStore.currentSortOrder)?.label ?? 'Sort'
  );

  let hasSavedChannelFilters = $derived(
    activeSavedSourceFilter.length > 0 ||
      !!activeDateFilter ||
      activeReadingLength.length > 0 ||
      activeDomainFilter.length > 0
  );

  // Popover open states (local to this component)
  let typePopoverOpen = $state(false);
  let datePopoverOpen = $state(false);
  let lengthPopoverOpen = $state(false);
  let domainPopoverOpen = $state(false);
  let sortPopoverOpen = $state(false);
  let tagPopoverOpen = $state(false);

  // Clear domain search when domain popover closes
  $effect(() => {
    if (!domainPopoverOpen) domainSearchText = '';
  });

  let filteredDomains = $derived.by(() => {
    if (!domainSearchText) return availableDomains;
    const q = domainSearchText.toLowerCase();
    return availableDomains.filter((d) => d.toLowerCase().includes(q));
  });

  let allTags = $derived(itemLabelsStore.allTags);
  let activeTagFilter = $derived(feedViewStore.toolbarTagFilter);
  let activeTagSet = $derived(new Set(activeTagFilter));
  let tagFilterLabel = $derived(
    activeTagFilter.length === 0 ? 'Tags' : `Tags (${activeTagFilter.length})`
  );

  function setSourceMode(mode: 'all' | 'include') {
    feedViewStore.setToolbarSourceFilter(mode, mode === 'all' ? [] : [...ef.sourceKeys]);
  }

  // All possible source keys (deduplicated across all subscriptions)
  let allSourceKeys = $derived.by(() => {
    const keys = new Set<string>();
    for (const sub of subscriptionsStore.subscriptions) {
      const key = subscriptionSourceKey(sub);
      if (key) keys.add(key);
    }
    return [...keys];
  });

  let allSourcesSelected = $derived(
    allSourceKeys.length > 0 && allSourceKeys.every((k) => sourceKeySet.has(k))
  );

  function selectAllSources() {
    const newKeys = allSourceKeys.filter((k) => !sourceKeySet.has(k));
    if (newKeys.length > 0) {
      feedViewStore.setToolbarSourceFilter(ef.sourceMode, [...ef.sourceKeys, ...newKeys]);
    }
  }

  function deselectAllSources() {
    const allKeySet = new Set(allSourceKeys);
    const keys = ef.sourceKeys.filter((k) => !allKeySet.has(k));
    feedViewStore.setToolbarSourceFilter(ef.sourceMode, keys);
  }

  let sourceFilterLabel = $derived(
    ef.sourceMode === 'all' ? 'Sources' : `Sources (${ef.sourceKeys.length})`
  );

  // Save view state
  let showNameInput = $state(false);
  let newViewName = $state('');
  let nameInputRef = $state<HTMLInputElement | null>(null);
  let saving = $state(false);

  let isEditingView = $derived(!!feedViewStore.viewFilter);

  // Rename view state
  let showRenameInput = $state(false);
  let renameViewName = $state('');
  let renameInputRef = $state<HTMLInputElement | null>(null);

  function startRenameView() {
    if (!feedViewStore.viewFilter) return;
    const id = parseInt(feedViewStore.viewFilter);
    const view = filteredViewsStore.getById(id);
    if (!view) return;
    renameViewName = view.name;
    showRenameInput = true;
    requestAnimationFrame(() => {
      renameInputRef?.focus();
      renameInputRef?.select();
    });
  }

  async function commitRenameView() {
    if (!feedViewStore.viewFilter) return;
    const trimmed = renameViewName.trim();
    if (!trimmed) {
      showRenameInput = false;
      return;
    }
    const id = parseInt(feedViewStore.viewFilter);
    const view = filteredViewsStore.getById(id);
    if (view && trimmed !== view.name) {
      await filteredViewsStore.update(id, { name: trimmed });
    }
    showRenameInput = false;
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRenameView();
    } else if (e.key === 'Escape') {
      showRenameInput = false;
    }
  }

  async function handleDeleteView() {
    if (!feedViewStore.viewFilter) return;
    if (!confirm('Are you sure you want to delete this channel?')) return;
    const id = parseInt(feedViewStore.viewFilter);
    await filteredViewsStore.remove(id);
    goto('/');
  }

  async function handleSave() {
    if (isEditingView) {
      feedViewStore.syncToolbarToSavedView();
    } else {
      showNameInput = true;
      newViewName = '';
      requestAnimationFrame(() => nameInputRef?.focus());
    }
  }

  async function handleCreateView() {
    const name = newViewName.trim();
    if (!name || saving) return;

    saving = true;
    try {
      const id = await filteredViewsStore.create({
        name,
        sourceMode: ef.sourceMode,
        sourceKeys: [...ef.sourceKeys],
        readFilter: feedViewStore.showOnlyUnread ? 'unread' : 'all',
        sortOrder: feedViewStore.currentSortOrder,
        tagFilter: activeTagFilter.length > 0 ? [...activeTagFilter] : undefined,
        typeFilter: activeTypeFilter.length > 0 ? [...activeTypeFilter] : undefined,
      });
      showNameInput = false;
      newViewName = '';
      goto(`/?view=${id}`);
    } finally {
      saving = false;
    }
  }

  function handleNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateView();
    } else if (e.key === 'Escape') {
      showNameInput = false;
      newViewName = '';
    }
  }
</script>

<div class="filter-toolbar" role="toolbar" aria-label="Filter controls">
  <!-- Group 1: Sort + Read state -->
  <div class="filter-group">
    {#if isSavedChannel}
      <FilterPopover
        iconName="arrow-down"
        label={savedSortLabel}
        title="Sort order"
        open={sortPopoverOpen}
        onOpenChange={(v) => (sortPopoverOpen = v)}
      >
        <div class="popover-list">
          {#each SAVED_SORT_OPTIONS as opt}
            <button
              class="popover-option"
              class:active={feedViewStore.currentSortOrder === opt.value}
              onclick={() => {
                feedViewStore.setSortOrder(opt.value);
                sortPopoverOpen = false;
              }}
            >
              {opt.label}
            </button>
          {/each}
        </div>
      </FilterPopover>
    {:else}
      <button
        class="filter-btn"
        onclick={() => feedViewStore.toggleSortOrder()}
        title={feedViewStore.currentSortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
      >
        <Icon
          name={feedViewStore.currentSortOrder === 'newest' ? 'arrow-down' : 'arrow-up'}
          size={16}
        />
        <span class="filter-label"
          >{feedViewStore.currentSortOrder === 'newest' ? 'New' : 'Old'}</span
        >
      </button>
    {/if}

    <span class="toolbar-divider"></span>

    <div class="segment-group" role="group" aria-label="Read filter">
      <button
        class="segment-btn"
        class:active={feedViewStore.showOnlyUnread}
        onclick={() => feedViewStore.setShowOnlyUnread(true)}
        title="Unread"
      >
        <Icon name="circle-dot" size={16} />
        <span class="segment-label">Unread</span>
      </button>
      <button
        class="segment-btn"
        class:active={!feedViewStore.showOnlyUnread}
        onclick={() => feedViewStore.setShowOnlyUnread(false)}
        title="All"
      >
        <Icon name="inbox" size={16} />
        <span class="segment-label">All</span>
      </button>
    </div>
  </div>

  {#if isEditingView && onEditChannel}
    <span class="toolbar-divider group-divider"></span>

    <div class="filter-group">
      <button
        class="filter-btn edit-channel-btn"
        onclick={() => {
          const id = feedViewStore.activeFilteredView?.id;
          if (id != null) onEditChannel(id);
        }}
        title="Edit channel"
      >
        <Icon name="edit" size={16} />
        <span class="filter-label">Edit Channel</span>
      </button>
    </div>
  {:else}
    {#if isSavedChannel}
      <span class="toolbar-divider group-divider"></span>

      <!-- Saved source filter (for saved-mode channels) -->
      <div class="filter-group">
        <FilterPopover
          iconName="layers"
          label={savedSourceFilterLabel}
          hasFilter={activeSavedSourceFilter.length > 0}
          open={typePopoverOpen}
          onOpenChange={(v) => (typePopoverOpen = v)}
        >
          <div class="popover-group-header">
            <span>Save Sources</span>
            {#if activeSavedSourceFilter.length > 0}
              <button class="select-all-btn" onclick={() => feedViewStore.clearToolbarSavedSource()}
                >Clear</button
              >
            {/if}
          </div>
          <div class="popover-list">
            {#each SAVED_SOURCE_OPTIONS as opt}
              <label class="check-label">
                <input
                  type="checkbox"
                  checked={activeSavedSourceSet.has(opt.value)}
                  onchange={() => feedViewStore.toggleToolbarSavedSource(opt.value)}
                />
                <span class="check-text">{opt.label}</span>
              </label>
            {/each}
          </div>
        </FilterPopover>
      </div>

      <!-- Date filter -->
      <div class="filter-group">
        <FilterPopover
          iconName="clock"
          label={dateFilterLabel}
          hasFilter={!!activeDateFilter}
          open={datePopoverOpen}
          onOpenChange={(v) => (datePopoverOpen = v)}
        >
          <div class="popover-list">
            {#each DATE_PRESET_OPTIONS as opt}
              <button
                class="popover-option"
                class:active={(activeDateFilter ?? '') === opt.value}
                onclick={() => {
                  feedViewStore.setToolbarDateFilter(opt.value || null);
                  datePopoverOpen = false;
                }}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        </FilterPopover>
      </div>

      <!-- Reading length filter -->
      <div class="filter-group">
        <FilterPopover
          iconName="file-text"
          label={readingLengthLabel}
          hasFilter={activeReadingLength.length > 0}
          open={lengthPopoverOpen}
          onOpenChange={(v) => (lengthPopoverOpen = v)}
        >
          <div class="popover-group-header">
            <span>Reading Length</span>
            {#if activeReadingLength.length > 0}
              <button
                class="select-all-btn"
                onclick={() => feedViewStore.clearToolbarReadingLength()}>Clear</button
              >
            {/if}
          </div>
          <div class="popover-list">
            {#each READING_LENGTH_OPTIONS as opt}
              <label class="check-label">
                <input
                  type="checkbox"
                  checked={activeReadingLengthSet.has(opt.value)}
                  onchange={() => feedViewStore.toggleToolbarReadingLength(opt.value)}
                />
                <span class="check-text">{opt.label}</span>
              </label>
            {/each}
          </div>
        </FilterPopover>
      </div>

      <!-- Domain filter -->
      {#if availableDomains.length > 0}
        <div class="filter-group">
          <FilterPopover
            iconName="globe"
            label={domainFilterLabel}
            hasFilter={activeDomainFilter.length > 0}
            open={domainPopoverOpen}
            onOpenChange={(v) => (domainPopoverOpen = v)}
          >
            <div class="popover-group-header">
              <span>Domains</span>
              {#if activeDomainFilter.length > 0}
                <button class="select-all-btn" onclick={() => feedViewStore.clearToolbarDomain()}
                  >Clear</button
                >
              {/if}
            </div>
            <div class="popover-search">
              <input
                type="text"
                placeholder="Search domains..."
                bind:value={domainSearchText}
                class="search-input"
              />
            </div>
            <div class="popover-list">
              {#each filteredDomains as domain}
                <label class="check-label">
                  <input
                    type="checkbox"
                    checked={activeDomainSet.has(domain)}
                    onchange={() => feedViewStore.toggleToolbarDomain(domain)}
                  />
                  <span class="check-text">{domain}</span>
                </label>
              {/each}
              {#if domainSearchText && filteredDomains.length === 0}
                <div class="no-results">No domains match</div>
              {/if}
            </div>
          </FilterPopover>
        </div>
      {/if}
    {:else if showSourceFilter}
      <span class="toolbar-divider group-divider"></span>

      <!-- Sources dropdown -->
      <div class="filter-group">
        <FilterPopover
          iconName="filter"
          label={sourceFilterLabel}
          hasFilter={ef.sourceMode !== 'all'}
          buttonClass="source-btn"
          open={feedViewStore.sourcePopoverOpen}
          onOpenChange={(v) => feedViewStore.setSourcePopoverOpen(v)}
        >
          <div class="popover-section">
            <label class="radio-label">
              <input
                type="radio"
                name="sourceMode"
                value="all"
                checked={ef.sourceMode === 'all'}
                onchange={() => setSourceMode('all')}
              />
              All sources
            </label>
            <label class="radio-label">
              <input
                type="radio"
                name="sourceMode"
                value="include"
                checked={ef.sourceMode === 'include'}
                onchange={() => setSourceMode('include')}
              />
              Include only
            </label>
          </div>

          {#if ef.sourceMode === 'include'}
            {#if subscriptionsStore.subscriptions.length > 0}
              <div class="popover-group-header">
                <span>Subscriptions</span>
                <button
                  class="select-all-btn"
                  onclick={allSourcesSelected ? deselectAllSources : selectAllSources}
                >
                  {allSourcesSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div class="popover-search">
                <input
                  type="text"
                  placeholder="Search subscriptions..."
                  bind:value={feedSearch}
                  class="search-input"
                />
              </div>
              <div class="popover-list">
                {#each filteredSubscriptions as sub}
                  {@const key = subscriptionSourceKey(sub)}
                  {#if key}
                    {@const iconUrl = subscriptionIconUrl(sub)}
                    <label class="check-label">
                      <input
                        type="checkbox"
                        checked={sourceKeySet.has(key)}
                        onchange={() => feedViewStore.toggleToolbarSourceKey(key)}
                      />
                      {#if iconUrl}
                        <img src={iconUrl} alt="" class="check-icon" />
                      {/if}
                      <span class="check-text">{sub.customTitle || sub.title}</span>
                    </label>
                  {/if}
                {/each}
                {#if feedSearch && filteredSubscriptions.length === 0}
                  <div class="no-results">No subscriptions match</div>
                {/if}
              </div>
            {/if}
          {/if}
        </FilterPopover>
      </div>
    {/if}

    {#if !isSavedChannel}
      <span class="toolbar-divider group-divider"></span>

      <!-- Type filter dropdown -->
      <div class="filter-group">
        <FilterPopover
          iconName="layers"
          label={typeFilterLabel}
          hasFilter={activeTypeFilter.length > 0}
          open={typePopoverOpen}
          onOpenChange={(v) => (typePopoverOpen = v)}
        >
          <div class="popover-group-header">
            <span>Types</span>
            {#if activeTypeFilter.length > 0}
              <button class="select-all-btn" onclick={() => feedViewStore.clearToolbarType()}
                >Clear</button
              >
            {/if}
          </div>
          <div class="popover-list">
            {#each TYPE_OPTIONS as opt}
              <label class="check-label">
                <input
                  type="checkbox"
                  checked={activeTypeSet.has(opt.value)}
                  onchange={() => feedViewStore.toggleToolbarType(opt.value)}
                />
                <span class="check-text">{opt.label}</span>
              </label>
            {/each}
          </div>
        </FilterPopover>
      </div>
    {/if}

    {#if allTags.length > 0}
      <span class="toolbar-divider group-divider"></span>

      <!-- Tags dropdown -->
      <div class="filter-group">
        <FilterPopover
          iconName="tag"
          label={tagFilterLabel}
          hasFilter={activeTagFilter.length > 0}
          open={tagPopoverOpen}
          onOpenChange={(v) => (tagPopoverOpen = v)}
        >
          <div class="popover-group-header">
            <span>Tags</span>
            {#if activeTagFilter.length > 0}
              <button class="select-all-btn" onclick={() => feedViewStore.clearToolbarTag()}
                >Clear</button
              >
            {/if}
          </div>
          <div class="popover-list">
            {#each allTags as tag}
              <label class="check-label">
                <input
                  type="checkbox"
                  checked={activeTagSet.has(tag)}
                  onchange={() => feedViewStore.toggleToolbarTag(tag)}
                />
                <span class="check-text">{tag}</span>
              </label>
            {/each}
          </div>
        </FilterPopover>
      </div>
    {/if}

    <span class="toolbar-divider group-divider"></span>

    <!-- Save button -->
    <div class="filter-group">
      {#if showNameInput}
        <div class="save-name-input">
          <input
            type="text"
            bind:this={nameInputRef}
            bind:value={newViewName}
            placeholder="View name..."
            onkeydown={handleNameKeydown}
            class="name-input"
          />
          <button
            class="filter-btn save-confirm-btn"
            onclick={handleCreateView}
            disabled={!newViewName.trim() || saving}
            title="Create view"
          >
            <Icon name="check" size={16} />
          </button>
        </div>
      {:else if showRenameInput}
        <div class="save-name-input">
          <input
            bind:this={renameInputRef}
            bind:value={renameViewName}
            class="name-input"
            placeholder="View name"
            onkeydown={handleRenameKeydown}
            onblur={commitRenameView}
          />
          <button
            class="filter-btn save-confirm-btn"
            onclick={commitRenameView}
            disabled={!renameViewName.trim()}
            title="Confirm rename"
          >
            <Icon name="check" size={16} />
          </button>
        </div>
      {:else}
        <button
          class="filter-btn save-btn"
          class:has-changes={isEditingView
            ? feedViewStore.hasUnsavedChanges
            : isSavedChannel
              ? hasSavedChannelFilters
              : ef.sourceMode !== 'all' || activeTypeFilter.length > 0}
          onclick={handleSave}
          disabled={isEditingView
            ? !feedViewStore.hasUnsavedChanges
            : isSavedChannel
              ? !hasSavedChannelFilters
              : ef.sourceMode === 'all' && activeTypeFilter.length === 0}
          title={isEditingView ? 'Update channel' : 'Save as new channel'}
        >
          <Icon name="save" size={16} />
          <span class="filter-label">{isEditingView ? 'Update' : 'Save'}</span>
        </button>
        {#if isEditingView}
          <button class="filter-btn rename-btn" onclick={startRenameView} title="Rename channel">
            <Icon name="edit" size={16} />
          </button>
          <button class="filter-btn delete-btn" onclick={handleDeleteView} title="Delete channel">
            <Icon name="trash" size={16} />
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .filter-toolbar {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.25rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    pointer-events: auto;
  }

  .filter-group {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .toolbar-divider {
    width: 1px;
    height: 1rem;
    background: var(--color-border, #e0e0e0);
    margin: 0 0.25rem;
    opacity: 0.5;
  }

  /* Direct filter-btn instances in this component (sort toggle, edit/save/rename/delete). */
  .filter-btn {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: none;
    padding: 0.4rem 0.6rem;
    border-radius: 999px;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .filter-btn:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .filter-label {
    white-space: nowrap;
  }

  /* Segment group (Unread / All) */
  .segment-group {
    display: flex;
    gap: 1px;
    border-radius: 999px;
    overflow: hidden;
  }

  .segment-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: none;
    border: none;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: 999px;
    transition: all 0.2s ease;
  }

  .segment-btn.active {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .segment-btn:hover:not(.active) {
    color: var(--color-text);
  }

  /* Hide chevron on the source filter button at narrower widths to save space. */
  :global(.source-btn .icon:last-child) {
    /* default visible */
  }

  @media (max-width: 900px) {
    :global(.source-btn .icon:last-child) {
      display: none;
    }
  }

  /* Popover content (rendered inside FilterPopover snippets, so styled in caller scope). */
  .popover-section {
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border-bottom: 1px solid var(--color-border);
  }

  .popover-group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.375rem 0.5rem 0.125rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-top: 1px solid var(--color-border);
  }

  .select-all-btn {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.625rem;
    font-weight: 500;
    color: var(--color-primary, #2563eb);
    cursor: pointer;
    text-transform: none;
    letter-spacing: normal;
  }

  .select-all-btn:hover {
    text-decoration: underline;
  }

  .radio-label,
  .check-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.375rem;
    font-size: 0.8125rem;
    cursor: pointer;
    border-radius: 4px;
  }

  .radio-label:hover,
  .check-label:hover {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .check-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 2px;
  }

  .popover-search {
    padding: 0.375rem 0.5rem;
  }

  .search-input {
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 4px;
    font-size: 0.75rem;
    background: var(--color-bg, #fff);
    color: var(--color-text);
    outline: none;
    box-sizing: border-box;
  }

  .search-input:focus {
    border-color: var(--color-primary, #2563eb);
  }

  .search-input::placeholder {
    color: var(--color-text-secondary, #999);
  }

  .no-results {
    padding: 0.375rem 0.5rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary, #999);
    text-align: center;
  }

  .popover-list {
    max-height: 200px;
    overflow-y: auto;
    padding: 0.375rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  /* Save button states */
  .save-btn {
    color: var(--color-text-secondary);
  }

  .save-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .save-btn:disabled:hover {
    background: none;
    color: var(--color-text-secondary);
  }

  .save-btn.has-changes {
    color: var(--color-primary, #2563eb);
  }

  .save-btn.has-changes:hover {
    background: rgba(37, 99, 235, 0.08);
    color: var(--color-primary, #2563eb);
  }

  .save-btn:not(:disabled):not(.has-changes):hover {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .rename-btn {
    color: var(--color-text-secondary);
  }

  .rename-btn:hover {
    color: var(--color-primary, #2563eb);
    background: rgba(37, 99, 235, 0.08);
  }

  .delete-btn {
    color: var(--color-text-secondary);
  }

  .delete-btn:hover {
    color: #dc2626;
    background: rgba(220, 38, 38, 0.08);
  }

  .save-name-input {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .name-input {
    width: 120px;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--color-primary, #2563eb);
    border-radius: 999px;
    font-size: 0.8125rem;
    background: var(--color-bg, #fff);
    color: var(--color-text);
    outline: none;
  }

  .name-input::placeholder {
    color: var(--color-text-secondary, #999);
  }

  .save-confirm-btn {
    color: var(--color-primary, #2563eb);
  }

  .save-confirm-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @media (max-width: 900px) {
    .filter-label {
      display: none;
    }
    .filter-btn,
    .segment-btn {
      padding: 0.4rem;
    }
  }

  @media (max-width: 640px) {
    .segment-label {
      display: none;
    }
    .filter-btn,
    .segment-btn {
      padding: 0.4rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .filter-toolbar {
      background: rgba(40, 40, 40, 0.95);
    }

    .toolbar-divider {
      background: rgba(255, 255, 255, 0.2);
    }

    .segment-btn.active {
      background: rgba(255, 255, 255, 0.15);
    }

    .filter-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .name-input {
      background: var(--color-bg, #1a1a1a);
    }
  }

  .popover-option {
    display: block;
    width: 100%;
    padding: 0.375rem 0.625rem;
    border: none;
    background: none;
    color: var(--color-text-primary, #e0e0e0);
    font-size: 0.8125rem;
    text-align: left;
    border-radius: 0.25rem;
    cursor: pointer;
  }
  .popover-option:hover {
    background: var(--color-bg-hover, rgba(255, 255, 255, 0.08));
  }
  .popover-option.active {
    background: var(--color-primary, #6366f1);
    color: #fff;
  }
</style>
