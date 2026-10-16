<script lang="ts">
  // The Shelf: what a reader keeps and comes back to (see stores/shelf.svelte.ts).
  // Saved is the queue; this is the reference shelf — no inbox, no archive, and
  // finishing something doesn't take it away. Collections narrow it (`?collection=`
  // so a reload or a link lands on the same one), a "Continue reading" row picks
  // up what's in progress, and the grid/list toggle is remembered per device.
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { shellToolbar } from '$lib/actions/shell-toolbar';
  import { appScrollTo } from '$lib/utils/appScroll';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import ShelfItem from './ShelfItem.svelte';
  import LibraryIntro from '$lib/components/library/LibraryIntro.svelte';
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import type { LaneCardVM } from '$lib/components/feed/homeLane';
  import { savedCoverUrl } from '$lib/services/api';
  import { decodeEntities } from '$lib/utils/entities';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { formatReadTime } from '$lib/utils/readTime';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import {
    isSavedRowArchived,
    setSavedRowArchived,
    type FeedDisplayItem,
  } from '$lib/stores/feedView.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { useScrollDirection } from '$lib/hooks/useScrollDirection.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import { savedItemLabelKeys } from '$lib/utils/savedPile';
  import {
    continueReading,
    filterShelf,
    progressFraction,
    shelfKind,
    sortShelf,
    type ShelfEntry,
    type ShelfKindFilter,
    type ShelfSort,
  } from '$lib/utils/shelf';
  import type { SavedItem } from '$lib/types';

  const VIEW_KEY = 'skyreader-shelf-view';
  const PAGE_SIZE = 60;

  function readView(): 'grid' | 'list' {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  }

  let view = $state<'grid' | 'list'>(readView());
  function setView(next: 'grid' | 'list') {
    view = next;
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private mode: the toggle still works for this visit.
    }
  }

  let collectionId = $derived(page.url.searchParams.get('collection'));
  let collection = $derived(collectionId ? shelfStore.find(collectionId) : undefined);

  let kind = $state<ShelfKindFilter>('all');
  let query = $state('');
  // A collection opens in its own order; the whole Shelf by what was read last.
  let sortChoice = $state<ShelfSort | null>(null);
  let sort = $derived<ShelfSort>(sortChoice ?? (collection ? 'collection' : 'activity'));

  function selectCollection(id: string | null) {
    sortChoice = null;
    editing = false;
    loadedCount = PAGE_SIZE;
    const url = new URL(page.url);
    url.searchParams.delete('read');
    if (id) url.searchParams.set('collection', id);
    else url.searchParams.delete('collection');
    void goto(`${url.pathname}${url.search}`, { keepFocus: true, noScroll: true });
  }

  function entryFor(save: SavedItem): ShelfEntry {
    const activity = itemLabelsStore.getReadActivity(savedItemLabelKeys(save));
    return {
      save,
      lastActivityAt: activity?.lastActivityAt ?? 0,
      progress: progressFraction(activity?.progress),
    };
  }

  let baseSaves = $derived(collection ? shelfStore.itemsIn(collection.id) : shelfStore.items);
  let allEntries = $derived(baseSaves.map(entryFor));
  let entries = $derived(sortShelf(filterShelf(allEntries, kind, query), sort));
  let inProgress = $derived(
    !collection && kind === 'all' && !query.trim() ? continueReading(allEntries) : []
  );
  let filtering = $derived(kind !== 'all' || query.trim().length > 0);

  // Continue reading as a Home-style lane: one swipeable row of tiles instead of a
  // stack of full-width cards pushing the Shelf itself below the fold on a phone.
  // A book or PDF is credited to its author; an article to its site.
  const WORDS_PER_MIN = 200;
  let inProgressByKey = $derived(new Map(inProgress.map((e) => [e.save.rkey, e])));
  let continueItems = $derived(
    inProgress.map((entry): LaneCardVM => {
      const save = entry.save;
      const isArticle = shelfKind(save) === 'article';
      const fraction = entry.progress ?? 0;
      const totalMin = save.wordCount
        ? Math.max(1, Math.round(save.wordCount / WORDS_PER_MIN))
        : null;
      return {
        key: save.rkey,
        title: decodeEntities(save.title || '') || save.url || 'Untitled',
        domain: (isArticle ? save.domain || save.author : save.author) || null,
        image: savedCoverUrl(save),
        faviconUrl: isArticle && save.url ? getFaviconUrl(save.url) : '',
        metaLabel: totalMin
          ? `${formatReadTime(Math.max(1, Math.round(totalMin * (1 - fraction))))} left`
          : `${Math.round(fraction * 100)}% read`,
        progress: fraction,
      };
    })
  );

  let loadedCount = $state(PAGE_SIZE);
  let displayed = $derived(entries.slice(0, loadedCount));

  function highlightCount(save: SavedItem): number {
    return itemLabelsStore.getHighlights(savedItemLabelKeys(save)[0] ?? save.rkey).length;
  }

  // --- Reader ---
  const reader = useReaderStack();
  let readerItem = $derived(reader.readerItem);

  function displayItemFor(save: SavedItem): FeedDisplayItem {
    return { type: 'saved', item: save, key: save.uri || save.itemGuid || save.rkey };
  }

  function open(save: SavedItem) {
    reader.openReader(displayItemFor(save));
  }

  // Same as the Queue and Home: Archive toggles, and closes the reader. Here the
  // save stays on the Shelf behind it, now marked Archived.
  function handleReaderArchive() {
    if (!readerItem) return;
    const item = readerItem;
    reader.closeReader();
    void setSavedRowArchived(item, !isSavedRowArchived(item));
  }

  function handleReaderRemove() {
    if (readerItem?.type !== 'saved') return;
    const rkey = readerItem.item.rkey;
    reader.closeReader();
    void savesStore.remove(rkey);
  }

  // --- Collections ---
  let creating = $state(false);
  let newName = $state('');

  async function submitNew(e: SubmitEvent) {
    e.preventDefault();
    const id = await shelfStore.create(newName);
    if (id) {
      newName = '';
      creating = false;
      selectCollection(id);
    }
  }

  let editing = $state(false);
  let editName = $state('');
  let editDescription = $state('');

  function startEdit() {
    if (!collection) return;
    editName = collection.name;
    editDescription = collection.description ?? '';
    editing = true;
  }

  async function submitEdit(e: SubmitEvent) {
    e.preventDefault();
    if (!collection) return;
    const ok = await shelfStore.update(collection.id, {
      name: editName,
      description: editDescription,
    });
    if (ok) editing = false;
  }

  async function deleteCollection() {
    if (!collection) return;
    const ok = confirm(
      `Delete the collection “${collection.name}”?\n\nIts items stay in your Library.`
    );
    if (!ok) return;
    const id = collection.id;
    selectCollection(null);
    await shelfStore.remove(id);
  }

  // A link to a collection that's gone (deleted on another device) drops back
  // to the whole Shelf once collections have loaded.
  $effect(() => {
    if (collectionId && !collection && !shelfStore.loading && shelfStore.collections.length) {
      selectCollection(null);
    }
  });

  $effect(() => {
    void shelfStore.load();
  });

  // --- Mobile chrome, matching the other top-level pages ---
  const scrollDirection = useScrollDirection();
  let feedSwitcherOpen = $state(false);
  let notifSheetOpen = $state(false);

  function handleCreateChannel(type: 'feed' | 'saved' = 'feed') {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(null, type);
  }

  function handleEditChannel(id: number) {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(id);
  }

  const KIND_OPTIONS: { value: ShelfKindFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'book', label: 'Books' },
    { value: 'pdf', label: 'PDFs' },
    { value: 'article', label: 'Articles' },
  ];
</script>

<div class="shelf-page">
  <header class="shelf-header" use:shellToolbar>
    <div class="header-inner">
      <NavigationDropdown currentTitle="Shelf" />
      <div class="view-toggle" role="group" aria-label="Layout">
        <button
          class="icon-btn"
          class:active={view === 'grid'}
          aria-pressed={view === 'grid'}
          aria-label="Covers"
          onclick={() => setView('grid')}
        >
          <Icon name="grid" size={16} />
        </button>
        <button
          class="icon-btn"
          class:active={view === 'list'}
          aria-pressed={view === 'list'}
          aria-label="List"
          onclick={() => setView('list')}
        >
          <Icon name="list" size={16} />
        </button>
      </div>
    </div>
  </header>

  <div class="shelf-body">
    <LibraryIntro mode="shelf" />

    {#if !auth.isGuest}
      <nav class="collections" aria-label="Collections">
        <button class="chip" class:active={!collectionId} onclick={() => selectCollection(null)}>
          Everything
          <span class="chip-count">{shelfStore.items.length}</span>
        </button>
        {#each shelfStore.collections as c (c.id)}
          <button
            class="chip"
            class:active={collectionId === c.id}
            onclick={() => selectCollection(c.id)}
          >
            {c.name}
            <span class="chip-count">{c.items.length}</span>
          </button>
        {/each}
        {#if creating}
          <form class="chip-form" onsubmit={submitNew}>
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="chip-input"
              type="text"
              placeholder="Collection name"
              maxlength="100"
              bind:value={newName}
              autofocus
              onkeydown={(e) => {
                if (e.key === 'Escape') {
                  creating = false;
                  newName = '';
                }
              }}
            />
            <button type="submit" class="chip-submit" disabled={!newName.trim()}>Create</button>
          </form>
        {:else}
          <button
            class="chip chip-new"
            onclick={() => (creating = true)}
            disabled={!shelfStore.canWrite}
          >
            <Icon name="plus" size={12} strokeWidth={2} />
            New collection
          </button>
        {/if}
      </nav>
    {/if}

    {#if collection}
      <section class="collection-head">
        {#if editing}
          <form class="edit-form" onsubmit={submitEdit}>
            <input
              class="edit-name"
              type="text"
              maxlength="100"
              bind:value={editName}
              aria-label="Collection name"
            />
            <textarea
              class="edit-desc"
              rows="2"
              maxlength="1000"
              placeholder="What's this collection for? (optional)"
              bind:value={editDescription}
              aria-label="Description"></textarea>
            <div class="edit-actions">
              <button type="button" class="text-btn danger" onclick={deleteCollection}>
                Delete collection
              </button>
              <span class="spacer"></span>
              <button type="button" class="text-btn" onclick={() => (editing = false)}>
                Cancel
              </button>
              <button type="submit" class="primary-btn" disabled={!editName.trim()}>Save</button>
            </div>
          </form>
        {:else}
          <div class="collection-title-row">
            <h1 class="collection-title">{collection.name}</h1>
            <button
              class="text-btn"
              onclick={startEdit}
              disabled={!shelfStore.canWrite}
              aria-label="Edit collection"
            >
              <Icon name="edit" size={14} />
              Edit
            </button>
          </div>
          {#if collection.description}
            <p class="collection-desc">{collection.description}</p>
          {/if}
        {/if}
      </section>
    {/if}

    {#if continueItems.length > 0}
      <HomeLane
        title="Continue reading"
        icon="clock"
        items={continueItems}
        onOpen={(vm) => {
          const entry = inProgressByKey.get(vm.key);
          if (entry) open(entry.save);
        }}
        onHover={(vm) => void savesStore.prefetchContent(vm.key)}
      />
    {/if}

    {#if allEntries.length > 0}
      <div class="controls">
        <input
          class="search"
          type="search"
          placeholder="Filter by title or author"
          bind:value={query}
          aria-label="Filter the Shelf"
        />
        <div class="kinds" role="group" aria-label="Kind">
          {#each KIND_OPTIONS as option (option.value)}
            <button
              class="kind-btn"
              class:active={kind === option.value}
              aria-pressed={kind === option.value}
              onclick={() => (kind = option.value)}>{option.label}</button
            >
          {/each}
        </div>
        <select
          class="sort"
          aria-label="Sort"
          value={sort}
          onchange={(e) => (sortChoice = e.currentTarget.value as ShelfSort)}
        >
          {#if collection}<option value="collection">Collection order</option>{/if}
          <option value="activity">Recently read</option>
          <option value="saved">Recently saved</option>
          <option value="title">Title</option>
          <option value="author">Author</option>
        </select>
      </div>
    {/if}

    {#if entries.length === 0}
      {#if filtering}
        <EmptyState title="Nothing matches" description="Try another word, or show every kind." />
      {:else if collection}
        <EmptyState
          title="This collection is empty"
          description="Add to it from any item's ⋯ menu, here or in your Queue."
        />
      {:else}
        <EmptyState
          title="Your Shelf is empty"
          description="Books and PDFs land here when you save them. Keep anything else from its ⋯ menu in your Queue."
        />
      {/if}
    {:else}
      {#if !collection && inProgress.length > 0}
        <h2 class="section-label">Everything</h2>
      {/if}
      <div class={view === 'grid' ? 'grid' : 'list'}>
        {#each displayed as entry, index (entry.save.rkey)}
          <ShelfItem
            {entry}
            {view}
            highlightCount={highlightCount(entry.save)}
            collectionId={collection?.id ?? null}
            reorderable={sort === 'collection' && !filtering}
            isFirst={index === 0}
            isLast={index === entries.length - 1}
            onOpen={() => open(entry.save)}
            onToggleArchive={(archived) =>
              void setSavedRowArchived(displayItemFor(entry.save), archived)}
          />
        {/each}
      </div>
      <InfiniteScrollSentinel
        hasMore={loadedCount < entries.length}
        isLoading={false}
        onLoadMore={() => (loadedCount += PAGE_SIZE)}
      />
    {/if}
  </div>

  {#if mobileStore.isMobile && !readerItem}
    <MobileBottomBar
      controlsVisible={scrollDirection.controlsVisible}
      currentTitle="Shelf"
      onScrollToTop={() => appScrollTo({ top: 0, behavior: 'smooth' })}
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
        currentTitle="Shelf"
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
  <SavedReader
    {readerItem}
    onClose={reader.closeReader}
    onArchive={handleReaderArchive}
    onRemove={handleReaderRemove}
  />
{/if}

<style>
  .shelf-page {
    width: 100%;
  }

  .shelf-header {
    background: transparent;
  }

  @media (max-width: 1000px) {
    .shelf-header {
      display: none;
    }

    .shelf-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }

  .header-inner {
    min-height: var(--shell-bar-height);
    padding: 0.25rem var(--shell-bar-inset);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .view-toggle {
    display: inline-flex;
    gap: 0.125rem;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .icon-btn:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .icon-btn.active {
    color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  /* Same column as the Queue's .feed-page-body (800px, 0.5rem top on desktop,
     1rem inset), so the Queue | Shelf switch stays put when you flip between them. */
  .shelf-body {
    max-width: 800px;
    margin: 0 auto;
    padding: 0 1rem 2rem;
  }

  @media (min-width: 1001px) {
    .shelf-body {
      padding-top: 0.5rem;
    }
  }

  /* --- Collections --- */
  .collections {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-bottom: 1rem;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 32px;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
    max-width: 100%;
  }

  .chip:hover:not(:disabled) {
    border-color: var(--color-text-secondary);
  }

  .chip.active {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }

  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .chip-count {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .chip.active .chip-count {
    color: var(--color-primary);
  }

  .chip-new {
    color: var(--color-text-secondary);
    border-style: dashed;
  }

  .chip-form {
    display: inline-flex;
    gap: 0.375rem;
  }

  .chip-input {
    min-height: 32px;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--color-primary);
    border-radius: 999px;
    font-size: var(--text-sm);
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
    width: 12rem;
    max-width: 60vw;
  }

  .chip-submit {
    min-height: 32px;
    padding: 0.25rem 0.75rem;
    border: none;
    border-radius: 999px;
    background: var(--color-primary);
    color: #fff;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .chip-submit:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* --- Collection head --- */
  .collection-head {
    margin-bottom: 1rem;
  }

  .collection-title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .collection-title {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    color: var(--color-text);
    overflow-wrap: anywhere;
  }

  .collection-desc {
    margin: 0.375rem 0 0;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
    white-space: pre-line;
  }

  .edit-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .edit-name,
  .edit-desc,
  .search {
    padding: 0.45rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
  }

  .sort {
    padding-top: 0.45rem;
    padding-bottom: 0.45rem;
    font-size: var(--text-md);
  }

  .edit-name {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
  }

  .edit-desc {
    resize: vertical;
  }

  .edit-name:focus,
  .edit-desc:focus,
  .search:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .edit-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .spacer {
    flex: 1;
  }

  .text-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .text-btn:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .text-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .text-btn.danger {
    color: var(--color-error);
  }

  .primary-btn {
    padding: 0.375rem 0.875rem;
    border: none;
    border-radius: 6px;
    background: var(--color-primary);
    color: #fff;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* --- Section labels --- */
  .section-label {
    margin: 0 0 0.5rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  /* --- Controls --- */
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .search {
    flex: 1 1 14rem;
    min-width: 0;
  }

  .kinds {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }

  .kind-btn {
    padding: 0.4rem 0.625rem;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .kind-btn + .kind-btn {
    border-left: 1px solid var(--color-border);
  }

  .kind-btn.active {
    color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  /* --- Items --- */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 1.25rem 1rem;
  }

  .list {
    display: flex;
    flex-direction: column;
  }

  @media (max-width: 480px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1rem 0.75rem;
    }
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .search,
    .sort,
    .edit-name,
    .edit-desc,
    .chip-input {
      font-size: 1rem;
    }
  }
</style>
