<script lang="ts">
  import { shellToolbar } from '$lib/actions/shell-toolbar';
  import { appScrollTo } from '$lib/utils/appScroll';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import RemoveHighlightModal from '$lib/components/feed/RemoveHighlightModal.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
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
  import {
    maybeImportMarginHighlights,
    marginImportTruncated,
  } from '$lib/services/marginHighlightImport';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import type { Highlight, ItemLabelType, ReviewIntent } from '$lib/types';

  // Set the browser-tab title while this page is mounted.
  $effect(() => {
    viewTitleStore.set('Highlights');
    return () => viewTitleStore.set('');
  });

  // A partial poll must say so — otherwise "these are my highlights" is a lie.
  let importTruncated = $state(false);

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
    void maybeImportMarginHighlights()
      .catch(() => {})
      // Read the flag the service kept rather than this call's return: a poll
      // that short-circuits on the interval gate reports `skipped`, and the
      // corpus is no less partial for someone else having done the fetching.
      .finally(() => (importTruncated = marginImportTruncated()));
  });

  interface HighlightRow {
    id: string;
    text: string;
    note?: string;
    createdAt: number;
    isMargin: boolean;
    intent: ReviewIntent;
    highlight: Highlight;
  }

  interface HighlightGroup {
    itemKey: string;
    itemType: ItemLabelType;
    title: string;
    url: string | null;
    domain: string | null;
    // The item to open in the in-app reader; null when the source isn't in the
    // local cache (e.g. an old article that's aged out) — then we fall back to
    // opening the external URL.
    displayItem: FeedDisplayItem | null;
    rows: HighlightRow[];
    latest: number;
  }

  // Lookups for enriching a highlight's parent item with title/url/body.
  let sourceLookups = $derived(
    buildHighlightSourceLookups(
      articlesStore.allArticles,
      socialStore.documents,
      savesStore.articles,
      subscriptionsStore.subscriptions
    )
  );

  // Group every highlight under its source item, newest-source first.
  let groups = $derived.by((): HighlightGroup[] => {
    const byKey = new Map<string, HighlightGroup>();
    // Highlights are written under one canonical key, but a row can briefly land
    // under the uri before saves hydrate; group by canonical key and skip ids
    // already seen so such a transient duplicate never renders twice.
    const seenIds = new Set<string>();

    for (const { itemKey, itemType, highlight } of itemLabelsStore.allHighlights) {
      if (seenIds.has(highlight.id)) continue;
      seenIds.add(highlight.id);
      const groupKey = itemLabelsStore.canonicalKey(itemKey);
      let group = byKey.get(groupKey);
      if (!group) {
        // Imported Margin highlights may have no local article at all — the
        // resolver falls back to the metadata carried on the highlight so the
        // group still renders a title and stays openable.
        const source = resolveHighlightSource(groupKey, itemType, sourceLookups, highlight);

        group = {
          itemKey: groupKey,
          itemType,
          title: source.title,
          url: source.url,
          domain: source.domain,
          displayItem: source.displayItem,
          rows: [],
          latest: 0,
        };
        byKey.set(groupKey, group);
      }

      group.rows.push({
        id: highlight.id,
        text: highlight.selector.exact,
        note: highlight.note,
        createdAt: highlight.createdAt,
        isMargin: Boolean(highlight.marginUri),
        intent: highlight.reviewIntent ?? REVIEW_INTENT_DEFAULT,
        highlight,
      });
      if (highlight.createdAt > group.latest) group.latest = highlight.createdAt;
    }

    const out = [...byKey.values()];
    for (const g of out) g.rows.sort((a, b) => b.createdAt - a.createdAt);
    out.sort((a, b) => b.latest - a.latest);
    return out;
  });

  let totalHighlights = $derived(itemLabelsStore.allHighlights.length);

  // Infinite scroll over groups: render a window and grow it as the sentinel
  // comes into view.
  const PAGE_SIZE = 15;
  let loadedCount = $state(PAGE_SIZE);
  let displayed = $derived(groups.slice(0, loadedCount));
  let hasMore = $derived(loadedCount < groups.length);

  // Reader overlay — the same stack every other surface uses, so /highlights gets
  // Back-to-close, scroll restore and a `?read=` URL for free.
  const reader = useReaderStack();
  let readerItem = $derived(reader.readerItem);

  function openGroup(group: HighlightGroup) {
    if (group.displayItem) {
      reader.openReader(group.displayItem);
    } else if (group.url) {
      window.open(group.url, '_blank', 'noopener,noreferrer');
    }
  }

  // Removing a Margin-backed highlight deletes the user's own PDS record too —
  // always confirm, so a cross-app delete can't happen on a stray tap.
  let removePrompt = $state<{ group: HighlightGroup; row: HighlightRow } | null>(null);

  function confirmRemove() {
    const pending = removePrompt;
    removePrompt = null;
    if (!pending) return;
    void deleteHighlight(pending.group.itemKey, pending.row.highlight);
  }

  function handleSaveToMargin(group: HighlightGroup, row: HighlightRow) {
    void saveHighlightToMargin(group.itemKey, row.highlight, group.url, group.title);
  }

  // Frequency tuning happens in the review deck, one card at a time. The list
  // is where you can see what you've set and get back out of 'never', which is
  // the only setting that hides a highlight from the deck entirely. Clearing it
  // returns to the default pace rather than to a previous 'soon'/'someday' —
  // the list reports the state, the deck is where you tune it.
  function toggleNeverReview(group: HighlightGroup, row: HighlightRow) {
    void itemLabelsStore.setHighlightReviewIntent(
      group.itemKey,
      row.id,
      row.intent === 'never' ? null : 'never'
    );
  }

  const REVIEW_INTENT_BADGE: Partial<Record<ReviewIntent, string>> = {
    soon: 'Soon',
    someday: 'Someday',
    never: 'Not in review',
  };

  // Note editor — a floating popover anchored to the "add a note" button, opened
  // straight into its note view. Mirrors the reader's note-editing UX.
  let noteEditor = $state<{
    group: HighlightGroup;
    row: HighlightRow;
    anchorRect: DOMRect;
  } | null>(null);

  function openNoteEditor(event: MouseEvent, group: HighlightGroup, row: HighlightRow) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    noteEditor = { group, row, anchorRect: rect };
  }

  function handleSaveNote(note: string) {
    if (!noteEditor) return;
    const { group, row } = noteEditor;
    noteEditor = null;
    void (async () => {
      await itemLabelsStore.setHighlightNote(group.itemKey, row.id, note);
      // Re-read so we act on the persisted note + current Margin linkage.
      const updated = itemLabelsStore.getHighlights(group.itemKey).find((h) => h.id === row.id);
      if (updated?.marginRkey) {
        await updateHighlightNoteOnMargin(group.itemKey, updated, group.url, group.title);
      }
    })();
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

  <div class="highlights-body">
    {#if importTruncated}
      <p class="import-notice">Some Margin highlights couldn't be fetched yet.</p>
    {/if}
    {#if totalHighlights === 0}
      <EmptyState
        title="No highlights yet"
        description="Highlight a passage while reading — double-click a paragraph or select text — and it'll collect here."
        icon="🖍️"
      />
    {:else}
      <ul class="group-list">
        {#each displayed as group (group.itemKey)}
          <li class="group-card">
            <button class="group-header" onclick={() => openGroup(group)}>
              <span class="source-title">{group.title}</span>
              <span class="source-meta">
                {#if group.domain}
                  <span class="domain">{group.domain}</span>
                  <span class="dot">·</span>
                {/if}
                <span class="count"
                  >{group.rows.length} highlight{group.rows.length === 1 ? '' : 's'}</span
                >
              </span>
            </button>

            <div class="rows">
              {#each group.rows as row (row.id)}
                <div class="highlight-row">
                  <button class="quote-btn" onclick={() => openGroup(group)} title="Open article">
                    <mark>{row.text}</mark>
                  </button>
                  {#if row.note}
                    <p class="row-note">{row.note}</p>
                  {/if}
                  <div class="row-footer">
                    <span class="row-meta">
                      <span class="time">{formatRelativeTime(row.createdAt)}</span>
                      {#if row.isMargin}
                        <span class="badge badge-margin">
                          <Icon name="margin" size={12} />
                          Margin
                        </span>
                      {:else}
                        <span class="badge badge-private">Private</span>
                      {/if}
                      {#if REVIEW_INTENT_BADGE[row.intent]}
                        <span class="badge badge-intent">
                          <Icon
                            name={row.intent === 'never' ? 'circle-slash' : 'clock'}
                            size={12}
                          />
                          {REVIEW_INTENT_BADGE[row.intent]}
                        </span>
                      {/if}
                    </span>
                    <span class="row-actions">
                      <button
                        class="action-btn"
                        onclick={(e) => openNoteEditor(e, group, row)}
                        title={row.note ? 'Edit note' : 'Add a note'}
                        aria-label={row.note ? 'Edit note' : 'Add a note'}
                      >
                        <Icon name="message-circle" size={15} />
                      </button>
                      {#if !row.isMargin}
                        <button
                          class="action-btn"
                          onclick={() => handleSaveToMargin(group, row)}
                          title="Save to Margin"
                          aria-label="Save to Margin"
                        >
                          <Icon name="margin" size={15} />
                        </button>
                      {/if}
                      <button
                        class="action-btn"
                        class:on={row.intent === 'never'}
                        onclick={() => toggleNeverReview(group, row)}
                        title={row.intent === 'never'
                          ? 'Put back in the review deck'
                          : 'Never show this in review'}
                        aria-label={row.intent === 'never'
                          ? 'Put back in the review deck'
                          : 'Never show this in review'}
                        aria-pressed={row.intent === 'never'}
                      >
                        <Icon name="circle-slash" size={15} />
                      </button>
                      <button
                        class="action-btn danger"
                        onclick={() => (removePrompt = { group, row })}
                        title="Remove highlight"
                        aria-label="Remove highlight"
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </span>
                  </div>
                </div>
              {/each}
            </div>
          </li>
        {/each}
      </ul>

      <InfiniteScrollSentinel
        {hasMore}
        isLoading={false}
        onLoadMore={() => (loadedCount += PAGE_SIZE)}
      />
    {/if}
  </div>

  {#if mobileStore.isMobile && !readerItem}
    <MobileBottomBar
      controlsVisible={scrollDirection.controlsVisible}
      currentTitle="Highlights"
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
    >
      <MobileFeedSwitcher
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

<RemoveHighlightModal
  open={Boolean(removePrompt)}
  onMargin={Boolean(removePrompt?.row.isMargin)}
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

  /* Below 1000px the floating mobile bottom bar takes over navigation, so the
     desktop header is hidden — matching FeedPageHeader. */
  @media (max-width: 1000px) {
    .highlights-header {
      display: none;
    }

    .highlights-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
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

  .highlights-body {
    max-width: 800px;
    margin: 0 auto;
    padding: 0.5rem;
  }

  .import-notice {
    margin: 0.5rem 0.5rem 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .group-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* A rounded card per source — comfortable padding, no separator lines, hover
     lift matching the article/saved list items. */
  .group-card {
    border-radius: 12px;
    padding: 1rem 1.25rem 1.125rem;
    transition: background-color 0.15s;
  }

  .group-card:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.025));
  }

  .group-header {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    color: var(--color-text);
  }

  .source-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug, 1.3);
  }

  .source-title:hover {
    color: var(--color-primary);
  }

  .source-meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .domain {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    opacity: 0.6;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    margin-top: 0.875rem;
  }

  .highlight-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .quote-btn {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-left: 3px solid color-mix(in srgb, #f5c518 70%, transparent);
    padding: 0.0625rem 0 0.0625rem 0.875rem;
    cursor: pointer;
    font: inherit;
    color: var(--color-text);
  }

  /* The highlighted passage, rendered with the same mark style as the reader. */
  .quote-btn mark {
    background-color: color-mix(in srgb, #f5c518 25%, transparent);
    color: inherit;
    border-radius: 1px;
    font-size: var(--text-md);
    line-height: var(--leading-relaxed, 1.6);
    /* Clamp very long highlights so cards stay scannable. */
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .row-note {
    margin: 0.375rem 0 0;
    padding-left: 0.875rem;
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed, 1.6);
    color: var(--color-text-secondary, #555);
    white-space: pre-wrap;
  }

  .row-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-left: 0.875rem;
  }

  .row-meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    min-width: 0;
  }

  .time {
    white-space: nowrap;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.0625rem 0.4rem;
    border-radius: 999px;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    line-height: 1.4;
  }

  /* Saved to Margin = public/portable. */
  .badge-margin {
    color: var(--color-primary);
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
  }

  /* Local-only highlight. */
  .badge-private {
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, #f0f0f0);
  }

  /* A review-pace setting the reader chose. Reads as a state on the highlight,
     not as a warning: nothing was deleted, even for 'never'. */
  .badge-intent {
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, #f0f0f0);
  }

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
    width: 1.75rem;
    height: 1.75rem;
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .action-btn:hover {
    background: var(--color-bg-secondary, #f0f0f0);
    color: var(--color-text);
  }

  .action-btn.danger:hover {
    color: var(--color-error, #dc2626);
    background: rgba(220, 38, 38, 0.1);
  }

  /* A toggle that's on, not a selected row: the tint says the state, the badge
     beside it says what the state means. */
  .action-btn.on {
    color: var(--color-primary);
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
  }

  @media (prefers-color-scheme: dark) {
    .group-card:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }

    .badge-private,
    .badge-intent,
    .action-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .action-btn.on {
      background: var(--color-sidebar-active, rgba(77, 166, 255, 0.15));
    }
  }
</style>
