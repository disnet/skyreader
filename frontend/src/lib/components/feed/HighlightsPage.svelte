<script lang="ts">
  import { marginPublishQueue } from '$lib/stores/marginPublishQueue.svelte';
  import { shellToolbar } from '$lib/actions/shell-toolbar';
  import { appScrollTo } from '$lib/utils/appScroll';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Icon, { type IconName } from '$lib/components/Icon.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import { perfBegin, PERF_SHEET_OPEN } from '$lib/utils/perfMarks';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import RemoveHighlightModal from '$lib/components/feed/RemoveHighlightModal.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { blueskyComposerStore } from '$lib/stores/blueskyComposer.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { useScrollDirection } from '$lib/hooks/useScrollDirection.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import {
    saveHighlightToMargin,
    deleteHighlight,
    updateHighlightNoteOnMargin,
  } from '$lib/services/marginHighlights';
  import { formatRelativeTime } from '$lib/utils/date';
  import { buildHighlightSourceLookups, resolveHighlightSource } from '$lib/utils/highlightSource';
  import { highlightReviewStore } from '$lib/stores/highlightReview.svelte';
  import { REVIEW_INTENT_DEFAULT } from '$lib/utils/highlightReview';
  import { maybeImportMarginHighlights } from '$lib/services/marginHighlightImport';
  import MarginSyncControl from '$lib/components/settings/MarginSyncControl.svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import HighlightTagPicker from '$lib/components/feed/HighlightTagPicker.svelte';
  import {
    EMPTY_FILTER,
    filterHighlights,
    highlightFacets,
    pinnedHighlights,
    sortHighlights,
    type HighlightFilter,
    type HighlightLibraryRow,
    type HighlightSort,
    type HighlightSourceInfo,
    type HighlightView,
  } from '$lib/utils/highlightLibrary';
  import type { ReviewIntent } from '$lib/types';

  // Set the browser-tab title while this page is mounted.
  $effect(() => {
    viewTitleStore.set('Highlights');
    return () => viewTitleStore.set('');
  });

  // Opening the list is one of the two moments we poll Margin for highlights the
  // reader made elsewhere. Minute-gated; silent when off or offline.
  //
  // Gated on the stores, exactly as the review deck is: the import unions against
  // the highlights it can see and writes the result back as the item's whole set,
  // so polling before the local read has landed would import against an empty
  // corpus and overwrite the item's existing highlights with only the imported
  // ones. The two surfaces also share one in-flight poll, so an ungated caller
  // here would defeat the deck's gate as well as its own.
  let storesReady = $derived(!itemLabelsStore.isLoading && !savesStore.loading);
  let importStarted = false;

  $effect(() => {
    if (!storesReady || importStarted) return;
    importStarted = true;
    // A partial poll says so in the sync line above the list (MarginSyncControl).
    void maybeImportMarginHighlights().catch(() => {});
  });

  // Lookups for enriching a highlight's parent item with title/url/body.
  let sourceLookups = $derived(
    buildHighlightSourceLookups(
      articlesStore.allArticles,
      socialStore.documents,
      savesStore.articles,
      subscriptionsStore.subscriptions
    )
  );

  // Every highlight as one row, carrying its source. The page is a library to
  // narrow down, not a feed to scroll, so rows stay flat; grouping by source is
  // one of the sorts.
  let rows = $derived.by((): HighlightLibraryRow[] => {
    const sources = new Map<string, HighlightSourceInfo>();
    // Highlights are written under one canonical key, but a row can briefly land
    // under the uri before saves hydrate; group by canonical key and skip ids
    // already seen so such a transient duplicate never renders twice.
    const seenIds = new Set<string>();
    const out: HighlightLibraryRow[] = [];

    for (const { itemKey, itemType, highlight } of itemLabelsStore.allHighlights) {
      if (seenIds.has(highlight.id)) continue;
      seenIds.add(highlight.id);
      const sourceKey = itemLabelsStore.canonicalKey(itemKey);
      let source = sources.get(sourceKey);
      if (!source) {
        // Imported Margin highlights may have no local article at all — the
        // resolver falls back to the metadata carried on the highlight so the
        // row still shows a title and stays openable.
        const resolved = resolveHighlightSource(sourceKey, itemType, sourceLookups, highlight);
        source = {
          itemKey: sourceKey,
          itemType,
          title: resolved.title,
          url: resolved.url,
          domain: resolved.domain,
          displayItem: resolved.displayItem,
        };
        sources.set(sourceKey, source);
      }

      out.push({
        id: highlight.id,
        text: highlight.selector.exact,
        note: highlight.note,
        createdAt: highlight.createdAt,
        pinnedAt: highlight.pinnedAt,
        tags: highlight.tags ?? [],
        isMargin: Boolean(highlight.marginUri) || marginPublishQueue.has(highlight.id),
        intent: highlight.reviewIntent ?? REVIEW_INTENT_DEFAULT,
        highlight,
        source,
      });
    }
    return out;
  });

  let facets = $derived(highlightFacets(rows));

  // Tag suggestions: the reader's highlight tags first (most used), then the
  // tags they put on articles, so one vocabulary serves both.
  let tagVocabulary = $derived([...facets.tags.map((t) => t.tag), ...itemLabelsStore.allTags]);

  // --- Filter state -----------------------------------------------------------

  let filter = $state<HighlightFilter>({ ...EMPTY_FILTER });
  let sort = $state<HighlightSort>('newest');

  const VIEWS: { id: HighlightView; label: string; icon: IconName }[] = [
    { id: 'all', label: 'All highlights', icon: 'highlighter' },
    { id: 'pinned', label: 'Pinned', icon: 'pin' },
    { id: 'notes', label: 'With notes', icon: 'message-circle' },
    { id: 'published', label: 'On Margin', icon: 'margin' },
    { id: 'not-in-review', label: 'Not in review', icon: 'circle-slash' },
  ];

  const SORTS: { id: HighlightSort; label: string }[] = [
    { id: 'newest', label: 'Newest' },
    { id: 'oldest', label: 'Oldest' },
    { id: 'source', label: 'By source' },
  ];

  // A view with nothing in it is noise in the rail — except All, and whichever
  // one is selected, so the reader never loses the control they're standing on.
  let visibleViews = $derived(
    VIEWS.filter((v) => v.id === 'all' || v.id === filter.view || facets.views[v.id] > 0)
  );

  const SOURCES_COLLAPSED = 8;
  let showAllSources = $state(false);
  let railSources = $derived(
    showAllSources ? facets.sources : facets.sources.slice(0, SOURCES_COLLAPSED)
  );

  let activeSource = $derived(
    filter.sourceKey
      ? (facets.sources.find((s) => s.source.itemKey === filter.sourceKey)?.source ?? null)
      : null
  );

  let isFiltered = $derived(
    filter.view !== 'all' ||
      filter.tag !== null ||
      activeSource !== null ||
      filter.query.trim() !== ''
  );

  function setView(view: HighlightView) {
    filter.view = view;
  }

  function toggleTagFilter(tag: string) {
    filter.tag = filter.tag?.toLowerCase() === tag.toLowerCase() ? null : tag;
  }

  function toggleSourceFilter(key: string) {
    filter.sourceKey = filter.sourceKey === key ? null : key;
  }

  function clearFilters() {
    filter = { ...EMPTY_FILTER };
  }

  // --- Results ----------------------------------------------------------------

  // A source filter whose last highlight was removed would narrow the list to
  // nothing with no chip left to say why; drop it instead.
  let matches = $derived(
    filterHighlights(rows, activeSource ? filter : { ...filter, sourceKey: null })
  );

  // Pins lead the page as their own shelf. In the Pinned view they ARE the list,
  // so there's no shelf above it.
  let pinned = $derived(filter.view === 'pinned' ? [] : pinnedHighlights(matches));
  let listed = $derived(
    sortHighlights(
      filter.view === 'pinned' ? matches : matches.filter((r) => r.pinnedAt === undefined),
      sort
    )
  );

  // Window the list and grow it as the sentinel comes into view. A new filter
  // starts the window over.
  const PAGE_SIZE = 40;
  let loadedCount = $state(PAGE_SIZE);
  let displayed = $derived(listed.slice(0, loadedCount));
  let hasMore = $derived(loadedCount < listed.length);

  $effect(() => {
    void filter.view;
    void filter.tag;
    void filter.sourceKey;
    void filter.query;
    void sort;
    loadedCount = PAGE_SIZE;
  });

  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && filter.query) {
      e.preventDefault();
      filter.query = '';
    }
  }

  // Reader overlay — the same stack every other surface uses, so /highlights gets
  // Back-to-close, scroll restore and a `?read=` URL for free.
  const reader = useReaderStack();
  let readerItem = $derived(reader.readerItem);

  function openSource(source: HighlightSourceInfo) {
    if (source.displayItem) {
      reader.openReader(source.displayItem);
    } else if (source.url) {
      window.open(source.url, '_blank', 'noopener,noreferrer');
    }
  }

  // --- Row actions --------------------------------------------------------------

  function togglePin(row: HighlightLibraryRow) {
    void itemLabelsStore.setHighlightPinned(row.source.itemKey, row.id, row.pinnedAt === undefined);
  }

  // Removing a Margin-backed highlight deletes the user's own PDS record too —
  // always confirm, so a cross-app delete can't happen on a stray tap.
  let removePrompt = $state<HighlightLibraryRow | null>(null);

  function confirmRemove() {
    const pending = removePrompt;
    removePrompt = null;
    if (!pending) return;
    void deleteHighlight(pending.source.itemKey, pending.highlight);
  }

  // Publishing is one tap now, so guard against a second tap landing while
  // the first is still in flight: that would create a second public note.
  let publishing = new SvelteSet<string>();

  function handleSaveToMargin(row: HighlightLibraryRow) {
    if (publishing.has(row.id)) return;
    publishing.add(row.id);
    void saveHighlightToMargin(
      row.source.itemKey,
      row.highlight,
      row.source.url,
      row.source.title
    ).finally(() => publishing.delete(row.id));
  }

  function handlePostToBluesky(row: HighlightLibraryRow) {
    if (!row.source.url) return;
    blueskyComposerStore.open({
      source: { url: row.source.url, title: row.source.title },
      quote: row.text,
      note: row.note,
    });
  }

  // Frequency tuning happens in the review deck, one card at a time. The list
  // is where you can see what you've set and get back out of 'never', which is
  // the only setting that hides a highlight from the deck entirely. Clearing it
  // returns to the default pace rather than to a previous 'soon'/'someday' —
  // the list reports the state, the deck is where you tune it.
  function toggleNeverReview(row: HighlightLibraryRow) {
    void itemLabelsStore.setHighlightReviewIntent(
      row.source.itemKey,
      row.id,
      row.intent === 'never' ? null : 'never'
    );
  }

  const REVIEW_INTENT_BADGE: Partial<Record<ReviewIntent, string>> = {
    soon: 'Soon',
    someday: 'Someday',
    never: 'Not in review',
  };

  // A Margin note is a record in the reader's own atproto repo, anchored on
  // the article's link, so it needs an account and a URL.
  function canPublish(row: HighlightLibraryRow): boolean {
    return !row.isMargin && Boolean(row.source.url) && !auth.isGuest;
  }

  // A pinned card has room for the pin and this menu only, so its menu also
  // carries Tag and Note, anchored on the card itself.
  function moreItems(row: HighlightLibraryRow, card: boolean) {
    const items = [];
    if (card) {
      const cardEl = () =>
        document.querySelector<HTMLElement>(`[data-pinned-card="${CSS.escape(row.id)}"]`);
      items.push({
        label: 'Tag',
        icon: 'tag',
        onclick: () => {
          const el = cardEl();
          if (el) openTagEditor(el, row);
        },
      });
      items.push({
        label: row.note ? 'Edit note' : 'Add a note',
        icon: 'message-circle',
        onclick: () => {
          const el = cardEl();
          if (el) noteEditor = { row, anchorRect: el.getBoundingClientRect() };
        },
      });
    }
    // The rail's source list isn't on narrow screens, so the menu offers it too.
    if (filter.sourceKey !== row.source.itemKey) {
      items.push({
        label: 'Only this source',
        icon: 'filter',
        onclick: () => (filter.sourceKey = row.source.itemKey),
      });
    }
    // Rows have their own Publish button; a pinned card only has room for the menu.
    if (card && canPublish(row)) {
      items.push({
        label: 'Publish to Margin',
        icon: 'margin',
        onclick: () => handleSaveToMargin(row),
      });
    }
    // Posted from the reader's own account: needs one, and a link to point at.
    if (row.source.url && !auth.isGuest) {
      items.push({
        label: 'Post to Bluesky',
        icon: 'bluesky',
        onclick: () => handlePostToBluesky(row),
      });
    }
    items.push({
      label: row.intent === 'never' ? 'Put back in review' : 'Never show in review',
      icon: 'circle-slash',
      onclick: () => toggleNeverReview(row),
    });
    items.push({
      label: 'Remove highlight',
      icon: 'trash',
      variant: 'danger' as const,
      onclick: () => (removePrompt = row),
    });
    return items;
  }

  // Note editor — a floating popover anchored to the note button, opened
  // straight into its note view. Mirrors the reader's note-editing UX.
  let noteEditor = $state<{ row: HighlightLibraryRow; anchorRect: DOMRect } | null>(null);

  function openNoteEditor(event: MouseEvent, row: HighlightLibraryRow) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    noteEditor = { row, anchorRect: rect };
  }

  function handleSaveNote(note: string) {
    if (!noteEditor) return;
    const { row } = noteEditor;
    noteEditor = null;
    void (async () => {
      await itemLabelsStore.setHighlightNote(row.source.itemKey, row.id, note);
      // Re-read so we act on the persisted note + current Margin linkage.
      const updated = itemLabelsStore
        .getHighlights(row.source.itemKey)
        .find((h) => h.id === row.id);
      if (updated?.marginRkey) {
        await updateHighlightNoteOnMargin(
          row.source.itemKey,
          updated,
          row.source.url,
          row.source.title
        );
      }
    })();
  }

  // Tag picker — anchored to the tag button (it follows it on scroll); edits
  // apply as they're made.
  let tagEditor = $state<{ itemKey: string; id: string; anchor: HTMLElement } | null>(null);
  let tagEditorRow = $derived(
    tagEditor
      ? rows.find((r) => r.id === tagEditor!.id && r.source.itemKey === tagEditor!.itemKey)
      : null
  );

  function openTagEditor(anchor: HTMLElement, row: HighlightLibraryRow) {
    tagEditor = { itemKey: row.source.itemKey, id: row.id, anchor };
  }

  function handleTagsChange(tags: string[]) {
    if (!tagEditor) return;
    void itemLabelsStore.setHighlightTags(tagEditor.itemKey, tagEditor.id, tags);
  }

  // --- Mobile chrome (floating bottom bar + sheets), matching the feed page ---
  const scrollDirection = useScrollDirection();
  let feedSwitcherOpen = $state(false);
  let notifSheetOpen = $state(false);

  function scrollToTop() {
    appScrollTo({ top: 0, behavior: 'smooth' });
  }

  // Channel create/edit from the mobile switcher routes through the always-mounted
  // sidebar modal, then navigates to the new/edited channel on the feed page.
  function handleCreateChannel(type: 'feed' | 'saved' = 'feed') {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(null, type);
  }

  function handleEditChannel(id: number) {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(id);
  }
</script>

{#snippet tagChips(row: HighlightLibraryRow)}
  {#each row.tags as tag (tag)}
    <button
      class="tag-chip"
      class:active={filter.tag?.toLowerCase() === tag.toLowerCase()}
      onclick={() => toggleTagFilter(tag)}
      title={`Show highlights tagged ${tag}`}>#{tag}</button
    >
  {/each}
{/snippet}

{#snippet rowActions(row: HighlightLibraryRow, card = false)}
  <span class="row-actions">
    <button
      class="action-btn pin-btn"
      class:on={row.pinnedAt !== undefined}
      onclick={() => togglePin(row)}
      title={row.pinnedAt !== undefined ? 'Unpin' : 'Pin to top'}
      aria-label={row.pinnedAt !== undefined ? 'Unpin' : 'Pin to top'}
      aria-pressed={row.pinnedAt !== undefined}
    >
      <Icon name="pin" size={15} />
    </button>
    {#if !card}
      <button
        class="action-btn"
        onclick={(e) => openTagEditor(e.currentTarget, row)}
        title="Tag"
        aria-label="Tag"
      >
        <Icon name="tag" size={15} />
      </button>
      <button
        class="action-btn"
        onclick={(e) => openNoteEditor(e, row)}
        title={row.note ? 'Edit note' : 'Add a note'}
        aria-label={row.note ? 'Edit note' : 'Add a note'}
      >
        <Icon name="message-circle" size={15} />
      </button>
      {#if canPublish(row)}
        <button
          class="action-btn"
          onclick={() => handleSaveToMargin(row)}
          disabled={publishing.has(row.id)}
          title="Publish to Margin (public)"
          aria-label="Publish to Margin (public)"
        >
          <Icon name="margin" size={15} />
        </button>
      {:else if row.isMargin}
        <!-- Holds Publish's place once it's done, so the buttons don't shift
             under the pointer, and says where the highlight now lives. -->
        <span class="action-btn published" title="Published on Margin">
          <Icon name="margin" size={15} />
          <span class="sr-only">Published on Margin</span>
        </span>
      {/if}
    {/if}
    <span class="more">
      <PopoverMenu items={moreItems(row, card)} />
    </span>
  </span>
{/snippet}

{#snippet rowMeta(row: HighlightLibraryRow, showSource: boolean)}
  <span class="row-meta">
    {#if showSource}
      <button class="source-link" onclick={() => openSource(row.source)} title="Open article">
        {row.source.title}
      </button>
      {#if row.source.domain}
        <span class="dot">·</span>
        <span class="domain">{row.source.domain}</span>
      {/if}
      <span class="dot">·</span>
    {/if}
    <span class="time">{formatRelativeTime(row.createdAt)}</span>
    {#if REVIEW_INTENT_BADGE[row.intent]}
      <span class="flag">
        <Icon name={row.intent === 'never' ? 'circle-slash' : 'clock'} size={12} />
        {REVIEW_INTENT_BADGE[row.intent]}
      </span>
    {/if}
  </span>
{/snippet}

<div class="highlights-page">
  <header class="highlights-header" use:shellToolbar>
    <div class="header-inner">
      <NavigationDropdown currentTitle="Highlights" />
      {#if highlightReviewStore.hasHighlights}
        <a class="review-link" href="/highlights/review">
          <Icon name="quote" size={15} />
          <span>Review</span>
        </a>
      {/if}
    </div>
  </header>

  <!-- Sync with Margin, and what it's doing, where its highlights are. A guest
       has no repo to sync with. -->
  {#if !auth.isGuest}
    <MarginSyncControl variant="bar" returnUrl="/highlights" />
  {/if}

  {#if rows.length === 0}
    <div class="empty-wrap">
      <EmptyState
        title="No highlights yet"
        description="Highlight a passage while reading — double-click a paragraph or select text — and it'll collect here."
        icon="🖍️"
      />
    </div>
  {:else}
    <div class="library">
      <!-- The rail: search, then the questions you ask of your highlights. -->
      <aside class="rail" aria-label="Filter highlights">
        <label class="search-field">
          <Icon name="search" size={15} />
          <input
            bind:value={filter.query}
            onkeydown={onSearchKeydown}
            type="search"
            placeholder="Search highlights"
            aria-label="Search highlights"
          />
        </label>

        <nav class="rail-section" aria-label="Views">
          {#each visibleViews as view (view.id)}
            <button
              class="rail-item"
              class:active={filter.view === view.id}
              aria-current={filter.view === view.id ? 'true' : undefined}
              onclick={() => setView(view.id)}
            >
              <Icon name={view.icon} size={15} />
              <span class="rail-label">{view.label}</span>
              <span class="rail-count">{facets.views[view.id]}</span>
            </button>
          {/each}
        </nav>

        {#if facets.tags.length > 0}
          <div class="rail-section">
            <h2 class="rail-heading">Tags</h2>
            {#each facets.tags as { tag, count } (tag)}
              <button
                class="rail-item"
                class:active={filter.tag?.toLowerCase() === tag.toLowerCase()}
                aria-pressed={filter.tag?.toLowerCase() === tag.toLowerCase()}
                onclick={() => toggleTagFilter(tag)}
              >
                <span class="hash">#</span>
                <span class="rail-label">{tag}</span>
                <span class="rail-count">{count}</span>
              </button>
            {/each}
          </div>
        {/if}

        <div class="rail-section">
          <h2 class="rail-heading">Sources</h2>
          {#each railSources as { source, count } (source.itemKey)}
            <button
              class="rail-item source-item"
              class:active={filter.sourceKey === source.itemKey}
              aria-pressed={filter.sourceKey === source.itemKey}
              onclick={() => toggleSourceFilter(source.itemKey)}
              title={source.title}
            >
              <span class="rail-label">{source.title}</span>
              <span class="rail-count">{count}</span>
            </button>
          {/each}
          {#if facets.sources.length > SOURCES_COLLAPSED}
            <button class="rail-more" onclick={() => (showAllSources = !showAllSources)}>
              {showAllSources ? 'Show fewer' : `Show all ${facets.sources.length}`}
            </button>
          {/if}
        </div>
      </aside>

      <section class="results" aria-label="Highlights">
        <!-- Below the rail breakpoint the same controls fold into a search field
             and one row of chips. -->
        <div class="compact-controls">
          <label class="search-field">
            <Icon name="search" size={15} />
            <input
              bind:value={filter.query}
              onkeydown={onSearchKeydown}
              type="search"
              placeholder="Search highlights"
              aria-label="Search highlights"
            />
          </label>
          <div class="chip-row" role="group" aria-label="Filter highlights">
            {#each visibleViews.filter((v) => v.id !== 'all') as view (view.id)}
              <button
                class="chip"
                class:active={filter.view === view.id}
                aria-pressed={filter.view === view.id}
                onclick={() => setView(filter.view === view.id ? 'all' : view.id)}
              >
                <Icon name={view.icon} size={13} />
                {view.label}
              </button>
            {/each}
            {#each facets.tags as { tag } (tag)}
              <button
                class="chip"
                class:active={filter.tag?.toLowerCase() === tag.toLowerCase()}
                aria-pressed={filter.tag?.toLowerCase() === tag.toLowerCase()}
                onclick={() => toggleTagFilter(tag)}>#{tag}</button
              >
            {/each}
          </div>
        </div>

        <div class="results-bar">
          <span class="result-count">
            {matches.length}
            {matches.length === 1 ? 'highlight' : 'highlights'}
          </span>
          {#if activeSource}
            <button
              class="active-filter"
              onclick={() => (filter.sourceKey = null)}
              title="Clear source filter"
              aria-label={`Clear source filter: ${activeSource.title}`}
            >
              <span class="active-filter-label">{activeSource.title}</span>
              <Icon name="x" size={12} />
            </button>
          {/if}
          {#if filter.tag}
            <button
              class="active-filter"
              onclick={() => (filter.tag = null)}
              title="Clear tag filter"
              aria-label={`Clear tag filter: ${filter.tag}`}
            >
              <span class="active-filter-label">#{filter.tag}</span>
              <Icon name="x" size={12} />
            </button>
          {/if}
          {#if isFiltered}
            <button class="clear-btn" onclick={clearFilters}>Clear</button>
          {/if}
          <label class="sort">
            <span class="sr-only">Sort</span>
            <select bind:value={sort}>
              {#each SORTS as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if matches.length === 0}
          <div class="no-matches">
            <p>No highlights match.</p>
            <button class="clear-btn" onclick={clearFilters}>Clear filters</button>
          </div>
        {/if}

        {#if pinned.length > 0}
          <div class="pinned">
            <h2 class="section-heading"><Icon name="pin" size={13} /> Pinned</h2>
            <ul class="pinned-grid">
              {#each pinned as row (row.id)}
                <li class="pinned-card" data-pinned-card={row.id}>
                  <button class="pinned-quote" onclick={() => openSource(row.source)}>
                    {row.text}
                  </button>
                  {#if row.note}
                    <p class="pinned-note">{row.note}</p>
                  {/if}
                  {#if row.tags.length > 0}
                    <div class="tags">{@render tagChips(row)}</div>
                  {/if}
                  <div class="pinned-footer">
                    <button class="source-link" onclick={() => openSource(row.source)}>
                      {row.source.title}
                    </button>
                    {@render rowActions(row, true)}
                  </div>
                </li>
              {/each}
            </ul>
          </div>
          {#if listed.length > 0}
            <h2 class="section-heading">Everything else</h2>
          {/if}
        {/if}

        <ul class="highlight-list">
          {#each displayed as row, i (row.id)}
            {@const startsSource =
              sort === 'source' && displayed[i - 1]?.source.itemKey !== row.source.itemKey}
            {#if startsSource}
              <li class="source-heading">
                <button class="source-heading-title" onclick={() => openSource(row.source)}>
                  {row.source.title}
                </button>
                {#if row.source.domain}<span class="domain">{row.source.domain}</span>{/if}
              </li>
            {/if}
            <li class="highlight-row" class:pinned-row={row.pinnedAt !== undefined}>
              <div class="row-body">
                <button class="quote-btn" onclick={() => openSource(row.source)}>
                  <span class="quote">{row.text}</span>
                </button>
                {#if row.note}
                  <p class="row-note">{row.note}</p>
                {/if}
                <div class="row-footer">
                  {@render rowMeta(row, sort !== 'source')}
                  {#if row.tags.length > 0}
                    <span class="tags">{@render tagChips(row)}</span>
                  {/if}
                </div>
              </div>
              {@render rowActions(row)}
            </li>
          {/each}
        </ul>

        <InfiniteScrollSentinel
          {hasMore}
          isLoading={false}
          onLoadMore={() => (loadedCount += PAGE_SIZE)}
        />
      </section>
    </div>
  {/if}

  {#if mobileStore.isMobile && !readerItem}
    <MobileBottomBar
      controlsVisible={scrollDirection.controlsVisible}
      currentTitle="Highlights"
      onScrollToTop={scrollToTop}
      onOpenFeedSwitcher={() => {
        perfBegin(PERF_SHEET_OPEN);
        feedSwitcherOpen = true;
      }}
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
        currentTitle="Highlights"
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

{#if noteEditor}
  <HighlightPopover
    mode="view"
    initialView="note"
    anchorRect={noteEditor.anchorRect}
    existingNote={noteEditor.row.note ?? ''}
    onSaveNote={handleSaveNote}
    onClose={() => (noteEditor = null)}
  />
{/if}

{#if tagEditor && tagEditorRow}
  <HighlightTagPicker
    anchor={tagEditor.anchor}
    tags={tagEditorRow.tags}
    vocabulary={tagVocabulary}
    onChange={handleTagsChange}
    onClose={() => (tagEditor = null)}
  />
{/if}

<RemoveHighlightModal
  open={Boolean(removePrompt)}
  onMargin={Boolean(removePrompt?.isMargin)}
  onRemove={confirmRemove}
  onclose={() => (removePrompt = null)}
/>

<style>
  .highlights-page {
    width: 100%;
  }

  /* Moved into the shell's toolbar strip (see FeedPageHeader): it rides on the
     ground colour above the content card, which supplies the separation the
     scroll-aware divider used to. */
  .highlights-header {
    background: transparent;
  }

  /* Full card width: title on the card's left edge, Review on its right — see
     FeedPageHeader. The pill's own border is its visual edge, so unlike the
     borderless icon buttons there it needs no negative margin to sit flush. */
  .header-inner {
    min-height: var(--shell-bar-height);
    padding: 0.25rem var(--shell-bar-inset);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  /* Quiet entry into the review deck — a link, not a call to action. */
  .review-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 36px;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .review-link:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .empty-wrap {
    max-width: 800px;
    margin: 0 auto;
    padding: 0.5rem;
  }

  /* --- Two columns: the rail of filters, then the results ------------------ */

  .library {
    display: grid;
    grid-template-columns: 14rem minmax(0, 1fr);
    gap: 2rem;
    max-width: 1080px;
    margin: 0 auto;
    padding: 1rem 1.5rem 3rem;
  }

  .rail {
    position: sticky;
    top: 1rem;
    align-self: start;
    max-height: calc(100vh - var(--shell-bar-height, 3rem) - 2rem);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 2.25rem;
    padding: 0 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    color: var(--color-text-secondary);
    background: var(--color-bg);
    transition: border-color 0.15s;
  }

  .search-field:focus-within {
    border-color: var(--color-primary);
  }

  .search-field input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
  }

  .rail-section {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .rail-heading {
    margin: 0 0 0.25rem;
    padding: 0 0.625rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    color: var(--color-text-secondary);
  }

  .rail-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 2rem;
    padding: 0 0.625rem;
    border: none;
    border-radius: 0.5rem;
    background: none;
    color: var(--color-text);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .rail-item :global(svg) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .rail-item:hover {
    background: var(--color-bg-secondary);
  }

  .rail-item.active {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .rail-item.active :global(svg),
  .rail-item.active .hash {
    color: var(--color-primary);
  }

  .rail-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail-count {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .hash {
    width: 15px;
    text-align: center;
    color: var(--color-text-secondary);
  }

  .rail-more {
    align-self: flex-start;
    margin-top: 0.125rem;
    padding: 0.25rem 0.625rem;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .rail-more:hover {
    color: var(--color-primary);
  }

  /* --- Results ----------------------------------------------------------------- */

  .compact-controls {
    display: none;
  }

  .results-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-height: 2.25rem;
    margin-bottom: 0.75rem;
  }

  .result-count {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .active-filter {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 16rem;
    padding: 0.125rem 0.5rem;
    border: none;
    border-radius: 999px;
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .active-filter-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .clear-btn {
    padding: 0.125rem 0.375rem;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .clear-btn:hover {
    color: var(--color-primary);
  }

  .sort {
    margin-left: auto;
  }

  .sort select {
    height: 2rem;
    padding: 0 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    background: var(--color-bg);
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .no-matches {
    padding: 3rem 1rem;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .no-matches p {
    margin: 0 0 0.5rem;
  }

  .section-heading {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 0 0.5rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    color: var(--color-text-secondary);
  }

  /* --- Pinned shelf: the few that matter, as cards ------------------------------- */

  .pinned {
    margin-bottom: 1.75rem;
  }

  .pinned-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 0.75rem;
  }

  .pinned-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    background: var(--color-bg);
  }

  .pinned-quote {
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
    padding: 0 0 0 0.75rem;
    border: none;
    border-left: 3px solid color-mix(in srgb, #f5c518 70%, transparent);
    background: none;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    line-height: var(--leading-relaxed, 1.6);
    text-align: left;
    cursor: pointer;
  }

  .pinned-note {
    margin: 0;
    padding-left: 0.75rem;
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed, 1.6);
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .pinned-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: auto;
    padding-left: 0.75rem;
  }

  .pinned-footer .source-link {
    flex: 1;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  /* Tags and the footer sink to the card's foot together, so cards in a row
     line their sources up whatever the passage length. */
  .pinned-card .tags {
    margin-top: auto;
    padding-left: 0.75rem;
  }

  .pinned-card .tags + .pinned-footer {
    margin-top: 0;
  }

  /* --- The list: one row per highlight ------------------------------------------- */

  .highlight-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .highlight-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.875rem 0.5rem 0.75rem;
    border-radius: 0.5rem;
    transition: background-color 0.15s;
  }

  .highlight-row:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.025));
  }

  .row-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .quote-btn {
    display: block;
    width: 100%;
    padding: 0 0 0 0.75rem;
    border: none;
    border-left: 3px solid color-mix(in srgb, #f5c518 70%, transparent);
    background: none;
    color: var(--color-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .quote {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--text-md);
    line-height: var(--leading-relaxed, 1.6);
  }

  .row-note {
    margin: 0;
    padding-left: 0.75rem;
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed, 1.6);
    color: var(--color-text-secondary);
    white-space: pre-wrap;
  }

  .row-footer {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    padding-left: 0.75rem;
  }

  .row-meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .source-link {
    min-width: 0;
    max-width: 22rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--color-text);
    font: inherit;
    font-weight: var(--weight-medium);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .source-link:hover {
    color: var(--color-primary);
  }

  .domain {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    opacity: 0.6;
  }

  .time {
    white-space: nowrap;
  }

  .flag {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
  }

  .tags {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .tag-chip {
    padding: 0 0.375rem;
    border: none;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    line-height: 1.6;
    cursor: pointer;
  }

  .tag-chip:hover,
  .tag-chip.active {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .source-heading {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 1.25rem 0.5rem 0.25rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .source-heading:first-child {
    padding-top: 0;
  }

  .source-heading-title {
    padding: 0;
    border: none;
    background: none;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    text-align: left;
    cursor: pointer;
  }

  .source-heading-title:hover {
    color: var(--color-primary);
  }

  /* Actions sit at the row's right edge, always shown: hiding them until hover
     made pinning and publishing hard to find. */
  .row-actions {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    flex-shrink: 0;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .action-btn:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .action-btn.published {
    cursor: default;
    opacity: 0.45;
  }

  .action-btn.published:hover {
    background: none;
  }

  .action-btn.on {
    color: var(--color-primary);
  }

  .action-btn.on :global(svg path) {
    fill: currentColor;
  }

  /* --- Below the rail breakpoint: chips instead of a rail ----------------------- */

  @media (--shell-mobile) {
    .highlights-header {
      display: none;
    }

    .highlights-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }

    .library {
      display: block;
      padding: 0.25rem 1rem 2rem;
    }

    .rail {
      display: none;
    }

    .compact-controls {
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
      margin-bottom: 0.75rem;
    }

    .chip-row {
      display: flex;
      gap: 0.375rem;
      overflow-x: auto;
      scrollbar-width: none;
      margin: 0 -1rem;
      padding: 0 1rem;
    }

    .chip-row::-webkit-scrollbar {
      display: none;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      flex-shrink: 0;
      height: 2rem;
      padding: 0 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: 999px;
      background: var(--color-bg);
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
      white-space: nowrap;
      cursor: pointer;
    }

    .chip.active {
      border-color: var(--color-primary);
      background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
      color: var(--color-primary);
    }

    .highlight-row {
      padding: 0.875rem 0 0.75rem;
      gap: 0.25rem;
    }

    .highlight-row:hover {
      background: none;
    }

    /* Narrow: the passage and note take the full width, and the actions share
       the last line with the source and tags instead of taking a line of their
       own. */
    .highlight-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      row-gap: 0.375rem;
    }

    .highlight-row .row-body {
      display: contents;
    }

    .highlight-row .quote-btn,
    .highlight-row .row-note {
      grid-column: 1 / -1;
    }

    .highlight-row .row-actions {
      margin: 0 -0.375rem -0.375rem 0;
    }

    .row-meta .domain,
    .row-meta .domain + .dot {
      display: none;
    }

    /* A plain stack: a horizontal scroller would clip each card's ⋯ menu. */
    .pinned-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .source-link {
      max-width: 12rem;
    }
  }

  /* iOS Safari zooms into any focused field under 16px (see e2e/ios-zoom). */
  @media (hover: none) and (pointer: coarse) {
    .search-field input,
    .sort select {
      font-size: 16px;
    }
  }

  @media (prefers-color-scheme: dark) {
    .highlight-row:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }

    .action-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }
  }
</style>
