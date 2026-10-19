<script lang="ts">
  // The one place a reader says where items come from — the toolbar's Sources
  // popover, the mobile filter sheet and both channel editors all render this.
  // Every row is checked when the filter shows it; unchecking hides it, "only"
  // shows just it. The model lives in utils/sourceFilter.ts.
  import Icon, { type IconName } from '$lib/components/Icon.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { LIBRARY_SOURCES, type LibrarySource, type Subscription } from '$lib/types';
  import { FOLLOWS_SOURCE_KEY, subscriptionSourceKey } from '$lib/utils/sourceKeys';
  import { filterSubscriptionsBySearch, subscriptionIconUrl } from '$lib/utils/subscriptionDisplay';
  import {
    GROUP_BOOKMARKS,
    GROUP_LABELS,
    GROUP_LIKES,
    GROUP_NEWSLETTERS,
    GROUP_PUBLICATIONS,
    buildSourceGroups,
    categoryGroupKey,
    checkStateOf,
    everySourceFilter,
    onlySource,
    setSourceChecked,
    showsNoSource,
    sourceGroupOf,
    type CheckState,
    type PickerContext,
    type SourceFilter,
  } from '$lib/utils/sourceFilter';

  interface Props {
    filter: SourceFilter;
    onchange: (filter: SourceFilter) => void;
    /** Offer your follows' links (signed in, with the Following-timeline scope). */
    showFollows: boolean;
    /** Whether Everything carries your follows' links (the account setting). */
    followsInEverything: boolean;
    /** Cap the list's height and scroll inside it (a popover); otherwise it grows. */
    scroll?: boolean;
    /** Offer Select all and Select none (a channel's sources) in place of Show everything. */
    bulk?: boolean;
    /** A channel's Library sources; with `onlibrarychange`, the Library rows show. */
    library?: LibrarySource[];
    onlibrarychange?: (library: LibrarySource[]) => void;
  }

  let {
    filter,
    onchange,
    showFollows,
    followsInEverything,
    scroll = false,
    bulk = false,
    library = [],
    onlibrarychange,
  }: Props = $props();

  const LIBRARY_LABELS: Record<LibrarySource, { label: string; icon: IconName }> = {
    saves: { label: 'Your saves', icon: 'bookmark' },
    shelf: { label: 'Your Shelf', icon: 'shelf' },
  };

  function toggleLibrary(source: LibrarySource) {
    onlibrarychange?.(
      library.includes(source) ? library.filter((s) => s !== source) : [...library, source]
    );
  }

  let everySource = $derived(everySourceFilter(showFollows, followsInEverything));
  let allChecked = $derived(
    filter.sourceMode === everySource.sourceMode &&
      filter.sourceKeys.length === 0 &&
      (!onlibrarychange || LIBRARY_SOURCES.every((s) => library.includes(s)))
  );

  let search = $state('');
  let expanded = $state<Set<string>>(new Set());

  let subscriptions = $derived(subscriptionsStore.subscriptions);
  let groups = $derived(buildSourceGroups(subscriptions));
  let ctx = $derived<PickerContext>({ groups, followsInEverything });
  let noneChecked = $derived(
    bulk && showsNoSource(filter, subscriptions, ctx, showFollows) && library.length === 0
  );

  interface SourceRow {
    key: string;
    sub: Subscription;
    title: string;
  }

  function rowOf(sub: Subscription): SourceRow | null {
    const key = subscriptionSourceKey(sub);
    return key ? { key, sub, title: sub.customTitle || sub.title } : null;
  }

  function byTitle(a: SourceRow, b: SourceRow) {
    return a.title.localeCompare(b.title);
  }

  let newsletterRows = $derived(
    subscriptions
      .filter((s) => sourceGroupOf(s) === GROUP_NEWSLETTERS)
      .map(rowOf)
      .filter((r): r is SourceRow => !!r)
      .sort(byTitle)
  );

  // Publications, by the reader's own categories; the uncategorized after them.
  let publicationSections = $derived.by(() => {
    const byCategory = new Map<string, SourceRow[]>();
    const loose: SourceRow[] = [];
    for (const sub of subscriptions) {
      if (sourceGroupOf(sub) !== GROUP_PUBLICATIONS) continue;
      const row = rowOf(sub);
      if (!row) continue;
      const category = sub.category?.trim();
      if (category) {
        const list = byCategory.get(category) ?? [];
        list.push(row);
        byCategory.set(category, list);
      } else {
        loose.push(row);
      }
    }
    const categories = [...byCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => ({ name, rows: rows.sort(byTitle) }));
    return { categories, loose: loose.sort(byTitle) };
  });

  let hasLikes = $derived((groups.get(GROUP_LIKES) ?? []).length > 0);
  let hasBookmarks = $derived((groups.get(GROUP_BOOKMARKS) ?? []).length > 0);
  let blueskyRows = $derived(
    [
      hasLikes && { key: GROUP_LIKES, label: GROUP_LABELS[GROUP_LIKES], icon: 'heart' as IconName },
      hasBookmarks && {
        key: GROUP_BOOKMARKS,
        label: GROUP_LABELS[GROUP_BOOKMARKS],
        icon: 'bookmark' as IconName,
      },
      showFollows && {
        key: FOLLOWS_SOURCE_KEY,
        label: 'People you follow',
        icon: 'users' as IconName,
      },
    ].filter((r): r is { key: string; label: string; icon: IconName } => !!r)
  );

  // Searching flattens everything into one list of matches.
  let searchResults = $derived.by(() => {
    if (!search.trim()) return null;
    const q = search.trim().toLowerCase();
    const bluesky = blueskyRows.filter((r) => r.label.toLowerCase().includes(q));
    const subs = filterSubscriptionsBySearch(
      subscriptions.filter((s) => {
        const group = sourceGroupOf(s);
        return group === GROUP_PUBLICATIONS || group === GROUP_NEWSLETTERS;
      }),
      search
    )
      .map(rowOf)
      .filter((r): r is SourceRow => !!r);
    return { bluesky, subs };
  });

  let totalRows = $derived(
    blueskyRows.length +
      newsletterRows.length +
      publicationSections.loose.length +
      publicationSections.categories.reduce((n, c) => n + c.rows.length, 0)
  );

  function stateOf(item: string | readonly string[]): CheckState {
    return checkStateOf(filter, item, ctx);
  }

  function toggle(item: string | readonly string[]) {
    onchange(setSourceChecked(filter, item, stateOf(item) !== 'on', ctx));
  }

  function only(item: string | readonly string[]) {
    onchange(onlySource(item));
    onlibrarychange?.([]);
  }

  function toggleExpanded(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  /** A checkbox that also shows "some" (a group partly hidden). */
  function checkState(node: HTMLInputElement, state: CheckState) {
    const apply = (s: CheckState) => {
      node.checked = s === 'on';
      node.indeterminate = s === 'some';
    };
    apply(state);
    return { update: apply };
  }
</script>

{#snippet row(
  item: string | readonly string[],
  label: string,
  opts: {
    icon?: IconName;
    iconUrl?: string;
    count?: number;
    indent?: number;
    expandId?: string;
    strong?: boolean;
    /** No icon slot (a folder). */
    bare?: boolean;
  } = {}
)}
  {@const state = stateOf(item)}
  <div class="source-row" class:strong={opts.strong} style:--indent={opts.indent ?? 0}>
    {#if opts.expandId}
      <button
        type="button"
        class="expand-btn"
        aria-label={expanded.has(opts.expandId) ? `Collapse ${label}` : `Expand ${label}`}
        aria-expanded={expanded.has(opts.expandId)}
        onclick={() => toggleExpanded(opts.expandId!)}
      >
        <Icon name={expanded.has(opts.expandId) ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
    {:else}
      <span class="expand-btn" aria-hidden="true"></span>
    {/if}
    <label class="source-check">
      <input type="checkbox" use:checkState={state} onchange={() => toggle(item)} />
      {#if opts.iconUrl}
        <img src={opts.iconUrl} alt="" class="source-icon" />
      {:else if opts.icon}
        <Icon name={opts.icon} size={16} />
      {:else if !opts.bare}
        <span class="source-icon" aria-hidden="true"></span>
      {/if}
      <span class="source-label">{label}</span>
      {#if opts.count != null}
        <span class="source-count">{opts.count}</span>
      {/if}
    </label>
    <button
      type="button"
      class="only-btn"
      title={`Show only ${label}`}
      aria-label={`Show only ${label}`}
      onclick={() => only(item)}>only</button
    >
  </div>
{/snippet}

{#snippet subRow(r: SourceRow, indent: number)}
  {@render row(r.key, r.title, {
    iconUrl: subscriptionIconUrl(r.sub) || undefined,
    icon: sourceGroupOf(r.sub) === GROUP_NEWSLETTERS ? 'mail' : 'rss',
    indent,
  })}
{/snippet}

<div class="source-picker">
  <div class="picker-top">
    {#if totalRows > 6}
      <input
        type="text"
        class="picker-search"
        placeholder="Search sources…"
        aria-label="Search sources"
        bind:value={search}
      />
    {/if}
    {#if bulk}
      <span class="bulk-btns">
        <button
          type="button"
          class="show-all-btn"
          disabled={allChecked}
          onclick={() => {
            onchange(everySource);
            onlibrarychange?.([...LIBRARY_SOURCES]);
          }}>Select all</button
        >
        <button
          type="button"
          class="show-all-btn"
          disabled={noneChecked}
          onclick={() => {
            onchange({ sourceMode: 'include', sourceKeys: [] });
            onlibrarychange?.([]);
          }}>Select none</button
        >
      </span>
    {:else if filter.sourceMode !== 'all'}
      <button
        type="button"
        class="show-all-btn"
        onclick={() => onchange({ sourceMode: 'all', sourceKeys: [] })}>Show everything</button
      >
    {/if}
  </div>

  <div class="picker-list" class:scroll>
    {#if searchResults}
      {#each searchResults.bluesky as r (r.key)}
        {@render row(r.key, r.label, { icon: r.icon })}
      {/each}
      {#each searchResults.subs as r (r.key)}
        {@render subRow(r, 0)}
      {/each}
      {#if searchResults.bluesky.length === 0 && searchResults.subs.length === 0}
        <div class="no-results">No sources match</div>
      {/if}
    {:else}
      {#if onlibrarychange}
        <div class="section-label">From your Library</div>
        {#each LIBRARY_SOURCES as source (source)}
          {@const meta = LIBRARY_LABELS[source]}
          <div class="source-row" style:--indent={0}>
            <span class="expand-btn" aria-hidden="true"></span>
            <label class="source-check">
              <input
                type="checkbox"
                checked={library.includes(source)}
                onchange={() => toggleLibrary(source)}
              />
              <Icon name={meta.icon} size={16} />
              <span class="source-label">{meta.label}</span>
            </label>
            <button
              type="button"
              class="only-btn"
              title={`Show only ${meta.label}`}
              aria-label={`Show only ${meta.label}`}
              onclick={() => {
                onchange({ sourceMode: 'include', sourceKeys: [] });
                onlibrarychange([source]);
              }}>only</button
            >
          </div>
        {/each}
      {/if}

      {#if blueskyRows.length > 0}
        <div class="section-label">From Bluesky</div>
        {#each blueskyRows as r (r.key)}
          {@render row(r.key, r.label, { icon: r.icon })}
        {/each}
      {/if}

      {#if newsletterRows.length > 0}
        <div class="section-label">Newsletters</div>
        {@render row(GROUP_NEWSLETTERS, 'All newsletters', {
          icon: 'mail',
          count: newsletterRows.length,
          expandId: 'newsletters',
          strong: true,
        })}
        {#if expanded.has('newsletters')}
          {#each newsletterRows as r (r.key)}
            {@render subRow(r, 1)}
          {/each}
        {/if}
      {/if}

      {#if publicationSections.categories.length + publicationSections.loose.length > 0}
        <div class="section-label">Publications</div>
        {@render row(GROUP_PUBLICATIONS, 'All publications', {
          icon: 'rss',
          count:
            publicationSections.loose.length +
            publicationSections.categories.reduce((n, c) => n + c.rows.length, 0),
          strong: true,
        })}
        {#each publicationSections.categories as cat (cat.name)}
          {@render row(categoryGroupKey(cat.name), cat.name, {
            count: cat.rows.length,
            indent: 1,
            expandId: `category:${cat.name}`,
            bare: true,
          })}
          {#if expanded.has(`category:${cat.name}`)}
            {#each cat.rows as r (r.key)}
              {@render subRow(r, 2)}
            {/each}
          {/if}
        {/each}
        {#each publicationSections.loose as r (r.key)}
          {@render subRow(r, 1)}
        {/each}
      {/if}

      {#if totalRows === 0}
        <div class="no-results">No sources yet</div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .source-picker {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .picker-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
  }

  .picker-top:empty {
    display: none;
  }

  .picker-search {
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--text-xs);
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
    box-sizing: border-box;
  }

  .picker-search:focus {
    border-color: var(--color-primary);
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .picker-search {
      font-size: 1rem;
    }
  }

  .show-all-btn {
    margin-left: auto;
    background: none;
    border: none;
    padding: 0.125rem 0;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    cursor: pointer;
    white-space: nowrap;
  }

  .show-all-btn:hover:not(:disabled) {
    text-decoration: underline;
  }

  .show-all-btn:disabled {
    color: var(--color-text-secondary);
    opacity: 0.6;
    cursor: default;
  }

  .bulk-btns {
    display: flex;
    gap: 0.75rem;
    margin-left: auto;
  }

  .bulk-btns .show-all-btn {
    margin-left: 0;
  }

  .picker-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 0.375rem 0.375rem;
  }

  .picker-list.scroll {
    max-height: min(360px, 60vh);
    overflow-y: auto;
  }

  .section-label {
    padding: 0.5rem 0.375rem 0.125rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
  }

  .source-row {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding-left: calc(var(--indent) * 1.25rem);
    border-radius: 4px;
  }

  .source-row:hover {
    background: var(--color-bg-secondary);
  }

  .expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    margin-left: -0.125rem;
    padding: 0;
    background: none;
    border: none;
    border-radius: 3px;
    color: var(--color-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
  }

  .source-check {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.375rem;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .strong .source-label {
    font-weight: var(--weight-medium);
  }

  .source-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-count {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .source-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 2px;
  }

  .only-btn {
    flex-shrink: 0;
    padding: 0.125rem 0.375rem;
    background: none;
    border: none;
    border-radius: 3px;
    font-size: var(--text-xs);
    color: var(--color-primary);
    cursor: pointer;
    opacity: 0;
  }

  .source-row:hover .only-btn,
  .only-btn:focus-visible {
    opacity: 1;
  }

  .only-btn:hover {
    text-decoration: underline;
  }

  /* No hover on touch: keep "only" in view, quieter since every row has one,
     and make each row a finger-sized target. */
  @media (hover: none) {
    .only-btn {
      opacity: 1;
      color: var(--color-text-secondary);
    }
  }

  @media (hover: none) and (pointer: coarse) {
    .source-check {
      min-height: 44px;
      padding: 0 0.375rem;
      font-size: var(--text-base);
    }

    .source-check input {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
    }

    .expand-btn {
      width: 24px;
      height: 44px;
    }

    .only-btn {
      min-height: 44px;
      padding: 0 0.625rem;
      font-size: var(--text-sm);
    }

    .source-row {
      padding-left: calc(var(--indent) * 1rem);
    }

    .source-row:hover {
      background: none;
    }
  }

  .no-results {
    padding: 0.5rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    text-align: center;
  }
</style>
