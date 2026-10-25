<script lang="ts">
  // The Shelf: what a reader keeps and comes back to (see stores/shelf.svelte.ts).
  // Saved is the queue; this is the reference shelf — no inbox, no archive, and
  // finishing something doesn't take it away. Collections narrow it
  // (ShelfCollectionNav; `?collection=` so a reload or a link lands on the same
  // one), a "Continue reading" row picks up what's in progress, and the
  // grid/list toggle is remembered per device.
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
  import ShelfLinkDialog from './ShelfLinkDialog.svelte';
  import ShelfCollectionNav from './ShelfCollectionNav.svelte';
  import { formatRelativeTime } from '$lib/utils/date';
  import LibraryIntro from '$lib/components/library/LibraryIntro.svelte';
  import NewConnections from '$lib/components/library/NewConnections.svelte';
  import SelectionBar from '$lib/components/library/SelectionBar.svelte';
  import { librarySelection } from '$lib/stores/librarySelection.svelte';
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import type { LaneCardVM } from '$lib/components/feed/homeLane';
  import { savedCoverUrl } from '$lib/services/api';
  import { decodeEntities } from '$lib/utils/entities';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { formatReadTime } from '$lib/utils/readTime';
  import { shelfStore, uploadsStay } from '$lib/stores/shelf.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { savedConnectionsStore } from '$lib/stores/savedConnections.svelte';
  import {
    isSavedRowArchived,
    setSavedRowArchived,
    type FeedDisplayItem,
  } from '$lib/stores/feedView.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { ownCollectionHref } from '$lib/services/rooms';
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

  // A different collection starts fresh, whatever moved the URL: the chips here,
  // the sidebar or switcher's Library children, or Back. `prevCollectionId` is a
  // plain variable so this effect doesn't track its own edge state.
  let prevCollectionId: string | null | undefined;
  $effect(() => {
    const id = collectionId;
    if (prevCollectionId !== undefined && id !== prevCollectionId) {
      sortChoice = null;
      editing = false;
      linkOpen = false;
      loadedCount = PAGE_SIZE;
      librarySelection.end();
    }
    prevCollectionId = id;
  });

  // --- Select mode (bulk add to / remove from a collection) ---
  let canSelect = $derived(librarySelection.available);
  let selecting = $derived(librarySelection.active);

  // Leaving the Shelf ends the selection, so the Queue doesn't open in it.
  $effect(() => () => librarySelection.end());

  function selectCollection(id: string | null) {
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
      connectedAt: savedConnectionsStore.latestAt(save.rkey),
    };
  }

  let baseSaves = $derived(collection ? shelfStore.itemsIn(collection.id) : shelfStore.items);
  let allEntries = $derived(baseSaves.map(entryFor));
  let entries = $derived(sortShelf(filterShelf(allEntries, kind, query), sort));
  let entrySaves = $derived(entries.map((e) => e.save));
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

  // New connections: saves anywhere in the Library — Queue or Shelf — that other
  // people drew Semble connections off since the reader last looked, newest
  // first, each with who connected it to what. Semble's notification feed,
  // grouped by the thing it's about. A save leaves the lane once the reader
  // marks its connections seen.
  let connectedSaves = $derived.by(() => {
    if (collection || kind !== 'all' || query.trim()) return [];
    return savedConnectionsStore.unseenFor(savesStore.articles);
  });

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
    // A linked one: say the other side keeps its copy, so no one goes looking.
    const kept = collection.link
      ? ` The ${providerLabel(collection.link.provider)} collection stays as it is.`
      : '';
    const ok = confirm(
      `Delete the collection “${collection.name}”?\n\nIts items stay in your Library.${kept}`
    );
    if (!ok) return;
    const id = collection.id;
    selectCollection(null);
    await shelfStore.remove(id);
  }

  // --- Linked to Semble / Margin ---
  let linkOpen = $state(false);
  // Import: one of the reader's Semble/Margin collections, as a new linked one.
  let importOpen = $state(false);
  const providerLabel = (p: 'semble' | 'margin') => (p === 'semble' ? 'Semble' : 'Margin');
  // Uploads in a linked collection never go over there; say so on the line.
  let linkUploads = $derived(collection?.link ? shelfStore.linkSplit(collection.id).uploads : 0);
  let linkHref = $derived(
    collection?.link ? ownCollectionHref(collection.link.uri, auth.user) : null
  );

  // Opening a linked collection brings in what changed over there (the server
  // gates it to once a minute). Keyed on the id so it runs once per visit.
  let syncedOnOpen: string | null = null;
  $effect(() => {
    const id = collection?.link ? collection.id : null;
    if (id && id !== syncedOnOpen) {
      syncedOnOpen = id;
      void shelfStore.sync(id);
    } else if (!id) {
      syncedOnOpen = null;
    }
  });

  async function unlinkCollection() {
    if (!collection?.link) return;
    const ok = confirm(
      `Unlink “${collection.name}” from ${providerLabel(collection.link.provider)}?\n\n` +
        'Both keep what they hold now. Changes stop flowing between them.'
    );
    if (ok) await shelfStore.unlink(collection.id);
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
    void savedConnectionsStore.load();
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

  <div class="shelf-body" class:selecting>
    <!-- Select sits where the Queue's does: on the Library switch's row. -->
    <div class="library-intro-row">
      <LibraryIntro mode="shelf" />
      {#if canSelect && allEntries.length > 0}
        <button
          class="select-btn"
          aria-pressed={selecting}
          onclick={() => (selecting ? librarySelection.end() : librarySelection.start())}
          >{selecting ? 'Done' : 'Select'}</button
        >
      {/if}
    </div>

    {#if !auth.isGuest}
      <ShelfCollectionNav
        {collectionId}
        onSelect={selectCollection}
        onImport={() => (importOpen = true)}
      />
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
            {#if !collection.link}
              <button
                class="text-btn"
                onclick={() => (linkOpen = true)}
                disabled={!shelfStore.canWrite}
              >
                <Icon name="link" size={14} />
                Link to Semble or Margin
              </button>
            {/if}
          </div>
          {#if collection.description}
            <p class="collection-desc">{collection.description}</p>
          {/if}
          {#if collection.link}
            <p class="collection-link">
              <Icon name="link" size={13} />
              <span>
                Linked to
                <a href={linkHref} target="_blank" rel="noopener noreferrer"
                  >{providerLabel(collection.link.provider)}</a
                >, public.
                {#if linkUploads > 0}
                  {uploadsStay(linkUploads)} in Skyreader.
                {/if}
                {#if shelfStore.isSyncing(collection.id)}
                  Syncing…
                {:else if shelfStore.pendingIn(collection.id) > 0}
                  {shelfStore.pendingIn(collection.id)} not on {providerLabel(
                    collection.link.provider
                  )} yet.
                {:else if collection.link.syncedAt}
                  Synced {formatRelativeTime(collection.link.syncedAt)}.
                {/if}
              </span>
              <button class="text-btn" onclick={unlinkCollection} disabled={!shelfStore.canWrite}>
                Unlink
              </button>
            </p>
          {/if}
        {/if}
      </section>
      <ShelfLinkDialog open={linkOpen} {collection} onclose={() => (linkOpen = false)} />
    {/if}
    <ShelfLinkDialog
      open={importOpen}
      onclose={() => (importOpen = false)}
      onimported={(id) => {
        // The import just synced it; opening it needn't ask again.
        syncedOnOpen = id;
        selectCollection(id);
      }}
    />

    <!-- The lanes step aside in select mode: a tap there would open, not select. -->
    {#if continueItems.length > 0 && !selecting}
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

    {#if connectedSaves.length > 0 && !selecting}
      <NewConnections
        entries={connectedSaves}
        onOpen={open}
        onHover={(save) => void savesStore.prefetchContent(save.rkey)}
        onMarkSeen={(save) => savedConnectionsStore.markSeen(save.rkey)}
        onClearAll={() => savedConnectionsStore.markAllSeen()}
      />
    {/if}

    {#if allEntries.length > 0}
      <div class="controls-wrap">
        <div class="controls">
          <input
            class="search"
            type="search"
            placeholder="Title or author"
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
            <option value="connected">Recently connected</option>
            <option value="saved">Recently saved</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
          </select>
        </div>
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
          description="Books and PDFs land here when you save them. Add anything else from its ⋯ menu in your Queue."
        />
      {/if}
    {:else}
      {#if !collection && !selecting && (inProgress.length > 0 || connectedSaves.length > 0)}
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
            {selecting}
            selected={selecting && librarySelection.has(entry.save.rkey)}
            onToggleSelect={() => librarySelection.toggle(entry.save.rkey)}
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

  {#if selecting && !readerItem}
    <SelectionBar saves={entrySaves} {collection} />
  {/if}

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

  /* Same column as the Queue's .feed-page-body.library (1040px, 0.5rem top on
     desktop, 1rem inset), so the Queue | Shelf switch stays put when you flip. */
  .shelf-body {
    max-width: 1040px;
    margin: 0 auto;
    padding: 0 1rem 2rem;
  }

  @media (min-width: 1001px) {
    .shelf-body {
      padding-top: 0.5rem;
    }
  }

  /* --- Collection head --- */
  .collection-head {
    margin-bottom: 1rem;
  }

  /* A long name keeps its words whole; the buttons wrap under it instead. */
  .collection-title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
  }

  .collection-title {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    color: var(--color-text);
    overflow-wrap: break-word;
    min-width: 0;
  }

  .collection-link {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.375rem;
    margin: 0.375rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .collection-link a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
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
  /* One row when there's room (search | kinds | sort). When narrow, search and
     sort share the first row and the kinds span the second as a full-width
     segmented control, so the sort never strands on a line of its own. */
  .controls-wrap {
    container-type: inline-size;
    margin-bottom: 1rem;
  }

  .controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.5rem;
  }

  .search {
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

  .library-intro-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .select-btn {
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .select-btn:hover {
    border-color: var(--color-text-secondary);
  }

  .select-btn[aria-pressed='true'] {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  @container (max-width: 36rem) {
    .controls {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .kinds {
      grid-column: 1 / -1;
      order: 1;
      display: flex;
    }

    .kind-btn {
      flex: 1;
    }
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

  /* Room under the last item so the selection bar never sits on it. */
  .shelf-body.selecting {
    padding-bottom: 5rem;
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
    .edit-desc {
      font-size: 1rem;
    }
  }
</style>
