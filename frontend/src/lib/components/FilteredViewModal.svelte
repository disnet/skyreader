<script lang="ts">
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import Modal from '$lib/components/common/Modal.svelte';
  import type { SubscriptionSourceType, ChannelAutoRule } from '$lib/types';
  import { subscriptionSourceKey } from '$lib/utils/sourceKeys';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { computeSourceKeys } from '$lib/utils/channelLogic';

  const TYPE_OPTIONS: { value: SubscriptionSourceType; label: string }[] = [
    { value: 'rss', label: 'RSS Feeds' },
    { value: 'atproto.shares', label: 'Skyreader Shares' },
    { value: 'atproto.documents', label: 'Standard.site Documents' },
  ];

  type AutoRuleOption =
    | 'frequency:high'
    | 'frequency:low'
    | 'longReads'
    | 'recent'
    | 'category'
    | 'subscriptionTag'
    | 'domain'
    | 'people';

  const AUTO_RULE_OPTIONS: { value: AutoRuleOption; label: string; description: string }[] = [
    {
      value: 'frequency:high',
      label: 'Daily Digest',
      description: 'High-volume feeds that publish 2+ times per day',
    },
    {
      value: 'frequency:low',
      label: "Don't Miss",
      description: 'Infrequent feeds where every post counts',
    },
    {
      value: 'longReads',
      label: 'Long Reads',
      description: 'Feeds with in-depth, long-form articles',
    },
    {
      value: 'recent',
      label: 'Recently Added',
      description: 'Sources you added recently',
    },
    {
      value: 'category',
      label: 'Category',
      description: 'All sources in a specific folder',
    },
    {
      value: 'subscriptionTag',
      label: 'Tag',
      description: 'All sources with a specific tag',
    },
    {
      value: 'domain',
      label: 'Domain',
      description: 'Sources matching URL patterns',
    },
    {
      value: 'people',
      label: 'People',
      description: 'Everyone you follow on AT Protocol',
    },
  ];

  const DEFAULT_NAMES: Record<AutoRuleOption, string> = {
    'frequency:high': 'Daily Digest',
    'frequency:low': "Don't Miss",
    longReads: 'Long Reads',
    recent: 'New Sources',
    category: '',
    subscriptionTag: '',
    domain: '',
    people: 'People I Follow',
  };

  interface Props {
    open: boolean;
    editingViewId: number | null;
    onclose: () => void;
    oncreated?: (id: number) => void;
    ondeleted?: () => void;
  }

  let { open, editingViewId, onclose, oncreated, ondeleted }: Props = $props();

  // Form state
  let name = $state('');
  let channelMode = $state<'manual' | 'smart'>('manual');
  let autoRuleType = $state<AutoRuleOption>('frequency:high');
  let recentWithinDays = $state(14);
  let categoryValue = $state('');
  let tagValue = $state('');
  let domainPatterns = $state<string[]>([]);
  let domainInput = $state('');
  let domainSuggestionsOpen = $state(false);
  let domainHighlightIndex = $state(-1);
  let sourceMode = $state<'all' | 'include'>('all');
  let sourceKeys = $state<Set<string>>(new Set());
  let readFilter = $state<'all' | 'unread' | 'read'>('all');
  let sortOrder = $state<'newest' | 'oldest'>('newest');
  let typeFilter = $state<Set<SubscriptionSourceType>>(new Set());
  let saving = $state(false);
  let error = $state<string | null>(null);
  let showAdvanced = $state(false);

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

  let domainSuggestions = $derived.by(() => {
    const q = domainInput.trim().toLowerCase();
    const existing = new Set(domainPatterns);
    return availableDomains.filter((d) => (!q || d.includes(q)) && !existing.has(d));
  });

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

  /** Map a stored autoRule back to an AutoRuleOption. */
  function autoRuleToOption(rule: ChannelAutoRule): AutoRuleOption {
    switch (rule.type) {
      case 'frequency':
        return rule.threshold === 'high' ? 'frequency:high' : 'frequency:low';
      case 'longReads':
        return 'longReads';
      case 'recent':
        return 'recent';
      case 'category':
        return 'category';
      case 'subscriptionTag':
        return 'subscriptionTag';
      case 'domain':
        return 'domain';
      case 'people':
        return 'people';
    }
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
          // Auto-open advanced if non-default values (read from view, not $state, to avoid re-triggering this effect)
          showAdvanced =
            (view.typeFilter ?? []).length > 0 ||
            view.readFilter !== 'unread' ||
            view.sortOrder !== 'newest';
          return;
        }
      }
      // New channel defaults
      name = '';
      channelMode = 'manual';
      autoRuleType = 'frequency:high';
      recentWithinDays = 14;
      categoryValue = '';
      tagValue = '';
      domainPatterns = [];
      nameManuallyEdited = false;
      sourceMode = 'all';
      sourceKeys = new Set();
      readFilter = 'all';
      sortOrder = 'newest';
      typeFilter = new Set();
      feedSearch = '';
      showAdvanced = false;
    }
  });

  function handleClose() {
    error = null;
    saving = false;
    onclose();
  }

  function addDomainPattern(value?: string) {
    const v = (value ?? domainInput).trim();
    if (v && !domainPatterns.includes(v)) {
      domainPatterns = [...domainPatterns, v];
    }
    domainInput = '';
    domainSuggestionsOpen = false;
    domainHighlightIndex = -1;
  }

  function removeDomainPattern(pattern: string) {
    domainPatterns = domainPatterns.filter((p) => p !== pattern);
  }

  function handleDomainKeydown(e: KeyboardEvent) {
    if (domainSuggestionsOpen && domainSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        domainHighlightIndex = (domainHighlightIndex + 1) % domainSuggestions.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        domainHighlightIndex =
          domainHighlightIndex <= 0 ? domainSuggestions.length - 1 : domainHighlightIndex - 1;
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (domainHighlightIndex >= 0 && domainHighlightIndex < domainSuggestions.length) {
          addDomainPattern(domainSuggestions[domainHighlightIndex]);
        } else {
          addDomainPattern();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        domainSuggestionsOpen = false;
        domainHighlightIndex = -1;
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      addDomainPattern();
    } else if (e.key === 'Backspace' && !domainInput && domainPatterns.length > 0) {
      domainPatterns = domainPatterns.slice(0, -1);
    }
  }

  function handleDomainInput() {
    domainSuggestionsOpen = true;
    domainHighlightIndex = -1;
  }

  function handleDomainBlur() {
    // Delay to allow click on suggestion to fire first
    setTimeout(() => {
      domainSuggestionsOpen = false;
      addDomainPattern();
    }, 150);
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

      const viewData = {
        name: name.trim(),
        sourceMode: isSmartMode ? ('include' as const) : sourceMode,
        sourceKeys: isSmartMode ? matchedSourceKeys : Array.from(sourceKeys),
        autoRule: isSmartMode ? currentAutoRule : undefined,
        readFilter,
        sortOrder,
        typeFilter: typeFilter.size > 0 ? Array.from(typeFilter) : undefined,
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

    <!-- Channel Mode -->
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
          <div class="chip-input-wrapper">
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="chip-input"
              onclick={(e) => {
                const input = (e.currentTarget as HTMLElement).querySelector('input');
                input?.focus();
              }}
            >
              {#each domainPatterns as pattern}
                <span class="chip">
                  {pattern}
                  <button
                    type="button"
                    class="chip-remove"
                    onclick={() => removeDomainPattern(pattern)}
                    aria-label="Remove {pattern}"
                  >
                    &times;
                  </button>
                </span>
              {/each}
              <input
                type="text"
                bind:value={domainInput}
                onkeydown={handleDomainKeydown}
                oninput={handleDomainInput}
                onblur={handleDomainBlur}
                onfocus={() => (domainSuggestionsOpen = true)}
                placeholder={domainPatterns.length === 0 ? 'Type a domain and press Enter' : ''}
                class="chip-text-input"
                role="combobox"
                aria-expanded={domainSuggestionsOpen && domainSuggestions.length > 0}
                aria-autocomplete="list"
                autocomplete="off"
              />
            </div>
            {#if domainSuggestionsOpen && domainSuggestions.length > 0}
              <ul class="chip-suggestions" role="listbox">
                {#each domainSuggestions as suggestion, i (suggestion)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <li
                    class="chip-suggestion"
                    class:highlighted={i === domainHighlightIndex}
                    role="option"
                    aria-selected={i === domainHighlightIndex}
                    onmousedown={(e) => {
                      e.preventDefault();
                      addDomainPattern(suggestion);
                    }}
                    onmouseenter={() => (domainHighlightIndex = i)}
                  >
                    {suggestion}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          <span class="form-hint">Press Enter to add. Matches against feed URL hostnames.</span>
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

    <!-- Advanced options (collapsed by default) -->
    <button type="button" class="advanced-toggle" onclick={() => (showAdvanced = !showAdvanced)}>
      <span class="advanced-arrow" class:open={showAdvanced}>&#9656;</span>
      More options
    </button>

    {#if showAdvanced}
      <div class="advanced-section">
        <!-- Type Filter -->
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

        <!-- Read State -->
        <div class="form-group">
          <span class="form-label">Read State</span>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" bind:group={readFilter} value="all" />
              All
            </label>
            <label class="radio-label">
              <input type="radio" bind:group={readFilter} value="unread" />
              Unread only
            </label>
            <label class="radio-label">
              <input type="radio" bind:group={readFilter} value="read" />
              Read only
            </label>
          </div>
        </div>

        <!-- Sort Order -->
        <div class="form-group">
          <span class="form-label">Sort Order</span>
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
        </div>
      </div>
    {/if}

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
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
  }

  .form-group input[type='text'] {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 0.875rem;
    background: var(--color-bg);
    color: var(--color-text);
  }

  .form-group input[type='text']:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .chip-input {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    cursor: text;
    min-height: 2.25rem;
  }

  .chip-input:focus-within {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.25rem 0.125rem 0.5rem;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.06));
    border-radius: 4px;
    font-size: 0.8125rem;
    color: var(--color-text);
    line-height: 1.4;
  }

  .chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
    line-height: 1;
    border-radius: 3px;
  }

  .chip-remove:hover {
    background: rgba(0, 0, 0, 0.1);
    color: var(--color-text);
  }

  .chip-text-input {
    flex: 1;
    min-width: 8rem;
    border: none;
    background: none;
    outline: none;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--color-text);
    padding: 0.125rem 0;
  }

  .chip-text-input::placeholder {
    color: var(--color-text-secondary);
  }

  .chip-input-wrapper {
    position: relative;
  }

  .chip-suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin: 0.25rem 0 0;
    padding: 0.25rem;
    list-style: none;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    z-index: 10;
    max-height: 160px;
    overflow-y: auto;
  }

  .chip-suggestion {
    padding: 0.375rem 0.5rem;
    font-size: 0.8125rem;
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text);
  }

  .chip-suggestion.highlighted {
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.06));
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
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .mode-desc {
    font-size: 0.75rem;
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
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .rule-card-desc {
    font-size: 0.6875rem;
    color: var(--color-text-secondary);
    line-height: 1.3;
  }

  .advanced-toggle {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    transition: color 0.15s;
  }

  .advanced-toggle:hover {
    color: var(--color-text);
  }

  .advanced-arrow {
    display: inline-block;
    transition: transform 0.15s;
    font-size: 0.75rem;
  }

  .advanced-arrow.open {
    transform: rotate(90deg);
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
    font-size: 0.875rem;
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
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .match-preview {
    font-size: 0.8125rem;
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
    font-size: 0.875rem;
    font-weight: 400;
    color: var(--color-text);
    cursor: pointer;
  }

  .source-group-header {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.5rem;
  }

  .search-input {
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 0.8125rem;
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
    font-size: 0.8125rem;
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

  .form-hint {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .checklist-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.375rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
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
    font-size: 0.875rem;
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
    font-size: 0.875rem;
    font-weight: 500;
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
    font-size: 0.8125rem;
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
