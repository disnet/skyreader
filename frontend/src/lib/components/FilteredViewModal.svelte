<script lang="ts">
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import Modal from '$lib/components/common/Modal.svelte';
  import type {
    SubscriptionSourceType,
    ChannelAutoRule,
    SavedSourceType,
    DateAddedPreset,
    ReadingLengthFilter,
    SortOrder,
  } from '$lib/types';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { subscriptionSourceKey } from '$lib/utils/sourceKeys';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { computeSourceKeys } from '$lib/utils/channelLogic';
  import DomainPatternInput from '$lib/components/DomainPatternInput.svelte';
  import {
    TYPE_OPTIONS,
    SAVED_SOURCE_OPTIONS,
    AUTO_RULE_OPTIONS,
    AUTO_RULE_DEFAULT_NAMES as DEFAULT_NAMES,
    autoRuleToOption,
    type AutoRuleOption,
  } from '$lib/constants/channelOptions';

  interface Props {
    open: boolean;
    editingViewId: number | null;
    initialChannelType?: 'feed' | 'saved' | null;
    onclose: () => void;
    oncreated?: (uuid: string) => void;
    ondeleted?: () => void;
  }

  let {
    open,
    editingViewId,
    initialChannelType = null,
    onclose,
    oncreated,
    ondeleted,
  }: Props = $props();

  // Form state
  let name = $state('');
  let channelType = $state<'feed' | 'saved'>('feed');
  let channelMode = $state<'manual' | 'smart'>('manual');
  let savedSourceFilter = $state<Set<SavedSourceType>>(new Set());
  let autoRuleType = $state<AutoRuleOption>('frequency:high');
  let recentWithinDays = $state(14);
  let categoryValue = $state('');
  let tagValue = $state('');
  let domainPatterns = $state<string[]>([]);
  let sourceMode = $state<'all' | 'include'>('all');
  let sourceKeys = $state<Set<string>>(new Set());
  let readFilter = $state<'all' | 'unread' | 'read'>('all');
  let sortOrder = $state<SortOrder>('newest');
  let savedDateFilter = $state<DateAddedPreset | ''>('');
  let savedReadingLength = $state<Set<ReadingLengthFilter>>(new Set());
  let savedDomainFilter = $state<Set<string>>(new Set());
  let savedTagFilter = $state<Set<string>>(new Set());
  let typeFilter = $state<Set<SubscriptionSourceType>>(new Set());
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Search state for filtering source lists
  let feedSearch = $state('');

  // Track whether user has manually edited the name
  let nameManuallyEdited = $state(false);

  // Available categories and tags from subscriptions (for dropdowns)
  let availableCategories = $derived(
    [
      ...new Set(
        subscriptionsStore.subscriptions
          .map((s) => s.category?.trim())
          .filter((c): c is string => !!c)
      ),
    ].sort()
  );

  let availableTags = $derived(
    [
      ...new Set(
        subscriptionsStore.subscriptions
          .flatMap((s) => s.tags.map((t) => t.trim().toLowerCase()))
          .filter(Boolean)
      ),
    ].sort()
  );

  // Unique hostnames from RSS subscriptions for domain autocomplete
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

  // Build the auto-rule from current selections
  let currentAutoRule = $derived.by((): ChannelAutoRule | undefined => {
    if (channelMode !== 'smart') return undefined;
    switch (autoRuleType) {
      case 'frequency:high':
        return { type: 'frequency', threshold: 'high' };
      case 'frequency:low':
        return { type: 'frequency', threshold: 'low' };
      case 'longReads':
        return { type: 'longReads', minLength: 5000 };
      case 'recent':
        return { type: 'recent', withinDays: recentWithinDays };
      case 'category':
        return categoryValue.trim() ? { type: 'category', value: categoryValue.trim() } : undefined;
      case 'subscriptionTag':
        return tagValue.trim() ? { type: 'subscriptionTag', value: tagValue.trim() } : undefined;
      case 'domain':
        return domainPatterns.length > 0 ? { type: 'domain', patterns: domainPatterns } : undefined;
      case 'people':
        return { type: 'people' };
    }
  });

  // Preview matched sources for smart mode
  let matchedSourceKeys = $derived.by(() => {
    if (!currentAutoRule) return [];
    return computeSourceKeys(
      currentAutoRule,
      subscriptionsStore.subscriptions,
      articlesStore.allArticles
    );
  });

  // Auto-fill name when switching rule type (only if not manually edited)
  $effect(() => {
    if (channelMode === 'smart' && !nameManuallyEdited) {
      if (autoRuleType === 'category' && categoryValue.trim()) {
        name = categoryValue.trim();
      } else if (autoRuleType === 'subscriptionTag' && tagValue.trim()) {
        const t = tagValue.trim();
        name = t.charAt(0).toUpperCase() + t.slice(1);
      } else if (autoRuleType === 'domain' && domainPatterns.length > 0) {
        name = domainPatterns[0];
      } else {
        name = DEFAULT_NAMES[autoRuleType];
      }
    }
  });

  // Filtered subscriptions based on search
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

  function toggleTypeFilter(type: SubscriptionSourceType) {
    const next = new Set(typeFilter);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    typeFilter = next;
  }

  // Reset form when modal opens or editingViewId changes
  $effect(() => {
    if (open) {
      if (editingViewId != null) {
        const view = filteredViewsStore.getById(editingViewId);
        if (view) {
          name = view.name;
          readFilter = view.readFilter;
          sortOrder = view.sortOrder;
          typeFilter = new Set(view.typeFilter ?? []);
          nameManuallyEdited = true; // Preserve existing name when editing

          // Detect saved channel
          channelType = view.mode === 'saved' ? 'saved' : 'feed';
          savedSourceFilter = new Set(view.savedSourceFilter ?? []);
          savedDateFilter = view.savedDateFilter ?? '';
          savedReadingLength = new Set(view.savedReadingLength ?? []);
          savedDomainFilter = new Set(view.savedDomainFilter ?? []);
          savedTagFilter = new Set(view.tagFilter ?? []);

          // Detect auto-rule
          const isSmartChannel = !!view.autoRule;
          if (isSmartChannel) {
            channelMode = 'smart';
            autoRuleType = autoRuleToOption(view.autoRule!);
            if (view.autoRule!.type === 'recent') {
              recentWithinDays = view.autoRule!.withinDays;
            } else if (view.autoRule!.type === 'category') {
              categoryValue = view.autoRule!.value;
            } else if (view.autoRule!.type === 'subscriptionTag') {
              tagValue = view.autoRule!.value;
            } else if (view.autoRule!.type === 'domain') {
              domainPatterns = [...view.autoRule!.patterns];
            }
          } else {
            channelMode = 'manual';
          }

          // Load source mode/keys for manual mode
          if (!isSmartChannel) {
            const mode = view.sourceMode === 'include' ? 'include' : 'all';
            sourceMode = mode;
            sourceKeys = mode === 'all' ? new Set() : new Set(view.sourceKeys ?? []);
          }
          feedSearch = '';
          return;
        }
      }
      // New channel defaults
      name = '';
      channelType = initialChannelType ?? 'feed';
      channelMode = 'manual';
      autoRuleType = 'frequency:high';
      recentWithinDays = 14;
      categoryValue = '';
      tagValue = '';
      domainPatterns = [];
      nameManuallyEdited = false;
      sourceMode = 'all';
      sourceKeys = new Set();
      savedSourceFilter = new Set();
      savedDateFilter = '';
      savedReadingLength = new Set();
      savedDomainFilter = new Set();
      savedTagFilter = new Set();
      readFilter = (initialChannelType ?? 'feed') === 'saved' ? 'unread' : 'all';
      sortOrder = 'newest';
      typeFilter = new Set();
      feedSearch = '';
    }
  });

  function handleClose() {
    error = null;
    saving = false;
    onclose();
  }

  function toggleSourceKey(key: string) {
    const next = new Set(sourceKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    sourceKeys = next;
  }

  async function handleDelete() {
    if (editingViewId == null) return;
    if (!confirm('Delete this channel?')) return;
    await filteredViewsStore.remove(editingViewId);
    ondeleted?.();
    handleClose();
  }

  async function handleSave() {
    if (!name.trim()) {
      error = 'Name is required';
      return;
    }

    error = null;
    saving = true;

    try {
      const isSmartMode = channelMode === 'smart' && currentAutoRule;

      const viewData =
        channelType === 'saved'
          ? {
              name: name.trim(),
              mode: 'saved' as const,
              savedSourceFilter:
                savedSourceFilter.size > 0 ? Array.from(savedSourceFilter) : undefined,
              savedDateFilter: savedDateFilter || undefined,
              savedReadingLength:
                savedReadingLength.size > 0 ? Array.from(savedReadingLength) : undefined,
              savedDomainFilter:
                savedDomainFilter.size > 0 ? Array.from(savedDomainFilter) : undefined,
              tagFilter: savedTagFilter.size > 0 ? Array.from(savedTagFilter) : undefined,
              readFilter,
              sortOrder,
            }
          : {
              name: name.trim(),
              mode: 'feed' as const,
              sourceMode: isSmartMode ? ('include' as const) : sourceMode,
              sourceKeys: isSmartMode ? matchedSourceKeys : Array.from(sourceKeys),
              autoRule: isSmartMode ? currentAutoRule : undefined,
              readFilter,
              sortOrder,
              typeFilter:
                channelMode === 'manual' && sourceMode === 'include'
                  ? undefined
                  : typeFilter.size > 0
                    ? Array.from(typeFilter)
                    : undefined,
            };

      if (editingViewId != null) {
        await filteredViewsStore.update(editingViewId, viewData);
      } else {
        const id = await filteredViewsStore.create(viewData);
        oncreated?.(id);
      }

      handleClose();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save view';
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  {open}
  onclose={handleClose}
  title={editingViewId != null ? 'Edit Channel' : 'Create Channel'}
>
  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      handleSave();
    }}
  >
    <!-- Name -->
    <div class="form-group">
      <label for="view-name">Name</label>
      <input
        id="view-name"
        type="text"
        bind:value={name}
        oninput={() => (nameManuallyEdited = true)}
        placeholder="My channel"
        required
      />
    </div>

    <!-- Channel Type -->
    <div class="form-group">
      <span class="form-label">Channel Type</span>
      <div class="mode-options">
        <label class="mode-option" class:selected={channelType === 'feed'}>
          <input type="radio" bind:group={channelType} value="feed" class="visually-hidden" />
          <span class="mode-title">Feed</span>
          <span class="mode-desc">RSS, shares, and documents</span>
        </label>
        <label class="mode-option" class:selected={channelType === 'saved'}>
          <input type="radio" bind:group={channelType} value="saved" class="visually-hidden" />
          <span class="mode-title">Saved</span>
          <span class="mode-desc">Your saved/bookmarked items</span>
        </label>
      </div>
    </div>

    {#if channelType === 'saved'}
      <!-- Saved source filter -->
      <div class="form-group">
        <span class="form-label">Include Sources</span>
        <p class="form-hint">Leave all unchecked to include everything</p>
        <div class="checklist type-checklist">
          {#each SAVED_SOURCE_OPTIONS as opt}
            <label class="checklist-item">
              <input
                type="checkbox"
                checked={savedSourceFilter.has(opt.value)}
                onchange={() => {
                  const next = new Set(savedSourceFilter);
                  if (next.has(opt.value)) {
                    next.delete(opt.value);
                  } else {
                    next.add(opt.value);
                  }
                  savedSourceFilter = next;
                }}
              />
              <span class="checklist-label">{opt.label}</span>
            </label>
          {/each}
        </div>
      </div>

      <!-- Date Added -->
      <div class="form-group">
        <span class="form-label">Date Added</span>
        <select class="form-select" bind:value={savedDateFilter}>
          <option value="">Any time</option>
          <option value="last-week">Last week</option>
          <option value="last-month">Last month</option>
          <option value="last-3-months">Last 3 months</option>
          <option value="last-year">Last year</option>
        </select>
      </div>

      <!-- Reading Length -->
      <div class="form-group">
        <span class="form-label">Reading Length</span>
        <p class="form-hint">Leave all unchecked to include everything</p>
        <div class="checklist type-checklist">
          {#each [{ value: 'quick', label: 'Quick (< 5 min)' }, { value: 'medium', label: 'Medium (5–15 min)' }, { value: 'long', label: 'Long (15+ min)' }] as opt}
            <label class="checklist-item">
              <input
                type="checkbox"
                checked={savedReadingLength.has(opt.value as ReadingLengthFilter)}
                onchange={() => {
                  const next = new Set(savedReadingLength);
                  const v = opt.value as ReadingLengthFilter;
                  if (next.has(v)) {
                    next.delete(v);
                  } else {
                    next.add(v);
                  }
                  savedReadingLength = next;
                }}
              />
              <span class="checklist-label">{opt.label}</span>
            </label>
          {/each}
        </div>
      </div>

      <!-- Domain Filter -->
      {#if feedViewStore.availableSavedDomains.length > 0}
        <div class="form-group">
          <span class="form-label">Domains</span>
          <p class="form-hint">Leave all unchecked to include everything</p>
          <div class="checklist type-checklist domain-checklist">
            {#each feedViewStore.availableSavedDomains as domain}
              <label class="checklist-item">
                <input
                  type="checkbox"
                  checked={savedDomainFilter.has(domain)}
                  onchange={() => {
                    const next = new Set(savedDomainFilter);
                    if (next.has(domain)) {
                      next.delete(domain);
                    } else {
                      next.add(domain);
                    }
                    savedDomainFilter = next;
                  }}
                />
                <span class="checklist-label">{domain}</span>
              </label>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Tag Filter -->
      {#if itemLabelsStore.allTags.length > 0}
        <div class="form-group">
          <span class="form-label">Tags</span>
          <p class="form-hint">Leave all unchecked to include everything</p>
          <div class="checklist type-checklist">
            {#each itemLabelsStore.allTags as tag}
              <label class="checklist-item">
                <input
                  type="checkbox"
                  checked={savedTagFilter.has(tag)}
                  onchange={() => {
                    const next = new Set(savedTagFilter);
                    if (next.has(tag)) {
                      next.delete(tag);
                    } else {
                      next.add(tag);
                    }
                    savedTagFilter = next;
                  }}
                />
                <span class="checklist-label">{tag}</span>
              </label>
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <!-- Channel Mode (feed channels only) -->
      <div class="form-group">
        <span class="form-label">Source Selection</span>
        <div class="mode-options">
          <label class="mode-option" class:selected={channelMode === 'manual'}>
            <input type="radio" bind:group={channelMode} value="manual" class="visually-hidden" />
            <span class="mode-title">Manual</span>
            <span class="mode-desc">Pick sources individually</span>
          </label>
          <label class="mode-option" class:selected={channelMode === 'smart'}>
            <input
              type="radio"
              bind:group={channelMode}
              value="smart"
              class="visually-hidden"
              onchange={() => {
                if (!nameManuallyEdited) name = DEFAULT_NAMES[autoRuleType];
              }}
            />
            <span class="mode-title">Smart</span>
            <span class="mode-desc">Auto-updates based on a rule</span>
          </label>
        </div>
      </div>

      {#if channelMode === 'smart'}
        <!-- Smart rule type -->
        <div class="form-group">
          <span class="form-label">Rule</span>
          <div class="rule-cards">
            {#each AUTO_RULE_OPTIONS as opt (opt.value)}
              <button
                type="button"
                class="rule-card"
                class:selected={autoRuleType === opt.value}
                onclick={() => {
                  autoRuleType = opt.value;
                  if (!nameManuallyEdited) name = DEFAULT_NAMES[autoRuleType];
                }}
              >
                <span class="rule-card-label">{opt.label}</span>
                <span class="rule-card-desc">{opt.description}</span>
              </button>
            {/each}
          </div>
        </div>

        {#if autoRuleType === 'recent'}
          <div class="form-group">
            <label for="recent-days" class="form-label">Within the last</label>
            <div class="inline-input">
              <input
                id="recent-days"
                type="number"
                bind:value={recentWithinDays}
                min="1"
                max="90"
                class="days-input"
              />
              <span class="input-suffix">days</span>
            </div>
          </div>
        {:else if autoRuleType === 'category'}
          <div class="form-group">
            <label for="category-value" class="form-label">Category</label>
            <input
              id="category-value"
              type="text"
              list="category-options"
              bind:value={categoryValue}
              placeholder="e.g. Technology"
            />
            <datalist id="category-options">
              {#each availableCategories as cat}
                <option value={cat} />
              {/each}
            </datalist>
          </div>
        {:else if autoRuleType === 'subscriptionTag'}
          <div class="form-group">
            <label for="tag-value" class="form-label">Tag</label>
            <input
              id="tag-value"
              type="text"
              list="tag-options"
              bind:value={tagValue}
              placeholder="e.g. news"
            />
            <datalist id="tag-options">
              {#each availableTags as tag}
                <option value={tag} />
              {/each}
            </datalist>
          </div>
        {:else if autoRuleType === 'domain'}
          <div class="form-group">
            <span class="form-label">Domain patterns</span>
            <DomainPatternInput
              patterns={domainPatterns}
              {availableDomains}
              onchange={(p) => (domainPatterns = p)}
            />
          </div>
        {/if}

        <!-- Matched sources preview -->
        <div class="match-preview" class:empty={matchedSourceKeys.length === 0}>
          {#if matchedSourceKeys.length > 0}
            Matches <strong>{matchedSourceKeys.length}</strong>
            {matchedSourceKeys.length === 1 ? 'source' : 'sources'}
          {:else}
            No sources match this rule yet
          {/if}
        </div>
      {:else}
        <!-- Manual source picker -->
        <div class="form-group">
          <span class="form-label">Sources</span>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" bind:group={sourceMode} value="all" />
              All sources
            </label>
            <label class="radio-label">
              <input type="radio" bind:group={sourceMode} value="include" />
              Include only
            </label>
          </div>

          {#if sourceMode === 'include'}
            {#if subscriptionsStore.subscriptions.length > 0}
              <div class="source-group-header">Subscriptions</div>
              <input
                type="text"
                placeholder="Search subscriptions..."
                bind:value={feedSearch}
                class="search-input"
              />
              <div class="checklist">
                {#each filteredSubscriptions as sub (sub.id)}
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
                    <label class="checklist-item">
                      <input
                        type="checkbox"
                        checked={sourceKeys.has(key)}
                        onchange={() => toggleSourceKey(key)}
                      />
                      {#if iconUrl}
                        <img src={iconUrl} alt="" class="checklist-icon" />
                      {/if}
                      <span class="checklist-label">{sub.customTitle || sub.title}</span>
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
      {/if}
    {/if}

    <div class="advanced-section">
      {#if channelType === 'feed' && !(channelMode === 'manual' && sourceMode === 'include')}
        <!-- Type Filter (feed channels only) -->
        <div class="form-group">
          <span class="form-label">Content Types</span>
          <div class="checklist type-checklist">
            {#each TYPE_OPTIONS as opt}
              <label class="checklist-item">
                <input
                  type="checkbox"
                  checked={typeFilter.has(opt.value)}
                  onchange={() => toggleTypeFilter(opt.value)}
                />
                <span class="checklist-label">{opt.label}</span>
              </label>
            {/each}
          </div>
          <span class="form-hint">Leave all unchecked to show all types</span>
        </div>
      {/if}

      <!-- Read State -->
      <div class="form-group">
        <span class="form-label">{channelType === 'saved' ? 'Status' : 'Read State'}</span>
        <div class="radio-group">
          {#if channelType !== 'saved'}
            <label class="radio-label">
              <input type="radio" bind:group={readFilter} value="all" />
              All
            </label>
          {/if}
          <label class="radio-label">
            <input type="radio" bind:group={readFilter} value="unread" />
            {channelType === 'saved' ? 'Inbox only' : 'Unread only'}
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={readFilter} value="read" />
            {channelType === 'saved' ? 'Archived only' : 'Read only'}
          </label>
        </div>
      </div>

      <!-- Sort Order -->
      <div class="form-group">
        <span class="form-label">Sort Order</span>
        {#if channelType === 'saved'}
          <select class="form-select" bind:value={sortOrder}>
            <option value="newest">Date saved (newest)</option>
            <option value="oldest">Date saved (oldest)</option>
            <option value="published-newest">Published date (newest)</option>
            <option value="published-oldest">Published date (oldest)</option>
            <option value="shortest">Reading time (shortest)</option>
            <option value="longest">Reading time (longest)</option>
            <option value="domain-asc">Domain (A–Z)</option>
            <option value="domain-desc">Domain (Z–A)</option>
          </select>
        {:else}
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" bind:group={sortOrder} value="newest" />
              Newest first
            </label>
            <label class="radio-label">
              <input type="radio" bind:group={sortOrder} value="oldest" />
              Oldest first
            </label>
          </div>
        {/if}
      </div>
    </div>

    {#if error}
      <p class="error-message">{error}</p>
    {/if}

    <div class="button-row">
      <button type="button" class="btn-secondary" onclick={handleClose} disabled={saving}>
        Cancel
      </button>
      <button type="submit" class="btn-primary" disabled={saving}>
        {#if saving}
          Saving...
        {:else if editingViewId != null}
          Save
        {:else}
          Create
        {/if}
      </button>
    </div>

    {#if editingViewId != null}
      <button type="button" class="delete-btn" onclick={handleDelete} disabled={saving}>
        Delete channel
      </button>
    {/if}
  </form>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group label[for],
  .form-label {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .form-group input[type='text'] {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: var(--text-md);
    background: var(--color-bg);
    color: var(--color-text);
  }

  .form-group input[type='text']:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
  }

  .mode-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .mode-option {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.625rem 0.75rem;
    border: 1.5px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .mode-option:hover {
    border-color: var(--color-text-secondary);
  }

  .mode-option.selected {
    border-color: var(--color-primary);
    background: rgba(0, 102, 204, 0.04);
  }

  .mode-title {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .mode-desc {
    font-size: var(--text-xs);
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

  .rule-card:hover {
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

  .advanced-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .inline-input {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .days-input {
    width: 4rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: var(--text-md);
    background: var(--color-bg);
    color: var(--color-text);
    text-align: center;
  }

  .days-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .input-suffix {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .match-preview {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: rgba(0, 102, 204, 0.04);
    border: 1px solid rgba(0, 102, 204, 0.1);
  }

  .match-preview.empty {
    background: rgba(0, 0, 0, 0.02);
    border-color: var(--color-border);
    font-style: italic;
  }

  .radio-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .radio-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-md);
    font-weight: var(--weight-regular);
    color: var(--color-text);
    cursor: pointer;
  }

  .source-group-header {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    margin-top: 0.5rem;
  }

  .search-input {
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--text-sm);
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
    margin-top: 0.25rem;
    box-sizing: border-box;
  }

  .search-input:focus {
    border-color: var(--color-primary);
  }

  .search-input::placeholder {
    color: var(--color-text-secondary, #999);
  }

  .no-results {
    padding: 0.375rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary, #999);
    text-align: center;
  }

  .checklist {
    max-height: 160px;
    overflow-y: auto;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.5rem;
    margin-top: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .type-checklist {
    max-height: none;
  }

  .domain-checklist {
    max-height: 200px;
    overflow-y: auto;
  }

  .form-select {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border-secondary, #333);
    border-radius: 0.5rem;
    background: var(--surface-primary, #1a1a1a);
    color: var(--text-primary, #e0e0e0);
    font-size: var(--text-md);
  }

  .form-hint {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .checklist-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.375rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--text-md);
  }

  .checklist-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .checklist-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 2px;
  }

  .checklist-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-message {
    color: var(--color-error);
    font-size: var(--text-md);
    margin: 0;
  }

  .button-row {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  .btn-primary,
  .btn-secondary {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-primary {
    background: var(--color-primary);
    color: white;
    border: none;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark, #0056b3);
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .btn-secondary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .delete-btn {
    width: 100%;
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: color 0.15s;
  }

  .delete-btn:hover:not(:disabled) {
    color: var(--color-error, #dc2626);
  }

  .delete-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
