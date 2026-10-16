<script lang="ts" module>
  import type { SourceFilter as Filter } from '$lib/utils/sourceFilter';
  import type { SortOrder as Order } from '$lib/types';

  /** What a new feed channel starts from: the view you're looking at. */
  export interface ChannelSeed {
    sourceFilter: Filter;
    readFilter: 'all' | 'unread';
    sortOrder: Order;
    tagFilter: string[];
  }
</script>

<script lang="ts">
  // Making or editing a channel, the same on every surface: the desktop modal
  // and the mobile filter sheet both render this. It asks, in order:
  //   - where items come from (new posts or saved articles), only when the
  //     entry point didn't already say, and never when editing;
  //   - how to show it (read state, order) — ahead of the source list, which
  //     can run long enough that anything below it goes unseen;
  //   - what's in it: sources you pick (a folder counts, and grows) or sources
  //     that match a rule.
  import { untrack } from 'svelte';
  import { isArchiveFeedSource } from '$lib/utils/newsletters';
  import SourcePicker from './SourcePicker.svelte';
  import DomainPatternInput from '$lib/components/DomainPatternInput.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import { FOLLOWS_SOURCE_KEY } from '$lib/utils/sourceKeys';
  import { computeSourceKeys } from '$lib/utils/channelLogic';
  import { joinNames, sourceFilterName, uniqueChannelName } from '$lib/utils/channelName';
  import {
    categoryGroupKey,
    isSourceShown,
    keysOfTypes,
    upgradeChannelFilter,
    CHANNEL_FILTER_VERSION,
    type SourceFilter,
  } from '$lib/utils/sourceFilter';
  import type {
    ChannelAutoRule,
    DateAddedPreset,
    ReadingLengthFilter,
    SavedSourceType,
    SortOrder,
    SubscriptionSourceType,
  } from '$lib/types';
  import {
    SAVED_SOURCE_OPTIONS,
    DATE_PRESET_OPTIONS_SHORT as DATE_PRESET_OPTIONS,
    READING_LENGTH_OPTIONS_SHORT as READING_LENGTH_OPTIONS,
    SAVED_SORT_OPTIONS_SHORT as SAVED_SORT_OPTIONS,
    FOLLOWS_SORT_OPTIONS,
    AUTO_RULE_OPTIONS,
    AUTO_RULE_DEFAULT_NAMES as DEFAULT_NAMES,
    autoRuleToOption,
    type AutoRuleOption,
  } from '$lib/constants/channelOptions';

  interface Props {
    /** The channel being edited; null makes a new one. */
    editingChannelId: number | null;
    /** Where a new channel's items come from, when the entry point knows; null asks. */
    initialChannelType?: 'feed' | 'saved' | null;
    /** A new feed channel's starting point (the view you're looking at). */
    seed?: ChannelSeed | null;
    /** Cap the source list's height and scroll inside it (the desktop modal). */
    scrollPicker?: boolean;
    /**
     * Stick the Save row to the bottom of the scrolling container (the mobile
     * sheet), so a long source list doesn't bury it.
     */
    pinActions?: boolean;
    /** Shown as a Cancel button when given. */
    oncancel?: () => void;
    onsaved: (created: string | null) => void;
    ondeleted?: () => void;
  }

  let {
    editingChannelId,
    initialChannelType = null,
    seed = null,
    scrollPicker = false,
    pinActions = false,
    oncancel,
    onsaved,
    ondeleted,
  }: Props = $props();

  const NO_SOURCES: SourceFilter = { sourceMode: 'include', sourceKeys: [] };

  let name = $state('');
  let nameEdited = $state(false);
  let channelType = $state<'feed' | 'saved' | null>('feed');
  let mode = $state<'pick' | 'rule'>('pick');
  let sourceFilter = $state<SourceFilter>(NO_SOURCES);
  let ruleType = $state<AutoRuleOption>('frequency:high');
  let recentWithinDays = $state(14);
  let tagValue = $state('');
  let domainPatterns = $state<string[]>([]);
  // A smart channel from before source groups may narrow its rule by type; kept
  // as it was, since there's no longer a control for it.
  let typeFilter = $state<SubscriptionSourceType[] | undefined>(undefined);
  let savedSourceFilter = $state<Set<SavedSourceType>>(new Set());
  let savedDateFilter = $state<DateAddedPreset | ''>('');
  let savedReadingLength = $state<Set<ReadingLengthFilter>>(new Set());
  let savedDomainFilter = $state<Set<string>>(new Set());
  let savedTagFilter = $state<Set<string>>(new Set());
  // A feed channel's tag filter has no control here; it's kept as it was, or as
  // the view it was saved from had it (see ChannelSeed).
  let feedTagFilter = $state<string[]>([]);
  let readFilter = $state<'all' | 'unread' | 'read'>('unread');
  let sortOrder = $state<SortOrder>('newest');
  let saving = $state(false);
  let error = $state<string | null>(null);

  let isEditing = $derived(editingChannelId != null);
  // Flips once, when the channel being edited is in the store (it can sync in
  // after the editor opens); a $derived so later syncs don't notify.
  let channelLoaded = $derived(
    editingChannelId != null && filteredViewsStore.getById(editingChannelId) != null
  );

  // Load the channel, or a new one's defaults, whenever what's being edited
  // changes, and only then: a sync landing mid-edit mustn't reset the form.
  $effect(() => {
    const id = editingChannelId;
    const type = initialChannelType;
    const initial = seed;
    void channelLoaded;
    untrack(() => load(id, type, initial));
  });

  function load(id: number | null, type: 'feed' | 'saved' | null, initial: ChannelSeed | null) {
    const view = id != null ? filteredViewsStore.getById(id) : null;
    error = null;
    saving = false;
    if (view) {
      name = view.name;
      nameEdited = true;
      channelType = view.mode === 'saved' ? 'saved' : 'feed';
      readFilter = view.readFilter;
      sortOrder = view.sortOrder;
      savedSourceFilter = new Set(view.savedSourceFilter ?? []);
      savedDateFilter = view.savedDateFilter ?? '';
      savedReadingLength = new Set(view.savedReadingLength ?? []);
      savedDomainFilter = new Set(view.savedDomainFilter ?? []);
      savedTagFilter = new Set(view.tagFilter ?? []);
      feedTagFilter = view.mode === 'saved' ? [] : [...(view.tagFilter ?? [])];
      const upgraded = upgradeChannelFilter(view);
      typeFilter = upgraded.typeFilter;
      const rule = view.autoRule;
      if (rule?.type === 'category') {
        // A folder is a pick now: the picker takes a whole folder, as it grows.
        mode = 'pick';
        // The old rule matched the folder's name regardless of case, so take
        // every spelling of it that's filed under.
        const want = rule.value.trim().toLowerCase();
        const folders = new Set(
          subscriptionsStore.subscriptions
            .map((s) => s.category?.trim())
            .filter((c): c is string => !!c && c.toLowerCase() === want)
        );
        if (folders.size === 0) folders.add(rule.value.trim());
        sourceFilter = { sourceMode: 'include', sourceKeys: [...folders].map(categoryGroupKey) };
        typeFilter = undefined;
      } else if (rule) {
        mode = 'rule';
        ruleType = autoRuleToOption(rule);
        if (rule.type === 'recent') recentWithinDays = rule.withinDays;
        else if (rule.type === 'subscriptionTag') tagValue = rule.value;
        else if (rule.type === 'domain') domainPatterns = [...rule.patterns];
      } else {
        mode = 'pick';
        sourceFilter = { sourceMode: upgraded.sourceMode, sourceKeys: upgraded.sourceKeys };
      }
      return;
    }
    name = '';
    nameEdited = false;
    channelType = initial ? 'feed' : type;
    mode = 'pick';
    sourceFilter = initial
      ? {
          sourceMode: initial.sourceFilter.sourceMode,
          sourceKeys: [...initial.sourceFilter.sourceKeys],
        }
      : NO_SOURCES;
    ruleType = 'frequency:high';
    recentWithinDays = 14;
    tagValue = '';
    domainPatterns = [];
    typeFilter = undefined;
    savedSourceFilter = new Set();
    savedDateFilter = '';
    savedReadingLength = new Set();
    savedDomainFilter = new Set();
    savedTagFilter = new Set();
    feedTagFilter = [...(initial?.tagFilter ?? [])];
    readFilter = initial?.readFilter ?? 'unread';
    sortOrder = initial?.sortOrder ?? 'newest';
  }

  // Your follows' links are a row like any other source (see SourcePicker).
  let showFollowsSource = $derived(
    !auth.isGuest && followLinksStore.loaded && !followLinksStore.scopeRequired
  );
  let followsInEverything = $derived(followLinksStore.inEverything === true);

  // Ranking by shares needs the follows source (see canSortByPopularity).
  let includesFollows = $derived(
    channelType === 'feed' &&
      mode === 'pick' &&
      sourceFilter.sourceMode !== 'all' &&
      isSourceShown(sourceFilter, FOLLOWS_SOURCE_KEY, {
        groups: feedViewStore.sourceGroups,
        followsInEverything,
      })
  );
  // A segmented control holds this many before it would have to wrap.
  const MAX_SEGMENTS = 4;

  let feedSortOptions = $derived(
    includesFollows
      ? FOLLOWS_SORT_OPTIONS
      : FOLLOWS_SORT_OPTIONS.filter((o) => o.value !== 'popular')
  );

  let sortOptions = $derived(channelType === 'saved' ? SAVED_SORT_OPTIONS : feedSortOptions);

  let availableTags = $derived(
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
          .filter((s) => isArchiveFeedSource(s.sourceType))
          .flatMap((s) =>
            [s.feedUrl, s.siteUrl]
              .filter(Boolean)
              .map((u) => {
                try {
                  return new URL(u!).hostname;
                } catch {
                  return null;
                }
              })
              .filter((h): h is string => !!h)
          )
      ),
    ].sort()
  );

  let currentRule = $derived.by((): ChannelAutoRule | undefined => {
    if (mode !== 'rule') return undefined;
    switch (ruleType) {
      case 'frequency:high':
        return { type: 'frequency', threshold: 'high' };
      case 'frequency:low':
        return { type: 'frequency', threshold: 'low' };
      case 'longReads':
        return { type: 'longReads', minLength: 5000 };
      case 'recent':
        return { type: 'recent', withinDays: recentWithinDays };
      case 'subscriptionTag':
        return tagValue.trim() ? { type: 'subscriptionTag', value: tagValue.trim() } : undefined;
      case 'domain':
        return domainPatterns.length > 0 ? { type: 'domain', patterns: domainPatterns } : undefined;
      case 'people':
        return { type: 'people' };
      default:
        return undefined;
    }
  });

  let matchedSourceKeys = $derived(
    currentRule
      ? computeSourceKeys(currentRule, subscriptionsStore.subscriptions, articlesStore.allArticles)
      : []
  );

  /** What a new channel would be called if you don't name it. */
  let suggestedName = $derived.by(() => {
    if (channelType !== 'feed') return '';
    if (mode === 'rule') {
      if (ruleType === 'subscriptionTag' && tagValue.trim()) {
        const t = tagValue.trim();
        return t.charAt(0).toUpperCase() + t.slice(1);
      }
      if (ruleType === 'domain' && domainPatterns.length > 0) return domainPatterns[0];
      return DEFAULT_NAMES[ruleType];
    }
    const parts: string[] = [];
    const sources = sourceFilterName(
      sourceFilter,
      subscriptionsStore.subscriptions,
      followsInEverything
    );
    if (sources) parts.push(sources);
    // A tag filter carried over from the view (see ChannelSeed), as the toolbar names it.
    if (feedTagFilter.length > 0) parts.push(joinNames(feedTagFilter));
    return parts.join(' \u00b7 ');
  });

  /** The name a new channel gets if you don't type one: never one that's taken. */
  function autoName(): string {
    return uniqueChannelName(
      suggestedName || (channelType === 'saved' ? 'Saved articles' : 'New channel'),
      filteredViewsStore.views.map((v) => v.name)
    );
  }

  // Fill the name in as you choose, until you type one.
  $effect(() => {
    if (!nameEdited) name = suggestedName ? autoName() : '';
  });

  function toggleIn<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  async function handleDelete() {
    if (editingChannelId == null) return;
    if (!confirm('Delete this channel?')) return;
    await filteredViewsStore.remove(editingChannelId);
    ondeleted?.();
  }

  async function handleSave() {
    if (channelType === null) {
      error = 'Choose where its items come from';
      return;
    }
    if (channelType === 'feed' && mode === 'pick') {
      if (sourceFilter.sourceMode === 'include' && sourceFilter.sourceKeys.length === 0) {
        error = 'Pick at least one source';
        return;
      }
    }
    if (channelType === 'feed' && mode === 'rule' && !currentRule) {
      error = ruleType === 'subscriptionTag' ? 'Choose a tag' : 'Add a site pattern';
      return;
    }
    // A name you typed stands; one filled in for you is checked again, in case
    // a channel has taken it since.
    const finalName = (nameEdited && name.trim()) || autoName();

    error = null;
    saving = true;
    try {
      const viewData =
        channelType === 'saved'
          ? {
              name: finalName,
              mode: 'saved' as const,
              savedSourceFilter: savedSourceFilter.size > 0 ? [...savedSourceFilter] : undefined,
              savedDateFilter: savedDateFilter || undefined,
              savedReadingLength: savedReadingLength.size > 0 ? [...savedReadingLength] : undefined,
              savedDomainFilter: savedDomainFilter.size > 0 ? [...savedDomainFilter] : undefined,
              tagFilter: savedTagFilter.size > 0 ? [...savedTagFilter] : undefined,
              readFilter: readFilter === 'all' ? ('unread' as const) : readFilter,
              // 'popular' (a feed sort) can carry over from before switching to Saved.
              sortOrder: SAVED_SORT_OPTIONS.some((o) => o.value === sortOrder)
                ? sortOrder
                : ('newest' as const),
            }
          : {
              name: finalName,
              mode: 'feed' as const,
              sourceMode: currentRule ? ('include' as const) : sourceFilter.sourceMode,
              sourceKeys: currentRule
                ? keysOfTypes(matchedSourceKeys, typeFilter, subscriptionsStore.subscriptions)
                : [...sourceFilter.sourceKeys],
              autoRule: currentRule,
              typeFilter: currentRule ? typeFilter : undefined,
              tagFilter: feedTagFilter.length > 0 ? [...feedTagFilter] : undefined,
              filterVersion: CHANNEL_FILTER_VERSION,
              readFilter,
              // Ranking by shares needs your follows' links in the channel.
              sortOrder:
                sortOrder === 'oldest' || (sortOrder === 'popular' && includesFollows)
                  ? sortOrder
                  : ('newest' as const),
            };

      if (editingChannelId != null) {
        await filteredViewsStore.update(editingChannelId, viewData);
        onsaved(null);
      } else {
        onsaved(await filteredViewsStore.create(viewData));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      saving = false;
    }
  }
</script>

<form
  class="channel-editor"
  onsubmit={(e) => {
    e.preventDefault();
    handleSave();
  }}
>
  <div class="section">
    <label class="section-label" for="channel-name">Name</label>
    <input
      id="channel-name"
      type="text"
      class="text-input"
      bind:value={name}
      oninput={() => (nameEdited = true)}
      placeholder={suggestedName || 'Name your channel'}
    />
  </div>

  {#if !isEditing && !initialChannelType && !seed}
    <div class="section">
      <span class="section-label">Items from</span>
      <div class="option-cards">
        <button
          type="button"
          class="option-card"
          class:selected={channelType === 'feed'}
          aria-pressed={channelType === 'feed'}
          onclick={() => (channelType = 'feed')}
        >
          <span class="option-title">Your sources</span>
          <span class="option-desc">New posts from what you follow</span>
        </button>
        <button
          type="button"
          class="option-card"
          class:selected={channelType === 'saved'}
          aria-pressed={channelType === 'saved'}
          onclick={() => (channelType = 'saved')}
        >
          <span class="option-title">Your saved articles</span>
          <span class="option-desc">What you've kept to read</span>
        </button>
      </div>
    </div>
  {/if}

  {#if channelType}
    <div class="section show-row">
      <div class="show-group">
        <span class="section-label">Show</span>
        <div class="chip-row segmented">
          {#if channelType === 'saved'}
            <button
              type="button"
              class="chip"
              class:active={readFilter !== 'read'}
              aria-pressed={readFilter !== 'read'}
              onclick={() => (readFilter = 'unread')}>Inbox</button
            >
            <button
              type="button"
              class="chip"
              class:active={readFilter === 'read'}
              aria-pressed={readFilter === 'read'}
              onclick={() => (readFilter = 'read')}>Archive</button
            >
          {:else}
            <button
              type="button"
              class="chip"
              class:active={readFilter === 'unread'}
              aria-pressed={readFilter === 'unread'}
              onclick={() => (readFilter = 'unread')}>Unread</button
            >
            <button
              type="button"
              class="chip"
              class:active={readFilter === 'all'}
              aria-pressed={readFilter === 'all'}
              onclick={() => (readFilter = 'all')}>All</button
            >
            {#if readFilter === 'read'}
              <button type="button" class="chip active" aria-pressed="true">Read</button>
            {/if}
          {/if}
        </div>
      </div>
      <div class="show-group">
        <label class="section-label" for="channel-order">Order</label>
        {#if sortOptions.length > MAX_SEGMENTS}
          <!-- Too many to sit side by side (a saved channel has eight): a
               dropdown, not a segmented control that wraps. -->
          <select id="channel-order" class="select-input" bind:value={sortOrder}>
            {#each sortOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        {:else}
          <div class="chip-row segmented" id="channel-order" role="group" aria-label="Order">
            {#each sortOptions as opt (opt.value)}
              <button
                type="button"
                class="chip"
                class:active={sortOrder === opt.value}
                aria-pressed={sortOrder === opt.value}
                onclick={() => (sortOrder = opt.value)}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if channelType === 'feed'}
    <div class="section">
      <span class="section-label">What's in it</span>
      <div class="option-cards">
        <button
          type="button"
          class="option-card"
          class:selected={mode === 'pick'}
          aria-pressed={mode === 'pick'}
          onclick={() => (mode = 'pick')}
        >
          <span class="option-title">Sources I pick</span>
          <span class="option-desc">A list you choose</span>
        </button>
        <button
          type="button"
          class="option-card"
          class:selected={mode === 'rule'}
          aria-pressed={mode === 'rule'}
          onclick={() => (mode = 'rule')}
        >
          <span class="option-title">Sources that match</span>
          <span class="option-desc">Updates as you follow more</span>
        </button>
      </div>

      {#if mode === 'pick'}
        <p class="hint">
          Checked sources are in this channel. A checked folder also takes in what you add to it
          later.
        </p>
        <div class="picker-box">
          <SourcePicker
            filter={sourceFilter}
            onchange={(f) => (sourceFilter = f)}
            showFollows={showFollowsSource}
            {followsInEverything}
            scroll={scrollPicker}
          />
        </div>
      {:else}
        <fieldset class="rule-list">
          <legend class="visually-hidden">Rule</legend>
          {#each AUTO_RULE_OPTIONS as opt (opt.value)}
            <label class="rule-row">
              <input type="radio" name="channel-rule" value={opt.value} bind:group={ruleType} />
              <span class="rule-text">
                <span class="rule-title">{opt.label}</span>
                <span class="option-desc">{opt.description}</span>
              </span>
            </label>
          {/each}
        </fieldset>

        {#if ruleType === 'recent'}
          <div class="inline-input">
            <label for="recent-days" class="input-prefix">Added in the last</label>
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
        {:else if ruleType === 'subscriptionTag'}
          <input
            type="text"
            list="channel-tag-options"
            class="text-input"
            aria-label="Tag"
            bind:value={tagValue}
            placeholder="Tag, e.g. news"
          />
          <datalist id="channel-tag-options">
            {#each availableTags as tag}
              <option value={tag}></option>
            {/each}
          </datalist>
        {:else if ruleType === 'domain'}
          <DomainPatternInput
            patterns={domainPatterns}
            {availableDomains}
            onchange={(p) => (domainPatterns = p)}
            hint=""
          />
        {/if}

        <div class="match-preview" class:empty={matchedSourceKeys.length === 0}>
          {#if matchedSourceKeys.length > 0}
            Matches <strong>{matchedSourceKeys.length}</strong>
            {matchedSourceKeys.length === 1 ? 'source' : 'sources'} today
          {:else}
            No sources match this yet
          {/if}
        </div>
      {/if}
    </div>
  {:else if channelType === 'saved'}
    <div class="section">
      <span class="section-label">What's in it</span>
      <p class="hint">Choose nothing in a row to take in all of it.</p>

      <span class="row-label">Kind</span>
      <div class="chip-row">
        {#each SAVED_SOURCE_OPTIONS as opt}
          <button
            type="button"
            class="chip"
            class:active={savedSourceFilter.has(opt.value)}
            aria-pressed={savedSourceFilter.has(opt.value)}
            onclick={() => (savedSourceFilter = toggleIn(savedSourceFilter, opt.value))}
          >
            {opt.label}
          </button>
        {/each}
      </div>

      <span class="row-label">Saved in the last</span>
      <div class="chip-row">
        {#each DATE_PRESET_OPTIONS as opt}
          <button
            type="button"
            class="chip"
            class:active={savedDateFilter === opt.value}
            aria-pressed={savedDateFilter === opt.value}
            onclick={() => (savedDateFilter = opt.value as DateAddedPreset | '')}
          >
            {opt.label}
          </button>
        {/each}
      </div>

      <span class="row-label">Length</span>
      <div class="chip-row">
        {#each READING_LENGTH_OPTIONS as opt}
          <button
            type="button"
            class="chip"
            class:active={savedReadingLength.has(opt.value)}
            aria-pressed={savedReadingLength.has(opt.value)}
            onclick={() => (savedReadingLength = toggleIn(savedReadingLength, opt.value))}
          >
            {opt.label}
          </button>
        {/each}
      </div>

      {#if feedViewStore.availableSavedDomains.length > 0}
        <span class="row-label">Sites</span>
        <div class="chip-row scroll-chips">
          {#each feedViewStore.availableSavedDomains as domain}
            <button
              type="button"
              class="chip"
              class:active={savedDomainFilter.has(domain)}
              aria-pressed={savedDomainFilter.has(domain)}
              onclick={() => (savedDomainFilter = toggleIn(savedDomainFilter, domain))}
            >
              {domain}
            </button>
          {/each}
        </div>
      {/if}

      {#if itemLabelsStore.allTags.length > 0}
        <span class="row-label">Tags</span>
        <div class="chip-row scroll-chips">
          {#each itemLabelsStore.allTags as tag}
            <button
              type="button"
              class="chip"
              class:active={savedTagFilter.has(tag)}
              aria-pressed={savedTagFilter.has(tag)}
              onclick={() => (savedTagFilter = toggleIn(savedTagFilter, tag))}
            >
              {tag}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="actions" class:pinned={pinActions}>
    {#if isEditing}
      <button type="button" class="delete-btn" onclick={handleDelete} disabled={saving}>
        Delete channel
      </button>
    {/if}
    {#if oncancel}
      <button type="button" class="btn-secondary" onclick={oncancel} disabled={saving}>
        Cancel
      </button>
    {/if}
    <button type="submit" class="btn-primary" disabled={saving}>
      {#if saving}
        Saving…
      {:else if isEditing}
        Save
      {:else}
        Create channel
      {/if}
    </button>
  </div>
</form>

<style>
  .channel-editor {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Sections part by space alone; a label in Ink is enough of a heading. */
  .section-label {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    line-height: var(--leading-snug);
  }

  /* Show and Order share a row; Order wraps under Show when the chips don't fit. */
  .show-row {
    flex-direction: row;
    flex-wrap: wrap;
    column-gap: 1.5rem;
    row-gap: 0.75rem;
  }

  .show-group {
    min-width: 0;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .row-label {
    margin-top: 0.25rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .text-input {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-lg);
    outline: none;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }

  .text-input:focus {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-sidebar-active);
  }

  .text-input::placeholder {
    color: var(--color-text-secondary);
  }

  .option-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .rule-list {
    margin: 0;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    overflow: hidden;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .rule-row {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
  }

  .rule-row + .rule-row {
    border-top: 1px solid var(--color-border);
  }

  .rule-row input {
    margin: 0.2rem 0 0;
    accent-color: var(--color-primary);
  }

  .rule-text {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .rule-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .option-card {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    text-align: left;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .option-card:hover {
    border-color: var(--color-text-secondary);
  }

  .option-card.selected {
    border-color: var(--color-primary);
    box-shadow: inset 0 0 0 1px var(--color-primary);
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.06));
  }

  .option-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .option-card.selected .option-title {
    color: var(--color-primary);
  }

  .option-desc {
    font-size: var(--text-2xs);
    color: var(--color-text-secondary);
    line-height: var(--leading-tight);
  }

  .picker-box {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    overflow: hidden;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .scroll-chips {
    max-height: 7.5rem;
    overflow-y: auto;
  }

  .chip {
    padding: 0.375rem 0.75rem;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }

  .chip.active {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  /* Show and Order are one-of choices: a segmented control, the chosen segment
     a raised thumb on a sunken track. */
  .segmented {
    flex-wrap: nowrap;
    align-self: flex-start;
    gap: 0.125rem;
    padding: 0.1875rem;
    border-radius: 8px;
    background: var(--color-bg-secondary);
  }

  .segmented .chip {
    padding: 0.3125rem 0.875rem;
    border: none;
    border-radius: 6px;
    background: none;
    white-space: nowrap;
  }

  .segmented .chip:hover:not(.active) {
    color: var(--color-text);
  }

  .segmented .chip.active {
    background: var(--color-bg);
    color: var(--color-text);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.08),
      0 0 0 1px rgba(0, 0, 0, 0.04);
  }

  @media (prefers-color-scheme: dark) {
    .segmented .chip.active {
      background: var(--color-border);
      box-shadow: none;
    }
  }

  /* Sized to sit beside the segmented Show control: same height, same radius. */
  .select-input {
    align-self: flex-start;
    height: 2.125rem;
    padding: 0 2rem 0 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg)
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")
      no-repeat right 0.625rem center;
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  .select-input:hover {
    border-color: var(--color-text-secondary);
  }

  .select-input:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-sidebar-active);
  }

  .inline-input {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .input-prefix,
  .input-suffix {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .days-input {
    width: 4rem;
    padding: 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-base);
    text-align: center;
    outline: none;
  }

  .days-input:focus {
    border-color: var(--color-primary);
  }

  .match-preview {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .match-preview.empty {
    font-style: italic;
  }

  .error {
    margin: 0;
    color: var(--color-error);
    font-size: var(--text-sm);
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  /* Rides the bottom of the scroll area, opaque so rows scroll under it. In the
     modal it borrows the dialog's inset and footer band, so it reads as the
     modal's own footer; in the sheet both fall back to plain. */
  .actions.pinned {
    position: sticky;
    bottom: 0;
    z-index: 1;
    margin-inline: calc(var(--modal-inset, 0px) * -1);
    padding: 0.75rem var(--modal-inset, 0px);
    background: var(--modal-footer-bg, var(--color-bg));
    border-top: 1px solid var(--color-border);
  }

  .btn-primary,
  .btn-secondary {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }

  .btn-primary {
    border: none;
    background: var(--color-primary);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
  }

  .btn-secondary {
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text);
  }

  .btn-secondary:hover:not(:disabled) {
    border-color: var(--color-text-secondary);
  }

  .btn-primary:disabled,
  .btn-secondary:disabled,
  .delete-btn:disabled {
    opacity: 0.6;
  }

  /* First in the row and pushed left, away from Save. */
  .delete-btn {
    margin-right: auto;
    margin-left: -0.5rem;
    padding: 0.5rem;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .delete-btn:hover:not(:disabled),
  .delete-btn:active:not(:disabled) {
    color: var(--color-error);
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  /* A phone: the two buttons share the width, and Delete takes a line of its own. */
  @media (max-width: 640px) {
    .actions {
      flex-wrap: wrap;
    }

    .btn-primary,
    .btn-secondary {
      flex: 1;
      padding: 0.625rem 1rem;
    }

    .delete-btn {
      order: 1;
      flex-basis: 100%;
      margin: 0;
    }
  }

  @media (hover: none) and (pointer: coarse) {
    .text-input,
    .select-input,
    .days-input {
      font-size: 1rem;
    }
  }
</style>
