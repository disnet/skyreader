<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import AppearanceToolbar from './AppearanceToolbar.svelte';
  import SourcePicker from './SourcePicker.svelte';
  import ChannelEditor, { type ChannelSeed } from './ChannelEditor.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import {
    DATE_PRESET_OPTIONS_SHORT as DATE_PRESET_OPTIONS,
    READING_LENGTH_OPTIONS_SHORT as READING_LENGTH_OPTIONS,
    SAVED_SORT_OPTIONS_SHORT as SAVED_SORT_OPTIONS,
    FOLLOWS_SORT_OPTIONS,
  } from '$lib/constants/channelOptions';

  interface Props {
    expandAllItems: boolean;
    /** Omitted on surfaces with no list/expanded choice — your own linkblog. */
    onToggleExpandAll?: (value: boolean) => void;
    isSavedView: boolean;
    onMarkAllAsRead?: () => void;
    onclose: () => void;
    // Channel editor props
    initialTab?: 'filters' | 'channel';
    editingChannelId?: number | null;
    channelCreateMode?: boolean;
    initialChannelType?: 'feed' | 'saved' | null;
    oncreated?: (uuid: string) => void;
    ondeleted?: () => void;
  }

  let {
    expandAllItems,
    onToggleExpandAll,
    isSavedView,
    onMarkAllAsRead,
    onclose,
    initialTab = 'filters',
    editingChannelId = undefined,
    channelCreateMode = false,
    initialChannelType = null,
    oncreated,
    ondeleted,
  }: Props = $props();

  // Your follows' links are a row like any other source, offered once you've
  // let Skyreader read your Following timeline (see SourcePicker).
  let showFollowsSource = $derived(
    !auth.isGuest && followLinksStore.loaded && !followLinksStore.scopeRequired
  );
  let followsInEverything = $derived(followLinksStore.inEverything === true);
  let followsSortOrder = $derived(
    feedViewStore.currentSortOrder === 'popular' || feedViewStore.currentSortOrder === 'oldest'
      ? feedViewStore.currentSortOrder
      : 'newest'
  );

  // --- Tab state ---
  let activeTab = $state<'filters' | 'channel'>('filters');

  // "Save as channel" from the View tab: a new channel starting from these sources.
  let saveAsSeed = $state<ChannelSeed | null>(null);

  // The two tabs only when the sheet opened on the view; opened to make or edit
  // a channel, it's just the channel editor.
  let showTabs = $derived(
    initialTab === 'filters' && (editingChannelId != null || saveAsSeed != null)
  );

  // Sync activeTab when initialTab prop changes
  $effect(() => {
    activeTab = initialTab;
  });

  function startSaveAsChannel() {
    const ef = feedViewStore.effectiveFilters;
    // The whole view, as the toolbar's Save keeps it.
    saveAsSeed = {
      sourceFilter: { sourceMode: ef.sourceMode, sourceKeys: [...ef.sourceKeys] },
      readFilter: feedViewStore.showOnlyUnread ? 'unread' : 'all',
      sortOrder: feedViewStore.currentSortOrder,
      tagFilter: [...feedViewStore.toolbarTagFilter],
    };
    activeTab = 'channel';
  }

  let canSaveAsChannel = $derived(
    editingChannelId == null &&
      !channelCreateMode &&
      feedViewStore.isEverythingView &&
      feedViewStore.effectiveFilters.sourceMode !== 'all'
  );
</script>

<div class="filter-sheet">
  {#if showTabs}
    <div class="tab-bar">
      <button
        class="tab"
        class:active={activeTab === 'filters'}
        onclick={() => (activeTab = 'filters')}
      >
        <Icon name="sliders" size={14} />
        View
      </button>
      <button
        class="tab"
        class:active={activeTab === 'channel'}
        onclick={() => (activeTab = 'channel')}
      >
        <Icon name="newspaper" size={14} />
        {editingChannelId != null ? 'Edit channel' : 'New channel'}
      </button>
    </div>
  {/if}

  {#if activeTab === 'filters'}
    <!-- ===== FILTERS TAB ===== -->
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
          {#if !feedViewStore.isSavedChannel}
            <button class="toggle-btn" onclick={() => feedViewStore.toggleSortOrder()}>
              <Icon
                name={feedViewStore.currentSortOrder === 'newest' ? 'arrow-down' : 'arrow-up'}
                size={16}
              />
              {feedViewStore.currentSortOrder === 'newest' ? 'Newest' : 'Oldest'}
            </button>
          {/if}
        </div>
      </div>

      {#if feedViewStore.isSavedChannel}
        <!-- Sort (saved channel: expanded options) -->
        <div class="sheet-section">
          <div class="section-label">
            <Icon name="arrow-down" size={12} />
            Sort
          </div>
          <div class="toggle-row wrap">
            {#each SAVED_SORT_OPTIONS as opt}
              <button
                class="toggle-btn"
                class:active={feedViewStore.currentSortOrder === opt.value}
                onclick={() => feedViewStore.setSortOrder(opt.value)}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        </div>

        <!-- Date Added -->
        <div class="sheet-section">
          <div class="section-label">
            <Icon name="clock" size={12} />
            Date Added
          </div>
          <div class="toggle-row wrap">
            {#each DATE_PRESET_OPTIONS as opt}
              <button
                class="toggle-btn"
                class:active={(feedViewStore.toolbarDateFilter ?? '') === opt.value}
                onclick={() => feedViewStore.setToolbarDateFilter(opt.value || null)}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        </div>

        <!-- Reading Length -->
        <div class="sheet-section">
          <div class="section-label">
            <Icon name="file-text" size={12} />
            Reading Length
          </div>
          <div class="toggle-row">
            {#each READING_LENGTH_OPTIONS as opt}
              <button
                class="toggle-btn"
                class:active={feedViewStore.toolbarReadingLength.includes(opt.value)}
                onclick={() => feedViewStore.toggleToolbarReadingLength(opt.value)}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        </div>

        <!-- Domain -->
        {#if feedViewStore.availableSavedDomains.length > 0}
          <div class="sheet-section">
            <div class="section-label">
              <Icon name="globe" size={12} />
              Domain
            </div>
            <div class="toggle-row wrap">
              {#each feedViewStore.availableSavedDomains as domain}
                <button
                  class="toggle-btn chip"
                  class:active={feedViewStore.toolbarDomainFilter.includes(domain)}
                  onclick={() => feedViewStore.toggleToolbarDomain(domain)}
                >
                  {domain}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    {:else}
      {#if onToggleExpandAll}
        <div class="sheet-section">
          <div class="section-label">Layout</div>
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
      {/if}

      <div class="sheet-section">
        <div class="section-label">Appearance</div>
        <div class="toolbar-wrapper">
          <AppearanceToolbar />
        </div>
      </div>

      <div class="sheet-section">
        <div class="section-label">
          <Icon name="arrow-down" size={12} />
          {feedViewStore.myLinkblogFilter ? 'Sort' : 'Sort & Read'}
        </div>
        {#if feedViewStore.canSortByPopularity}
          <div class="toggle-row sort-row">
            {#each FOLLOWS_SORT_OPTIONS as opt}
              <button
                class="toggle-btn"
                class:active={followsSortOrder === opt.value}
                onclick={() => feedViewStore.setSortOrder(opt.value)}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        {/if}
        <div class="toggle-row">
          {#if !feedViewStore.canSortByPopularity}
            <button class="toggle-btn" onclick={() => feedViewStore.toggleSortOrder()}>
              <Icon
                name={feedViewStore.currentSortOrder === 'oldest' ? 'arrow-up' : 'arrow-down'}
                size={16}
              />
              {feedViewStore.currentSortOrder === 'oldest' ? 'Oldest' : 'Newest'}
            </button>
          {/if}
          <!-- Your own linkblog always shows everything, so no read/unread toggle. -->
          {#if !feedViewStore.myLinkblogFilter}
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
          {/if}
        </div>
      </div>

      {#if feedViewStore.isEverythingView}
        <div class="sheet-section">
          <div class="section-label">
            <Icon name="filter" size={12} />
            Sources
          </div>
          <SourcePicker
            filter={{
              sourceMode: feedViewStore.effectiveFilters.sourceMode,
              sourceKeys: feedViewStore.effectiveFilters.sourceKeys,
            }}
            onchange={(f) => feedViewStore.setToolbarSourceFilter(f.sourceMode, f.sourceKeys)}
            showFollows={showFollowsSource}
            {followsInEverything}
          />
          {#if canSaveAsChannel}
            <button class="mark-all-btn" onclick={startSaveAsChannel}>
              <Icon name="plus" size={16} />
              Save as channel
            </button>
          {/if}
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
  {/if}

  {#if activeTab === 'channel' || showTabs}
    <!-- ===== CHANNEL TAB =====
         Kept mounted while the View tab is up, so a look at the view doesn't
         drop the edits in progress. -->
    <div class="channel-tab" hidden={activeTab !== 'channel'}>
      <ChannelEditor
        editingChannelId={saveAsSeed ? null : (editingChannelId ?? null)}
        initialChannelType={saveAsSeed ? 'feed' : initialChannelType}
        seed={saveAsSeed}
        pinActions
        onsaved={(created) => {
          if (created) oncreated?.(created);
          onclose();
        }}
        ondeleted={() => {
          ondeleted?.();
          onclose();
        }}
      />
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

  /* --- Tabs --- */

  .tab-bar {
    display: flex;
    gap: 0;
    background: var(--color-bg-secondary, #f5f5f5);
    border-radius: 8px;
    padding: 0.1875rem;
  }

  .tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.5rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    transition: all 0.15s;
  }

  .tab.active {
    background: var(--color-bg, #fff);
    color: var(--color-text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }

  /* --- Shared section styles --- */

  .sheet-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sheet-section + .sheet-section {
    padding-top: 0.25rem;
    border-top: 1px solid var(--color-border);
  }

  .tab-bar + .sheet-section {
    padding-top: 0;
    border-top: none;
  }

  .section-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    padding-left: 0.25rem;
  }

  .sort-row {
    margin-bottom: 0.5rem;
  }

  .toggle-row {
    display: flex;
    gap: 0.5rem;
  }

  .toggle-row.wrap {
    flex-wrap: wrap;
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
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
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

  .toggle-btn.chip {
    flex: 0 0 auto;
    font-size: var(--text-sm);
    padding: 0.375rem 0.75rem;
  }

  /* --- Filter tab styles --- */

  .toolbar-wrapper {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

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
    font-size: var(--text-xl);
  }

  .toolbar-wrapper :global(.size-btn) {
    padding: 0.6rem;
  }

  .toolbar-wrapper :global(.size-btn .icon) {
    width: 18px;
    height: 18px;
  }

  .toolbar-wrapper :global(.size-label) {
    font-size: var(--text-lg);
    min-width: 1.75rem;
  }

  .toolbar-wrapper :global(.group-label) {
    display: block;
    font-size: var(--text-xs);
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
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    width: 100%;
  }

  .mark-all-btn:active {
    background: var(--color-border);
  }

  /* --- Dark mode --- */

  @media (prefers-color-scheme: dark) {
    .tab-bar {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .tab.active {
      background: var(--color-bg, #1a1a1a);
    }

    .toggle-btn {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .toggle-btn.active {
      background: rgba(77, 166, 255, 0.15);
    }

    .toggle-btn:active:not(.active) {
      background: rgba(255, 255, 255, 0.1);
    }

    .mark-all-btn {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .mark-all-btn:active {
      background: rgba(255, 255, 255, 0.1);
    }
  }
</style>
