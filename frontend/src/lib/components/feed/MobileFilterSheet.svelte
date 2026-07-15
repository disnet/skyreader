<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import AppearanceToolbar from './AppearanceToolbar.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { subscriptionSourceKey } from '$lib/utils/sourceKeys';
  import { computeSourceKeys } from '$lib/utils/channelLogic';
  import { filterSubscriptionsBySearch, subscriptionIconUrl } from '$lib/utils/subscriptionDisplay';
  import DomainPatternInput from '$lib/components/DomainPatternInput.svelte';
  import type {
    ChannelAutoRule,
    SavedSourceType,
    SubscriptionSourceType,
    DateAddedPreset,
    ReadingLengthFilter,
    SortOrder,
  } from '$lib/types';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import {
    SAVED_SOURCE_OPTIONS,
    TYPE_OPTIONS,
    DATE_PRESET_OPTIONS_SHORT as DATE_PRESET_OPTIONS,
    READING_LENGTH_OPTIONS_SHORT as READING_LENGTH_OPTIONS,
    SAVED_SORT_OPTIONS_SHORT as SAVED_SORT_OPTIONS,
    AUTO_RULE_OPTIONS,
    AUTO_RULE_DEFAULT_NAMES as DEFAULT_NAMES,
    autoRuleToOption,
    type AutoRuleOption,
  } from '$lib/constants/channelOptions';

  interface Props {
    expandAllItems: boolean;
    onToggleExpandAll: (value: boolean) => void;
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

  // --- Tab state ---
  let activeTab = $state<'filters' | 'channel'>('filters');

  // Show channel tab when editing a channel or creating one
  let showChannelTab = $derived(editingChannelId != null || channelCreateMode);

  // Sync activeTab when initialTab prop changes
  $effect(() => {
    activeTab = initialTab;
  });

  // --- Channel editor state ---
  let chName = $state('');
  let chChannelType = $state<'feed' | 'saved'>('feed');
  let chMode = $state<'manual' | 'smart'>('manual');
  let chSavedSourceFilter = $state<Set<SavedSourceType>>(new Set());
  let chSavedDateFilter = $state<DateAddedPreset | ''>('');
  let chSavedReadingLength = $state<Set<ReadingLengthFilter>>(new Set());
  let chSavedDomainFilter = $state<Set<string>>(new Set());
  let chSavedTagFilter = $state<Set<string>>(new Set());
  let chSortOrder = $state<SortOrder>('newest');
  let chAutoRuleType = $state<AutoRuleOption>('frequency:high');
  let chRecentWithinDays = $state(14);
  let chCategoryValue = $state('');
  let chTagValue = $state('');
  let chDomainPatterns = $state<string[]>([]);
  let chSourceMode = $state<'all' | 'include' | 'exclude'>('all');
  let chSourceKeys = $state<Set<string>>(new Set());
  let chTypeFilter = $state<Set<SubscriptionSourceType>>(new Set());
  let chSaving = $state(false);
  let chError = $state<string | null>(null);
  let chNameManuallyEdited = $state(false);
  let chFeedSearch = $state('');

  let availableCategories = $derived(
    [
      ...new Set(
        subscriptionsStore.subscriptions
          .map((s) => s.category?.trim())
          .filter((c): c is string => !!c)
      ),
    ].sort()
  );

  let availableSubTags = $derived(
    [
      ...new Set(
        subscriptionsStore.subscriptions
          .flatMap((s) => s.tags.map((t) => t.trim().toLowerCase()))
          .filter(Boolean)
      ),
    ].sort()
  );

  let availableDomains = $derived(
    [
      ...new Set(
        subscriptionsStore.subscriptions
          .filter((s) => !s.sourceType || s.sourceType === 'rss')
          .flatMap((s) => {
            const urls = [s.feedUrl, s.siteUrl].filter(Boolean);
            return urls
              .map((u) => {
                try {
                  return new URL(u!).hostname;
                } catch {
                  return null;
                }
              })
              .filter((h): h is string => !!h);
          })
      ),
    ].sort()
  );

  let chCurrentAutoRule = $derived.by((): ChannelAutoRule | undefined => {
    if (chMode !== 'smart') return undefined;
    switch (chAutoRuleType) {
      case 'frequency:high':
        return { type: 'frequency', threshold: 'high' };
      case 'frequency:low':
        return { type: 'frequency', threshold: 'low' };
      case 'longReads':
        return { type: 'longReads', minLength: 5000 };
      case 'recent':
        return { type: 'recent', withinDays: chRecentWithinDays };
      case 'category':
        return chCategoryValue.trim()
          ? { type: 'category', value: chCategoryValue.trim() }
          : undefined;
      case 'subscriptionTag':
        return chTagValue.trim()
          ? { type: 'subscriptionTag', value: chTagValue.trim() }
          : undefined;
      case 'domain':
        return chDomainPatterns.length > 0
          ? { type: 'domain', patterns: chDomainPatterns }
          : undefined;
      case 'people':
        return { type: 'people' };
    }
  });

  let chMatchedSourceKeys = $derived.by(() => {
    if (!chCurrentAutoRule) return [];
    return computeSourceKeys(
      chCurrentAutoRule,
      subscriptionsStore.subscriptions,
      articlesStore.allArticles
    );
  });

  // Auto-fill name
  $effect(() => {
    if (chMode === 'smart' && !chNameManuallyEdited) {
      if (chAutoRuleType === 'category' && chCategoryValue.trim()) {
        chName = chCategoryValue.trim();
      } else if (chAutoRuleType === 'subscriptionTag' && chTagValue.trim()) {
        const t = chTagValue.trim();
        chName = t.charAt(0).toUpperCase() + t.slice(1);
      } else if (chAutoRuleType === 'domain' && chDomainPatterns.length > 0) {
        chName = chDomainPatterns[0];
      } else {
        chName = DEFAULT_NAMES[chAutoRuleType];
      }
    }
  });

  let chFilteredSubscriptions = $derived(
    filterSubscriptionsBySearch(subscriptionsStore.subscriptions, chFeedSearch)
  );

  // Reset channel editor when editingChannelId changes
  $effect(() => {
    if (editingChannelId != null) {
      const view = filteredViewsStore.getById(editingChannelId);
      if (view) {
        chName = view.name;
        chNameManuallyEdited = true;
        chChannelType = view.mode === 'saved' ? 'saved' : 'feed';
        chSavedSourceFilter = new Set(view.savedSourceFilter ?? []);
        chSavedDateFilter = view.savedDateFilter ?? '';
        chSavedReadingLength = new Set(view.savedReadingLength ?? []);
        chSavedDomainFilter = new Set(view.savedDomainFilter ?? []);
        chSavedTagFilter = new Set(view.tagFilter ?? []);
        chSortOrder = view.sortOrder;
        chTypeFilter = new Set(view.typeFilter ?? []);
        const isSmartChannel = !!view.autoRule;
        if (isSmartChannel) {
          chMode = 'smart';
          chAutoRuleType = autoRuleToOption(view.autoRule!);
          if (view.autoRule!.type === 'recent') chRecentWithinDays = view.autoRule!.withinDays;
          else if (view.autoRule!.type === 'category') chCategoryValue = view.autoRule!.value;
          else if (view.autoRule!.type === 'subscriptionTag') chTagValue = view.autoRule!.value;
          else if (view.autoRule!.type === 'domain')
            chDomainPatterns = [...view.autoRule!.patterns];
        } else {
          chMode = 'manual';
          const mode =
            view.sourceMode === 'include'
              ? 'include'
              : view.sourceMode === 'exclude'
                ? 'exclude'
                : 'all';
          chSourceMode = mode;
          chSourceKeys = mode === 'all' ? new Set() : new Set(view.sourceKeys ?? []);
        }
        chFeedSearch = '';
        chError = null;
        return;
      }
    }
    // New channel defaults
    if (channelCreateMode) {
      chName = '';
      chChannelType = initialChannelType ?? 'feed';
      chMode = 'manual';
      chAutoRuleType = 'frequency:high';
      chRecentWithinDays = 14;
      chCategoryValue = '';
      chTagValue = '';
      chDomainPatterns = [];
      chNameManuallyEdited = false;
      chSourceMode = 'all';
      chSourceKeys = new Set();
      chTypeFilter = new Set();
      chSavedSourceFilter = new Set();
      chSavedDateFilter = '';
      chSavedReadingLength = new Set();
      chSavedDomainFilter = new Set();
      chSavedTagFilter = new Set();
      chSortOrder = 'newest';
      chFeedSearch = '';
      chError = null;
    }
  });

  function toggleChSourceKey(key: string) {
    const next = new Set(chSourceKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    chSourceKeys = next;
  }

  function toggleChTypeFilter(type: SubscriptionSourceType) {
    const next = new Set(chTypeFilter);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    chTypeFilter = next;
  }

  async function handleChDelete() {
    if (editingChannelId == null) return;
    if (!confirm('Delete this channel?')) return;
    await filteredViewsStore.remove(editingChannelId);
    ondeleted?.();
    onclose();
  }

  async function handleChSave() {
    if (!chName.trim()) {
      chError = 'Name is required';
      return;
    }

    chError = null;
    chSaving = true;

    try {
      const isSmartMode = chMode === 'smart' && chCurrentAutoRule;

      const viewData =
        chChannelType === 'saved'
          ? {
              name: chName.trim(),
              mode: 'saved' as const,
              savedSourceFilter:
                chSavedSourceFilter.size > 0 ? Array.from(chSavedSourceFilter) : undefined,
              savedDateFilter: chSavedDateFilter || undefined,
              savedReadingLength:
                chSavedReadingLength.size > 0 ? Array.from(chSavedReadingLength) : undefined,
              savedDomainFilter:
                chSavedDomainFilter.size > 0 ? Array.from(chSavedDomainFilter) : undefined,
              tagFilter: chSavedTagFilter.size > 0 ? Array.from(chSavedTagFilter) : undefined,
              readFilter: 'unread' as const,
              sortOrder: chSortOrder,
            }
          : {
              name: chName.trim(),
              mode: 'feed' as const,
              sourceMode: isSmartMode ? ('include' as const) : chSourceMode,
              sourceKeys: isSmartMode ? chMatchedSourceKeys : Array.from(chSourceKeys),
              autoRule: isSmartMode ? chCurrentAutoRule : undefined,
              typeFilter:
                chMode === 'manual' && chSourceMode === 'include'
                  ? undefined
                  : chTypeFilter.size > 0
                    ? Array.from(chTypeFilter)
                    : undefined,
              readFilter: 'unread' as const,
              sortOrder: 'newest' as const,
            };

      if (editingChannelId != null) {
        await filteredViewsStore.update(editingChannelId, viewData);
      } else {
        const id = await filteredViewsStore.create(viewData);
        oncreated?.(id);
      }

      onclose();
    } catch (e) {
      chError = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      chSaving = false;
    }
  }
</script>

<div class="filter-sheet">
  {#if showChannelTab}
    <div class="tab-bar">
      <button
        class="tab"
        class:active={activeTab === 'filters'}
        onclick={() => (activeTab = 'filters')}
      >
        <Icon name="sliders" size={14} />
        Filters
      </button>
      <button
        class="tab"
        class:active={activeTab === 'channel'}
        onclick={() => (activeTab = 'channel')}
      >
        <Icon name="newspaper" size={14} />
        Channel
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
          {feedViewStore.myLinkblogFilter ? 'Sort' : 'Sort & Read'}
        </div>
        <div class="toggle-row">
          <button class="toggle-btn" onclick={() => feedViewStore.toggleSortOrder()}>
            <Icon
              name={feedViewStore.currentSortOrder === 'newest' ? 'arrow-down' : 'arrow-up'}
              size={16}
            />
            {feedViewStore.currentSortOrder === 'newest' ? 'Newest' : 'Oldest'}
          </button>
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
  {:else}
    <!-- ===== CHANNEL TAB ===== -->
    <div class="sheet-section">
      <div class="section-label">Name</div>
      <input
        type="text"
        class="ch-input"
        bind:value={chName}
        oninput={() => (chNameManuallyEdited = true)}
        placeholder="My channel"
      />
    </div>

    <div class="sheet-section">
      <div class="section-label">Channel Type</div>
      <div class="toggle-row">
        <button
          class="toggle-btn"
          class:active={chChannelType === 'feed'}
          onclick={() => (chChannelType = 'feed')}
        >
          Feed
        </button>
        <button
          class="toggle-btn"
          class:active={chChannelType === 'saved'}
          onclick={() => (chChannelType = 'saved')}
        >
          Saved
        </button>
      </div>
    </div>

    {#if chChannelType === 'saved'}
      <div class="sheet-section">
        <div class="section-label">Include Sources</div>
        <div class="source-list">
          {#each SAVED_SOURCE_OPTIONS as opt}
            <label class="source-item">
              <input
                type="checkbox"
                checked={chSavedSourceFilter.has(opt.value)}
                onchange={() => {
                  const next = new Set(chSavedSourceFilter);
                  if (next.has(opt.value)) {
                    next.delete(opt.value);
                  } else {
                    next.add(opt.value);
                  }
                  chSavedSourceFilter = next;
                }}
              />
              <span class="source-name">{opt.label}</span>
            </label>
          {/each}
        </div>
      </div>

      <!-- Date Added -->
      <div class="sheet-section">
        <div class="section-label">Date Added</div>
        <div class="toggle-row wrap">
          {#each DATE_PRESET_OPTIONS as opt}
            <button
              class="toggle-btn"
              class:active={chSavedDateFilter === opt.value}
              onclick={() => (chSavedDateFilter = opt.value as DateAddedPreset | '')}
            >
              {opt.label}
            </button>
          {/each}
        </div>
      </div>

      <!-- Reading Length -->
      <div class="sheet-section">
        <div class="section-label">Reading Length</div>
        <div class="toggle-row">
          {#each READING_LENGTH_OPTIONS as opt}
            <button
              class="toggle-btn"
              class:active={chSavedReadingLength.has(opt.value)}
              onclick={() => {
                const next = new Set(chSavedReadingLength);
                if (next.has(opt.value)) {
                  next.delete(opt.value);
                } else {
                  next.add(opt.value);
                }
                chSavedReadingLength = next;
              }}
            >
              {opt.label}
            </button>
          {/each}
        </div>
      </div>

      <!-- Domain -->
      {#if feedViewStore.availableSavedDomains.length > 0}
        <div class="sheet-section">
          <div class="section-label">Domains</div>
          <div class="toggle-row wrap">
            {#each feedViewStore.availableSavedDomains as domain}
              <button
                class="toggle-btn chip"
                class:active={chSavedDomainFilter.has(domain)}
                onclick={() => {
                  const next = new Set(chSavedDomainFilter);
                  if (next.has(domain)) {
                    next.delete(domain);
                  } else {
                    next.add(domain);
                  }
                  chSavedDomainFilter = next;
                }}
              >
                {domain}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Tags -->
      {#if itemLabelsStore.allTags.length > 0}
        <div class="sheet-section">
          <div class="section-label">Tags</div>
          <div class="toggle-row wrap">
            {#each itemLabelsStore.allTags as tag}
              <button
                class="toggle-btn chip"
                class:active={chSavedTagFilter.has(tag)}
                onclick={() => {
                  const next = new Set(chSavedTagFilter);
                  if (next.has(tag)) {
                    next.delete(tag);
                  } else {
                    next.add(tag);
                  }
                  chSavedTagFilter = next;
                }}
              >
                {tag}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Sort -->
      <div class="sheet-section">
        <div class="section-label">Sort Order</div>
        <div class="toggle-row wrap">
          {#each SAVED_SORT_OPTIONS as opt}
            <button
              class="toggle-btn"
              class:active={chSortOrder === opt.value}
              onclick={() => (chSortOrder = opt.value)}
            >
              {opt.label}
            </button>
          {/each}
        </div>
      </div>
    {:else}
      <div class="sheet-section">
        <div class="section-label">Source Selection</div>
        <div class="toggle-row">
          <button
            class="toggle-btn"
            class:active={chMode === 'manual'}
            onclick={() => (chMode = 'manual')}
          >
            Manual
          </button>
          <button
            class="toggle-btn"
            class:active={chMode === 'smart'}
            onclick={() => {
              chMode = 'smart';
              if (!chNameManuallyEdited) chName = DEFAULT_NAMES[chAutoRuleType];
            }}
          >
            Smart
          </button>
        </div>
      </div>

      {#if chMode === 'smart'}
        <div class="sheet-section">
          <div class="section-label">Rule</div>
          <div class="rule-cards">
            {#each AUTO_RULE_OPTIONS as opt (opt.value)}
              <button
                class="rule-card"
                class:selected={chAutoRuleType === opt.value}
                onclick={() => {
                  chAutoRuleType = opt.value;
                  if (!chNameManuallyEdited) chName = DEFAULT_NAMES[chAutoRuleType];
                }}
              >
                <span class="rule-card-label">{opt.label}</span>
                <span class="rule-card-desc">{opt.description}</span>
              </button>
            {/each}
          </div>
        </div>

        {#if chAutoRuleType === 'recent'}
          <div class="sheet-section">
            <div class="section-label">Within the last</div>
            <div class="inline-input">
              <input
                type="number"
                bind:value={chRecentWithinDays}
                min="1"
                max="90"
                class="days-input"
              />
              <span class="input-suffix">days</span>
            </div>
          </div>
        {:else if chAutoRuleType === 'category'}
          <div class="sheet-section">
            <div class="section-label">Category</div>
            <input
              type="text"
              list="ch-category-options"
              class="ch-input"
              bind:value={chCategoryValue}
              placeholder="e.g. Technology"
            />
            <datalist id="ch-category-options">
              {#each availableCategories as cat}
                <option value={cat}></option>
              {/each}
            </datalist>
          </div>
        {:else if chAutoRuleType === 'subscriptionTag'}
          <div class="sheet-section">
            <div class="section-label">Tag</div>
            <input
              type="text"
              list="ch-tag-options"
              class="ch-input"
              bind:value={chTagValue}
              placeholder="e.g. news"
            />
            <datalist id="ch-tag-options">
              {#each availableSubTags as tag}
                <option value={tag}></option>
              {/each}
            </datalist>
          </div>
        {:else if chAutoRuleType === 'domain'}
          <div class="sheet-section">
            <div class="section-label">Domain patterns</div>
            <DomainPatternInput
              patterns={chDomainPatterns}
              {availableDomains}
              onchange={(p) => (chDomainPatterns = p)}
              hint=""
            />
          </div>
        {/if}

        <div class="match-preview" class:empty={chMatchedSourceKeys.length === 0}>
          {#if chMatchedSourceKeys.length > 0}
            Matches <strong>{chMatchedSourceKeys.length}</strong>
            {chMatchedSourceKeys.length === 1 ? 'source' : 'sources'}
          {:else}
            No sources match this rule yet
          {/if}
        </div>
      {:else}
        <!-- Manual source picker -->
        <div class="sheet-section">
          <div class="section-label">Sources</div>
          <div class="toggle-row">
            <button
              class="toggle-btn small"
              class:active={chSourceMode === 'all'}
              onclick={() => (chSourceMode = 'all')}
            >
              All sources
            </button>
            <button
              class="toggle-btn small"
              class:active={chSourceMode === 'include'}
              onclick={() => (chSourceMode = 'include')}
            >
              Include only
            </button>
            <button
              class="toggle-btn small"
              class:active={chSourceMode === 'exclude'}
              onclick={() => (chSourceMode = 'exclude')}
            >
              Exclude only
            </button>
          </div>

          {#if chSourceMode !== 'all' && subscriptionsStore.subscriptions.length > 0}
            <p class="section-hint">
              {chSourceMode === 'exclude'
                ? 'Show everything except the sources you check.'
                : 'Show only the sources you check.'}
            </p>
            {#if subscriptionsStore.subscriptions.length > 6}
              <input
                type="text"
                class="source-search"
                placeholder="Search subscriptions..."
                aria-label="Search subscriptions"
                bind:value={chFeedSearch}
              />
            {/if}
            <div class="source-list">
              {#each chFilteredSubscriptions as sub}
                {@const key = subscriptionSourceKey(sub)}
                {#if key}
                  {@const iconUrl = subscriptionIconUrl(sub)}
                  <label class="source-item">
                    <input
                      type="checkbox"
                      checked={chSourceKeys.has(key)}
                      onchange={() => toggleChSourceKey(key)}
                    />
                    {#if iconUrl}
                      <img src={iconUrl} alt="" class="source-icon" />
                    {/if}
                    <span class="source-name">{sub.customTitle || sub.title}</span>
                  </label>
                {/if}
              {/each}
              {#if chFeedSearch && chFilteredSubscriptions.length === 0}
                <div class="no-results">No subscriptions match</div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if chChannelType === 'feed' && !(chMode === 'manual' && chSourceMode === 'include')}
        <div class="sheet-section">
          <div class="section-label">Content Types</div>
          <div class="source-list">
            {#each TYPE_OPTIONS as opt}
              <label class="source-item">
                <input
                  type="checkbox"
                  checked={chTypeFilter.has(opt.value)}
                  onchange={() => toggleChTypeFilter(opt.value)}
                />
                <span class="source-name">{opt.label}</span>
              </label>
            {/each}
          </div>
          <p class="section-hint">Leave all unchecked to show all types</p>
        </div>
      {/if}
    {/if}

    {#if chError}
      <p class="ch-error">{chError}</p>
    {/if}

    <div class="sheet-section ch-actions">
      <button class="save-btn" onclick={handleChSave} disabled={chSaving}>
        {#if chSaving}
          Saving...
        {:else if editingChannelId != null}
          Save Channel
        {:else}
          Create Channel
        {/if}
      </button>
      {#if editingChannelId != null}
        <button class="delete-btn" onclick={handleChDelete} disabled={chSaving}>
          Delete channel
        </button>
      {/if}
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

  .toggle-btn.small {
    font-size: var(--text-sm);
    padding: 0.5rem;
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

  .source-search {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-base);
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
    font-size: var(--text-md);
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
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .section-hint {
    margin: 0;
    padding-left: 0.25rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
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

  /* --- Channel tab styles --- */

  .ch-input {
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-base);
    outline: none;
  }

  .ch-input:focus {
    border-color: var(--color-primary);
  }

  .ch-input::placeholder {
    color: var(--color-text-secondary);
  }

  .rule-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .rule-card {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem 0.625rem;
    border: 1.5px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    background: var(--color-bg);
    text-align: left;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .rule-card:active {
    border-color: var(--color-text-secondary);
  }

  .rule-card.selected {
    border-color: var(--color-primary);
    background: rgba(0, 102, 204, 0.04);
  }

  .rule-card-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .rule-card-desc {
    font-size: var(--text-2xs);
    color: var(--color-text-secondary);
    line-height: var(--leading-tight);
  }

  .inline-input {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .days-input {
    width: 4rem;
    padding: 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: var(--text-base);
    background: var(--color-bg);
    color: var(--color-text);
    text-align: center;
    outline: none;
  }

  .days-input:focus {
    border-color: var(--color-primary);
  }

  .input-suffix {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .match-preview {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    background: rgba(0, 102, 204, 0.04);
    border: 1px solid rgba(0, 102, 204, 0.1);
  }

  .match-preview.empty {
    background: rgba(0, 0, 0, 0.02);
    border-color: var(--color-border);
    font-style: italic;
  }

  .ch-error {
    color: var(--color-error);
    font-size: var(--text-md);
    margin: 0;
  }

  .ch-actions {
    gap: 0.75rem;
  }

  .save-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.75rem;
    background: var(--color-primary);
    border: none;
    border-radius: 8px;
    color: white;
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    width: 100%;
  }

  .save-btn:active:not(:disabled) {
    opacity: 0.85;
  }

  .save-btn:disabled {
    opacity: 0.6;
  }

  .delete-btn {
    width: 100%;
    padding: 0.625rem;
    border: none;
    border-radius: 8px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .delete-btn:active:not(:disabled) {
    color: var(--color-error, #dc2626);
  }

  .delete-btn:disabled {
    opacity: 0.6;
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

    .source-search,
    .source-list,
    .ch-input,
    .days-input {
      background: var(--color-bg, #1a1a1a);
    }

    .mark-all-btn {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .mark-all-btn:active {
      background: rgba(255, 255, 255, 0.1);
    }

    .rule-card {
      background: var(--color-bg, #1a1a1a);
    }

    .rule-card.selected {
      background: rgba(0, 102, 204, 0.1);
    }

    .match-preview.empty {
      background: rgba(255, 255, 255, 0.03);
    }
  }
</style>
