<script lang="ts">
  // The feed header's Filter button opens this: a menu hung under the button,
  // the same card as the reader's Share and Style menus. Sort and Unread/All are
  // rows with a check; Sources and Tags fold open in place, so nothing stacks a
  // popover on a popover; Save (or Update, on a channel) sits at the foot.
  // Every pick applies at once and the menu stays up. FeedPageHeader owns
  // opening and closing it.
  import Icon, { type IconName } from '$lib/components/Icon.svelte';
  import SourcePicker from './SourcePicker.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { goto } from '$app/navigation';
  import { channelPath, FEEDS_PATH } from '$lib/utils/viewNav';
  import { FOLLOWS_SOURCE_KEY } from '$lib/utils/sourceKeys';
  import { auth } from '$lib/stores/auth.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import { type SourceFilter } from '$lib/utils/sourceFilter';
  import { joinNames, sourceFilterName, uniqueChannelName } from '$lib/utils/channelName';
  import type { SortOrder } from '$lib/types';

  interface Props {
    showSourceFilter: boolean;
    onEditChannel?: (id: number) => void;
  }

  let { showSourceFilter, onEditChannel }: Props = $props();

  let ef = $derived(feedViewStore.effectiveFilters);

  // --- Sort ---

  // Most shared is offered only where the follows' share counts exist; anywhere
  // else, anything but Oldest shows as Newest (see the store's toggleSortOrder).
  let sortOrder = $derived<SortOrder>(
    feedViewStore.currentSortOrder === 'oldest'
      ? 'oldest'
      : feedViewStore.canSortByPopularity && feedViewStore.currentSortOrder === 'popular'
        ? 'popular'
        : 'newest'
  );
  let sortOptions = $derived.by(() => {
    const options: { value: SortOrder; label: string; icon: IconName }[] = [
      { value: 'newest', label: 'Newest first', icon: 'arrow-down' },
      { value: 'oldest', label: 'Oldest first', icon: 'arrow-up' },
    ];
    if (feedViewStore.canSortByPopularity) {
      options.push({ value: 'popular', label: 'Most shared', icon: 'users' });
    }
    return options;
  });

  function pickSort(value: SortOrder) {
    if (value === sortOrder) return;
    if (feedViewStore.canSortByPopularity) feedViewStore.setSortOrder(value);
    else feedViewStore.toggleSortOrder();
  }

  const READ_OPTIONS: { unread: boolean; label: string; icon: IconName }[] = [
    { unread: true, label: 'Unread', icon: 'circle-dot' },
    { unread: false, label: 'All', icon: 'inbox' },
  ];

  // --- Sources ---

  // Your follows' links are a row like any other source, offered once you've
  // let Skyreader read your Following timeline.
  let showFollowsSource = $derived(
    !auth.isGuest && followLinksStore.loaded && !followLinksStore.scopeRequired
  );
  let followsInEverything = $derived(followLinksStore.inEverything === true);

  function setSourceFilter(next: SourceFilter) {
    feedViewStore.setToolbarSourceFilter(next.sourceMode, next.sourceKeys);
  }

  // What the filter leaves out, not counting the follows key an exclude filter
  // carries only to say "as Everything" (see utils/sourceFilter.ts).
  let hiddenCount = $derived(
    ef.sourceKeys.filter((k) => followsInEverything || k !== FOLLOWS_SOURCE_KEY).length
  );
  let sourceSummary = $derived(
    ef.sourceMode === 'include'
      ? `Only ${ef.sourceKeys.length}`
      : ef.sourceMode === 'exclude' && hiddenCount > 0
        ? `${hiddenCount} hidden`
        : 'All'
  );

  // Folded open from the store, which the header clears when the menu closes.
  let sourcesOpen = $derived(feedViewStore.sourcePopoverOpen);

  // --- Tags ---

  let allTags = $derived(itemLabelsStore.allTags);
  let activeTagFilter = $derived(feedViewStore.toolbarTagFilter);
  let activeTagSet = $derived(new Set(activeTagFilter));
  let tagSummary = $derived(activeTagFilter.length === 0 ? 'Any' : `${activeTagFilter.length}`);
  let tagsOpen = $state(false);

  let sourcesRowEl = $state<HTMLButtonElement | null>(null);
  let tagsRowEl = $state<HTMLButtonElement | null>(null);

  /**
   * Escape folds an open section first, handing focus back to its row (the
   * fold's own fields go with it); the host closes the menu on the next one.
   * A section only counts when it's on screen: a channel shows Edit channel
   * in their place.
   */
  export function foldOpenSection(): boolean {
    if (sourcesOpen && sourcesRowEl) {
      feedViewStore.setSourcePopoverOpen(false);
      sourcesRowEl.focus();
      return true;
    }
    if (tagsOpen && tagsRowEl) {
      tagsOpen = false;
      tagsRowEl.focus();
      return true;
    }
    return false;
  }

  // Sort and Show are radio groups: one tab stop each, the arrows move the
  // choice (and focus) along the rows.
  function onRadioKeydown(e: KeyboardEvent) {
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!step) return;
    const radios = Array.from(
      (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]')
    );
    const at = radios.findIndex((r) => r.getAttribute('aria-checked') === 'true');
    const next = radios[(at + step + radios.length) % radios.length];
    if (!next) return;
    e.preventDefault();
    next.click();
    next.focus();
  }

  const uid = $props.id();

  // --- Save view ---

  let saving = $state(false);

  let isEditingView = $derived(!!feedViewStore.viewFilter);

  // Rename view state — also how a freshly saved channel gets named: Save writes
  // the channel immediately with an auto name, then opens this for editing.
  let showRenameInput = $state(false);
  let renameViewName = $state('');
  let renameViewId = $state<number | null>(null);

  /** Focus and select the name field whenever it mounts, however it got there. */
  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  /** Describe the current filters well enough to recognise, short enough to read. */
  function autoChannelName(): string {
    const parts: string[] = [];
    const sources = sourceFilterName(ef, subscriptionsStore.subscriptions, followsInEverything);
    if (sources) parts.push(sources);
    if (activeTagFilter.length > 0) parts.push(joinNames([...activeTagFilter]));
    return uniqueChannelName(
      parts.join(' · ') || 'New channel',
      filteredViewsStore.views.map((v) => v.name)
    );
  }

  function beginRename(view: { id?: number; name: string } | null | undefined) {
    if (!view || view.id == null) return;
    renameViewId = view.id;
    renameViewName = view.name;
    showRenameInput = true;
  }

  function startRenameView() {
    beginRename(feedViewStore.activeFilteredView);
  }

  async function commitRenameView() {
    const id = renameViewId;
    showRenameInput = false;
    renameViewId = null;
    if (id == null) return;
    const trimmed = renameViewName.trim();
    if (!trimmed) return;
    const view = filteredViewsStore.getById(id);
    if (view && trimmed !== view.name) {
      await filteredViewsStore.update(id, { name: trimmed });
    }
  }

  function cancelRenameView() {
    // Clear the target first so the input's blur handler doesn't commit.
    renameViewId = null;
    showRenameInput = false;
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRenameView();
    } else if (e.key === 'Escape') {
      // The name field's own Escape: cancel the rename, keep the menu.
      e.stopPropagation();
      cancelRenameView();
    }
  }

  async function handleDeleteView() {
    const view = feedViewStore.activeFilteredView;
    if (!view || view.id == null) return;
    if (!confirm('Are you sure you want to delete this channel?')) return;
    await filteredViewsStore.remove(view.id);
    goto(FEEDS_PATH);
  }

  let canSave = $derived(isEditingView ? feedViewStore.hasUnsavedChanges : ef.sourceMode !== 'all');

  async function handleSave() {
    if (isEditingView) {
      feedViewStore.syncToolbarToSavedView();
      return;
    }
    if (saving) return;

    // Save means saved: write the channel now under a generated name, then open
    // that name for editing so it can be changed without a second trip.
    saving = true;
    try {
      const uuid = await filteredViewsStore.create({
        name: autoChannelName(),
        sourceMode: ef.sourceMode,
        sourceKeys: [...ef.sourceKeys],
        readFilter: feedViewStore.showOnlyUnread ? 'unread' : 'all',
        sortOrder: feedViewStore.currentSortOrder,
        tagFilter: activeTagFilter.length > 0 ? [...activeTagFilter] : undefined,
      });
      const created = filteredViewsStore.getByUuid(uuid);
      await goto(channelPath(uuid));
      beginRename(created);
    } finally {
      saving = false;
    }
  }
</script>

<div class="filter-toolbar">
  <div class="menu-heading" id="{uid}-sort">Sort</div>
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div role="radiogroup" aria-labelledby="{uid}-sort" onkeydown={onRadioKeydown}>
    {#each sortOptions as opt (opt.value)}
      {@const checked = sortOrder === opt.value}
      <button
        class="menu-row"
        role="radio"
        aria-checked={checked}
        tabindex={checked ? 0 : -1}
        onclick={() => pickSort(opt.value)}
      >
        <span class="row-icon" class:on={checked}><Icon name={opt.icon} size={18} /></span>
        <span class="row-label">{opt.label}</span>
        <span class="row-check" aria-hidden="true">
          {#if checked}<Icon name="check" size={16} />{/if}
        </span>
      </button>
    {/each}
  </div>

  <!-- Your own linkblog always shows everything, so no read/unread choice. -->
  {#if !feedViewStore.myLinkblogFilter}
    <div class="menu-heading" id="{uid}-show">Show</div>
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div role="radiogroup" aria-labelledby="{uid}-show" onkeydown={onRadioKeydown}>
      {#each READ_OPTIONS as opt (opt.label)}
        {@const checked = feedViewStore.showOnlyUnread === opt.unread}
        <button
          class="menu-row"
          role="radio"
          aria-checked={checked}
          tabindex={checked ? 0 : -1}
          onclick={() => feedViewStore.setShowOnlyUnread(opt.unread)}
        >
          <span class="row-icon" class:on={checked}><Icon name={opt.icon} size={18} /></span>
          <span class="row-label">{opt.label}</span>
          <span class="row-check" aria-hidden="true">
            {#if checked}<Icon name="check" size={16} />{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  {#if isEditingView && onEditChannel}
    <div class="menu-rule"></div>
    {#if showRenameInput}
      {@render renameField()}
    {:else}
      <button
        class="menu-row"
        onclick={() => {
          const id = feedViewStore.activeFilteredView?.id;
          if (id != null) onEditChannel(id);
        }}
      >
        <span class="row-icon"><Icon name="edit" size={18} /></span>
        <span class="row-label">Edit channel</span>
      </button>
    {/if}
  {:else}
    {#if showSourceFilter || allTags.length > 0}
      <div class="menu-rule"></div>
    {/if}

    {#if showSourceFilter}
      <button
        class="menu-row source-btn"
        class:filtered={ef.sourceMode !== 'all'}
        aria-expanded={sourcesOpen}
        bind:this={sourcesRowEl}
        onclick={() => feedViewStore.setSourcePopoverOpen(!sourcesOpen)}
      >
        <span class="row-icon" class:on={ef.sourceMode !== 'all'}
          ><Icon name="filter" size={18} /></span
        >
        <span class="row-label">Sources</span>
        <span class="row-value">{sourceSummary}</span>
        <span class="row-caret" class:open={sourcesOpen} aria-hidden="true"
          ><Icon name="chevron-down" size={14} /></span
        >
      </button>
      {#if sourcesOpen}
        <div class="menu-fold">
          <SourcePicker
            filter={{ sourceMode: ef.sourceMode, sourceKeys: ef.sourceKeys }}
            onchange={setSourceFilter}
            showFollows={showFollowsSource}
            {followsInEverything}
          />
        </div>
      {/if}
    {/if}

    {#if allTags.length > 0}
      <button
        class="menu-row tags-btn"
        class:filtered={activeTagFilter.length > 0}
        aria-expanded={tagsOpen}
        bind:this={tagsRowEl}
        onclick={() => (tagsOpen = !tagsOpen)}
      >
        <span class="row-icon" class:on={activeTagFilter.length > 0}
          ><Icon name="tag" size={18} /></span
        >
        <span class="row-label">Tags</span>
        <span class="row-value">{tagSummary}</span>
        <span class="row-caret" class:open={tagsOpen} aria-hidden="true"
          ><Icon name="chevron-down" size={14} /></span
        >
      </button>
      {#if tagsOpen}
        <div class="menu-fold tag-list">
          {#each allTags as tag (tag)}
            <label class="check-row">
              <input
                type="checkbox"
                checked={activeTagSet.has(tag)}
                onchange={() => feedViewStore.toggleToolbarTag(tag)}
              />
              <span>{tag}</span>
            </label>
          {/each}
          {#if activeTagFilter.length > 0}
            <button class="clear-btn" onclick={() => feedViewStore.clearToolbarTag()}
              >Clear tags</button
            >
          {/if}
        </div>
      {/if}
    {/if}

    <div class="menu-rule"></div>

    {#if showRenameInput}
      {@render renameField()}
    {:else}
      <div class="menu-foot">
        <button
          class="save-btn"
          class:has-changes={canSave}
          onclick={handleSave}
          disabled={saving || !canSave}
          title={isEditingView ? 'Update channel' : 'Save these filters as a new channel'}
        >
          <Icon name="save" size={16} />
          <span>{isEditingView ? 'Update' : 'Save as channel'}</span>
        </button>
        {#if isEditingView}
          <button class="foot-icon rename-btn" onclick={startRenameView} title="Rename channel">
            <Icon name="edit" size={16} />
          </button>
          <button class="foot-icon delete-btn" onclick={handleDeleteView} title="Delete channel">
            <Icon name="trash" size={16} />
          </button>
        {/if}
      </div>
    {/if}
  {/if}
</div>

{#snippet renameField()}
  <div class="save-name-input">
    <input
      use:selectOnMount
      bind:value={renameViewName}
      class="name-input"
      placeholder="Channel name"
      aria-label="Channel name"
      onkeydown={handleRenameKeydown}
      onblur={commitRenameView}
    />
    <button
      class="foot-icon save-confirm-btn"
      onclick={commitRenameView}
      disabled={!renameViewName.trim()}
      title="Confirm name"
    >
      <Icon name="check" size={16} />
    </button>
  </div>
{/snippet}

<style>
  .filter-toolbar {
    display: flex;
    flex-direction: column;
  }

  .menu-heading {
    padding: 0.375rem 0.625rem 0.25rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .menu-rule {
    height: 1px;
    margin: 0.25rem 0;
    background: var(--color-border);
  }

  /* Rows read like the Share menu's: icon, label, then a value or a check. */
  .menu-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.4375rem 0.625rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    line-height: 1.25rem;
    text-align: left;
    cursor: pointer;
  }

  .menu-row:hover,
  .menu-row:focus-visible {
    background: var(--color-bg-secondary);
    outline: none;
  }

  .row-icon {
    display: flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .row-icon.on {
    color: var(--color-primary);
  }

  .row-label {
    flex: 1;
    min-width: 0;
  }

  .row-value {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .menu-row.filtered .row-value {
    color: var(--color-primary);
  }

  .row-check {
    display: flex;
    width: 16px;
    flex-shrink: 0;
    color: var(--color-primary);
  }

  .row-caret {
    display: flex;
    color: var(--color-text-secondary);
    transition: transform 0.15s ease;
  }

  .row-caret.open {
    transform: rotate(180deg);
  }

  /* A folded-open section: inset under its row, on the menu's own surface. */
  .menu-fold {
    margin: 0.125rem 0 0.25rem;
    padding: 0.25rem 0.25rem 0.25rem 0.5rem;
    border-left: 2px solid var(--color-border);
    margin-left: 1.1rem;
  }

  .tag-list {
    display: flex;
    flex-direction: column;
    max-height: min(240px, 40vh);
    overflow-y: auto;
  }

  .check-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: 6px;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .check-row:hover {
    background: var(--color-bg-secondary);
  }

  .check-row input {
    accent-color: var(--color-primary);
  }

  .clear-btn {
    align-self: flex-start;
    margin: 0.25rem 0.5rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--color-primary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .menu-foot,
  .save-name-input {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem;
  }

  .save-btn {
    display: inline-flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.4375rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .save-btn.has-changes {
    border-color: var(--color-primary);
    background: var(--color-primary);
    color: #fff;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .foot-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .foot-icon:hover:not(:disabled) {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .delete-btn:hover:not(:disabled) {
    color: var(--color-error, #dc2626);
  }

  .foot-icon:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .name-input {
    flex: 1;
    min-width: 0;
    padding: 0.4375rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
  }

  .name-input:focus {
    border-color: var(--color-primary);
    outline: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .row-caret {
      transition: none;
    }
  }
</style>
