<script lang="ts">
  import { onMount } from 'svelte';
  import { goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { shellToolbar } from '$lib/actions/shell-toolbar';
  import { appScrollTo } from '$lib/utils/appScroll';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import { searchStore } from '$lib/stores/search.svelte';
  import { savedSearchStore } from '$lib/stores/savedSearch.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { useScrollDirection } from '$lib/hooks/useScrollDirection.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import { formatRelativeTime } from '$lib/utils/date';
  import { domainFromUrl } from '$lib/utils/highlightSource';
  import {
    canUseSearch,
    formatResultCount,
    lastTouched,
    resolveSearchHit,
  } from '$lib/utils/search';
  import type { SearchHit, SearchKind } from '$lib/services/api';

  const KINDS: { value: SearchKind | null; label: string }[] = [
    { value: null, label: 'Everything' },
    { value: 'saved', label: 'Saved' },
    { value: 'highlighted', label: 'Highlighted' },
    { value: 'read', label: 'Read' },
  ];

  let available = $derived(canUseSearch(auth.user));
  let online = $derived(syncStore.isOnline);

  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLOListElement | null>(null);

  const reader = useReaderStack();
  let readerItem = $derived(reader.readerItem);

  // The query lives in the URL (?q=, ?kind=) so a search is reloadable and Back
  // returns to it. Restored once on mount; written back as the reader types.
  onMount(() => {
    searchStore.setSurfaceActive(true);
    const q = page.url.searchParams.get('q') ?? '';
    const kind = page.url.searchParams.get('kind') as SearchKind | null;
    if (available && kind && KINDS.some((k) => k.value === kind)) searchStore.setKind(kind);
    if (available && q && q !== searchStore.query) {
      searchStore.setQuery(q);
      searchStore.submit();
    }
    inputEl?.focus();
    return () => searchStore.setSurfaceActive(false);
  });

  // `/` from anywhere bumps focusRequest; take focus on each bump.
  $effect(() => {
    const _ = searchStore.focusRequest;
    inputEl?.focus();
    inputEl?.select();
  });

  $effect(() => {
    const q = searchStore.query.trim();
    const kind = searchStore.kind;
    // Leave the URL alone while the reader is open: it owns `?read=` and the
    // history entries above this one.
    if (readerItem) return;
    const url = new URL(page.url);
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    if (kind) url.searchParams.set('kind', kind);
    else url.searchParams.delete('kind');
    if (url.search !== page.url.search) replaceState(url, page.state);
  });

  function openHit(hit: SearchHit) {
    const item = resolveSearchHit(hit, {
      saves: savesStore.articles,
      getArticle: (guid) => articlesStore.getByGuid(guid),
      documents: socialStore.documents,
      subscriptionIdFor: (feedUrl) =>
        subscriptionsStore.subscriptions.find((s) => s.feedUrl === feedUrl)?.id,
    });
    if (item) reader.openReader(item);
    else if (hit.url) window.open(hit.url, '_blank', 'noopener,noreferrer');
  }

  // Offline the server index is out of reach; Saved search runs on this device.
  async function searchSavedOnDevice() {
    const q = searchStore.query;
    await goto('/saved');
    savedSearchStore.setQuery(q);
    savedSearchStore.openSearch();
  }

  function handleInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchStore.submit();
    } else if (e.key === 'ArrowDown' && searchStore.results.length > 0) {
      e.preventDefault();
      listEl?.querySelector<HTMLElement>('.hit-open')?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (searchStore.query) searchStore.clear();
      else inputEl?.blur();
    }
  }

  // Arrow keys walk the results; ArrowUp from the first goes back to the input.
  function handleListKeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...(listEl?.querySelectorAll<HTMLElement>('.hit-open') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    e.preventDefault();
    const next = index + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) inputEl?.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  }

  // A hit that matched only on its title gets the title back as its snippet;
  // showing it twice says nothing.
  function showSnippet(hit: SearchHit): boolean {
    const text = hit.snippet
      .map((s) => s.text)
      .join('')
      .trim();
    return text.length > 0 && text !== hit.title.trim();
  }

  function hitMeta(hit: SearchHit): string {
    const parts: string[] = [];
    const source = hit.feedTitle || domainFromUrl(hit.url);
    if (source) parts.push(source);
    const touched = lastTouched(hit);
    if (touched) parts.push(`${touched.verb} ${formatRelativeTime(touched.at)}`);
    return parts.join(' · ');
  }

  let showResults = $derived(
    available && online && Boolean(searchStore.query.trim()) && !searchStore.error
  );
  let noHits = $derived(
    showResults &&
      !searchStore.loading &&
      searchStore.answeredQuery === searchStore.query.trim() &&
      searchStore.results.length === 0
  );

  // --- Mobile chrome (floating bottom bar + sheets), matching the feed page ---
  const scrollDirection = useScrollDirection();
  let feedSwitcherOpen = $state(false);
  let notifSheetOpen = $state(false);

  function scrollToTop() {
    appScrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleCreateChannel(type: 'feed' | 'saved' = 'feed') {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(null, type);
  }

  function handleEditChannel(id: number) {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(id);
  }
</script>

<div class="search-page">
  <header class="search-header" use:shellToolbar>
    <div class="header-inner">
      <NavigationDropdown currentTitle="Search" />
    </div>
  </header>

  <div class="search-body">
    {#if !available}
      <section class="notice">
        <h2>Find anything you’ve read</h2>
        <p>
          Search everything you’ve read, saved and highlighted, and your notes. It’s part of
          Supporter.
        </p>
        <p class="notice-actions">
          <a class="text-link" href="/supporter">About Supporter</a>
          <span class="dot">·</span>
          <button class="text-link" onclick={searchSavedOnDevice}>Search your saved items</button>
        </p>
      </section>
    {:else}
      <div class="search-field">
        <Icon name="search" size={18} />
        <input
          bind:this={inputEl}
          type="search"
          class="search-input"
          value={searchStore.query}
          oninput={(e) => searchStore.setQuery(e.currentTarget.value)}
          onkeydown={handleInputKeydown}
          placeholder="Search everything you’ve read"
          aria-label="Search everything you’ve read, saved and highlighted"
          autocomplete="off"
          spellcheck="false"
          data-testid="search-input"
        />
        {#if searchStore.query}
          <button
            class="clear-btn"
            onclick={() => {
              searchStore.clear();
              inputEl?.focus();
            }}
            aria-label="Clear search"
            title="Clear search"
          >
            <Icon name="x" size={14} />
          </button>
        {/if}
      </div>

      <div class="kinds" role="radiogroup" aria-label="Search in">
        {#each KINDS as k (k.label)}
          <button
            class="kind"
            class:active={searchStore.kind === k.value}
            role="radio"
            aria-checked={searchStore.kind === k.value}
            onclick={() => searchStore.setKind(k.value)}
          >
            {k.label}
          </button>
        {/each}
      </div>

      {#if !online}
        <p class="status">
          Search needs a connection.
          <button class="text-link" onclick={searchSavedOnDevice}>
            Search saved items on this device
          </button>
        </p>
      {:else if searchStore.error}
        <p class="status">{searchStore.error}</p>
      {:else if !searchStore.query.trim()}
        <div class="hint">
          <p>Everything you’ve read, saved or highlighted, and your notes.</p>
          <ul>
            <li><code>"exact phrase"</code> for a phrase</li>
            <li><code>climat*</code> for words starting with “climat”</li>
            <li><code>-word</code> to leave a word out</li>
          </ul>
        </div>
      {/if}

      {#if showResults}
        <p class="status" aria-live="polite">
          {#if searchStore.loading && searchStore.answeredQuery !== searchStore.query.trim()}
            Searching…
          {:else if searchStore.answeredQuery}
            {formatResultCount(searchStore.total, searchStore.totalCapped)}
          {/if}
          {#if searchStore.building}
            <span class="building">· Still indexing your history. Results will fill in.</span>
          {/if}
        </p>

        {#if noHits}
          <p class="empty">
            Nothing matches “{searchStore.answeredQuery}”{searchStore.kind
              ? ` in ${KINDS.find((k) => k.value === searchStore.kind)?.label.toLowerCase()}`
              : ''}.
          </p>
        {:else}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <ol class="hits" bind:this={listEl} onkeydown={handleListKeydown}>
            {#each searchStore.results as hit (hit.itemKey)}
              <li class="hit">
                <button class="hit-open" onclick={() => openHit(hit)}>
                  <span class="hit-title">{hit.title || domainFromUrl(hit.url) || 'Untitled'}</span>
                  {#if showSnippet(hit)}
                    <span class="hit-snippet"
                      >{#each hit.snippet as seg, i (i)}{#if seg.match}<mark>{seg.text}</mark
                          >{:else}{seg.text}{/if}{/each}</span
                    >
                  {/if}
                  <span class="hit-meta">
                    <span class="meta-text">{hitMeta(hit)}</span>
                    {#if hit.highlighted}
                      <span class="tag"><Icon name="highlighter" size={12} />Highlighted</span>
                    {:else if hit.saved}
                      <span class="tag"><Icon name="bookmark" size={12} />Saved</span>
                    {/if}
                  </span>
                </button>
              </li>
            {/each}
          </ol>

          {#if searchStore.hasMore}
            <button
              class="more-btn"
              onclick={() => searchStore.loadMore()}
              disabled={searchStore.loadingMore}
            >
              {searchStore.loadingMore ? 'Loading…' : 'More results'}
            </button>
          {/if}
        {/if}
      {/if}
    {/if}
  </div>

  {#if mobileStore.isMobile && !readerItem}
    <MobileBottomBar
      controlsVisible={scrollDirection.controlsVisible}
      currentTitle="Search"
      onScrollToTop={scrollToTop}
      onOpenFeedSwitcher={() => (feedSwitcherOpen = true)}
      onOpenNotifications={() => {
        notifSheetOpen = true;
        void notificationsStore.load();
      }}
      onOpenFilterSheet={() => {}}
      hasActiveFilters={false}
      hideFilterButton={true}
    />

    <BottomSheet
      open={feedSwitcherOpen}
      onclose={() => (feedSwitcherOpen = false)}
      title="Switch Feed"
      keepMounted
    >
      <MobileFeedSwitcher
        open={feedSwitcherOpen}
        onclose={() => (feedSwitcherOpen = false)}
        currentTitle="Search"
        onEditChannel={handleEditChannel}
        onCreateChannel={handleCreateChannel}
      />
    </BottomSheet>

    <BottomSheet
      open={notifSheetOpen}
      onclose={() => {
        notifSheetOpen = false;
        void notificationsStore.markAllSeen();
      }}
      title="Notifications"
    >
      <NotificationList onItemClick={() => (notifSheetOpen = false)} />
    </BottomSheet>
  {/if}
</div>

{#if readerItem}
  <SavedReader {readerItem} onClose={reader.closeReader} />
{/if}

<style>
  .search-page {
    width: 100%;
  }

  .search-header {
    background: transparent;
  }

  @media (max-width: 1000px) {
    .search-header {
      display: none;
    }

    .search-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }

  .header-inner {
    min-height: var(--shell-bar-height);
    padding: 0.25rem var(--shell-bar-inset);
    display: flex;
    align-items: center;
  }

  .search-body {
    max-width: 800px;
    margin: 0 auto;
    padding: 0.75rem 1rem 2rem;
  }

  /* The page's one control that matters: a quiet, full-width field. Flat — it
     sits in the page, it doesn't float over it. */
  .search-field {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0 0.875rem;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-bg);
    color: var(--color-text-secondary);
    transition: border-color 0.15s ease;
  }

  .search-field:focus-within {
    border-color: var(--color-primary);
  }

  .search-input {
    flex: 1;
    min-width: 0;
    padding: 0.75rem 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
  }

  .search-input::-webkit-search-cancel-button {
    display: none;
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .search-input {
      font-size: 1rem;
    }
  }

  .clear-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .clear-btn:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f0f0f0);
  }

  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0.75rem 0 0.25rem;
  }

  .kind {
    padding: 0.3125rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .kind:hover {
    color: var(--color-text);
  }

  .kind.active {
    color: var(--color-primary);
    border-color: var(--color-primary);
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.08));
  }

  .status,
  .empty {
    margin: 0.75rem 0.25rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .building {
    margin-left: 0.125rem;
  }

  .hint {
    margin: 1.5rem 0.25rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-relaxed, 1.6);
  }

  .hint p {
    margin: 0 0 0.5rem;
  }

  .hint ul {
    margin: 0;
    padding-left: 1.125rem;
  }

  .hint code {
    font-size: 0.95em;
    color: var(--color-text);
  }

  .notice {
    margin: 2rem 0.25rem;
    color: var(--color-text-secondary);
    line-height: var(--leading-relaxed, 1.6);
  }

  .notice h2 {
    margin: 0 0 0.5rem;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .notice p {
    margin: 0 0 0.75rem;
  }

  .notice-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  .text-link {
    padding: 0;
    border: none;
    background: none;
    color: var(--color-primary);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  .text-link:hover {
    text-decoration: underline;
  }

  .dot {
    opacity: 0.6;
  }

  .hits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  /* The text is the product: the title, then the passage that matched, then a
     quiet line of where it came from. */
  .hit-open {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
    width: 100%;
    padding: 0.875rem 1rem;
    border: none;
    border-radius: 12px;
    background: none;
    color: var(--color-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .hit-open:hover,
  .hit-open:focus-visible {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.025));
  }

  .hit-open:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .hit-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug, 1.3);
  }

  .hit-open:hover .hit-title {
    color: var(--color-primary);
  }

  .hit-snippet {
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed, 1.6);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Same yellow as a highlight in the reader, lighter: a match, not a mark the
     reader made. */
  .hit-snippet mark {
    background-color: color-mix(in srgb, #f5c518 22%, transparent);
    color: var(--color-text);
    border-radius: 1px;
  }

  .hit-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .meta-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .more-btn {
    display: block;
    margin: 1rem auto 0;
    padding: 0.5rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .more-btn:hover:not(:disabled) {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  @media (prefers-color-scheme: dark) {
    .hit-open:hover,
    .hit-open:focus-visible {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }

    .clear-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .kind.active {
      background: var(--color-sidebar-active, rgba(77, 166, 255, 0.15));
    }
  }
</style>
