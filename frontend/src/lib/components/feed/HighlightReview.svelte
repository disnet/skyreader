<script lang="ts">
  // Highlight review — a finite deck of a handful of highlights, one card at a
  // time. Deliberately not a durable issue like the daily magazine: a session is
  // a few minutes, so the deck is derived at open and repeat-avoidance rides the
  // per-highlight `lastReviewedAt` stamp, which syncs with the highlight itself.
  import { pushState } from '$app/navigation';
  import { page } from '$app/state';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import RemoveHighlightModal from '$lib/components/feed/RemoveHighlightModal.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import {
    saveHighlightToMargin,
    deleteHighlight,
    updateHighlightNoteOnMargin,
  } from '$lib/services/marginHighlights';
  import { maybeImportMarginHighlights } from '$lib/services/marginHighlightImport';
  import {
    buildHighlightDeck,
    shouldRedealAfterImport,
    type HighlightEntry,
  } from '$lib/utils/highlightReview';
  import {
    buildHighlightSourceLookups,
    resolveHighlightSource,
    type HighlightSource,
  } from '$lib/utils/highlightSource';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';

  $effect(() => {
    viewTitleStore.set('Review');
    return () => viewTitleStore.set('');
  });

  let sourceLookups = $derived(
    buildHighlightSourceLookups(
      articlesStore.allArticles,
      socialStore.documents,
      savesStore.articles
    )
  );

  // The deck is fixed for the session: it's built once, from the corpus as it
  // stood at open. Deriving it would rebuild the deck the moment the first card
  // is marked reviewed and pull the ground out from under the reader.
  let deck = $state<HighlightEntry[] | null>(null);
  let index = $state(0);
  let reviewed = $state(0);
  let interacted = $state(false);

  // Deal as soon as the local stores hydrate — everything needed for a session is
  // already on the device, so a Margin poll must never stand between the reader
  // and their first card. The poll runs alongside it and redeals exactly once, if
  // it actually imported something and the reader hasn't started yet.
  let storesReady = $derived(!itemLabelsStore.isLoading && !savesStore.loading);
  let initialImportComplete = $state(false);
  let importStarted = false;

  // Plain flag, not the `deck` state itself: the effect writes `deck`, so reading
  // it here as the guard would make the effect depend on its own write.
  let dealt = false;

  // Tracked separately from `deck.length` so removing the last card of a real
  // deck can't be mistaken for "the local pool was empty".
  let emptyOnDeal = $state(false);

  function dealDeck() {
    deck = buildHighlightDeck(
      itemLabelsStore.allHighlights,
      preferences.highlightReviewCount
    ).cards;
    emptyOnDeal = deck.length === 0;
  }

  $effect(() => {
    if (dealt || !storesReady) return;
    dealt = true;
    dealDeck();
  });

  // An empty deck is the one case worth waiting on: the local pool has nothing to
  // show, so the in-flight poll may be the whole session. The wait is bounded, so
  // a stalled poll lands on the empty state instead of spinning forever.
  const EMPTY_DECK_IMPORT_WAIT_MS = 6000;
  let importWaitElapsed = $state(false);

  $effect(() => {
    if (!storesReady || importStarted) return;
    importStarted = true;
    const timer = setTimeout(() => (importWaitElapsed = true), EMPTY_DECK_IMPORT_WAIT_MS);
    void maybeImportMarginHighlights()
      .then((result) => {
        if (shouldRedealAfterImport(result, { index, reviewed, interacted })) dealDeck();
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        initialImportComplete = true;
      });
  });

  let awaitingImport = $derived(emptyOnDeal && !initialImportComplete && !importWaitElapsed);
  let ready = $derived(storesReady && !awaitingImport);

  let total = $derived(deck?.length ?? 0);
  let current = $derived(deck && index < deck.length ? deck[index] : null);
  // Re-read from the store so a note edit or Margin save shows immediately —
  // the deck itself holds the highlight as it was when the deck was dealt.
  let live = $derived.by(() => {
    if (!current) return null;
    const found = itemLabelsStore
      .getHighlights(current.itemKey)
      .find((entry) => entry.id === current.highlight.id);
    return found ?? current.highlight;
  });
  let source = $derived.by((): HighlightSource | null =>
    current
      ? resolveHighlightSource(current.itemKey, current.itemType, sourceLookups, live ?? undefined)
      : null
  );
  let done = $derived(Boolean(deck) && ready && index >= total);

  function advance() {
    const entry = current;
    if (!entry) return;
    interacted = true;
    void itemLabelsStore.markHighlightReviewed(entry.itemKey, entry.highlight.id);
    reviewed += 1;
    index += 1;
  }

  // --- Open the source article (in-app when we have it, else the web) ---
  let readerItem = $state<FeedDisplayItem | null>(null);
  let savedScrollY = 0;

  $effect(() => {
    if (!page.state.readerOpen && readerItem) {
      readerItem = null;
      requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    }
  });

  function openSource() {
    const target = source;
    if (!target) return;
    if (target.displayItem) {
      savedScrollY = window.scrollY;
      readerItem = target.displayItem;
      pushState('', { readerOpen: true });
    } else if (target.url) {
      window.open(target.url, '_blank', 'noopener,noreferrer');
    }
  }

  function closeReader() {
    readerItem = null;
    history.back();
    requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
  }

  // --- Note editing (same popover the reader and the highlights list use) ---
  let noteAnchor = $state<DOMRect | null>(null);

  function openNoteEditor(event: MouseEvent) {
    // Freeze before opening the editor: the import can finish while the reader
    // is typing, and the saved note must still belong to the selected card.
    interacted = true;
    noteAnchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
  }

  function handleSaveNote(note: string) {
    const entry = current;
    const target = source;
    noteAnchor = null;
    if (!entry || !target) return;
    void (async () => {
      await itemLabelsStore.setHighlightNote(entry.itemKey, entry.highlight.id, note);
      const updated = itemLabelsStore
        .getHighlights(entry.itemKey)
        .find((h) => h.id === entry.highlight.id);
      if (updated?.marginRkey) {
        await updateHighlightNoteOnMargin(entry.itemKey, updated, target.url, target.title);
      }
    })();
  }

  function handleSaveToMargin() {
    const entry = current;
    const target = source;
    if (!entry || !target || !live) return;
    interacted = true;
    void saveHighlightToMargin(entry.itemKey, live, target.url, target.title);
  }

  // --- Remove (destructive across apps when the highlight is on Margin) ---
  let removePrompt = $state(false);

  function openRemovePrompt() {
    // Freeze before confirmation opens so a late import cannot swap the card
    // underneath this destructive action.
    interacted = true;
    removePrompt = true;
  }

  function confirmRemove() {
    const entry = current;
    const highlight = live;
    removePrompt = false;
    if (!entry || !highlight) return;
    // Freeze the session before starting the cross-app deletion. The opening
    // import can finish while that request is in flight and must not redeal the
    // card the reader just confirmed removing.
    interacted = true;
    void deleteHighlight(entry.itemKey, highlight);
    // Drop the card without stamping it reviewed — it no longer exists.
    if (deck) deck = deck.filter((card) => card.highlight.id !== entry.highlight.id);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (readerItem || noteAnchor || removePrompt || !current) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'ArrowRight' || event.key === ' ') {
      event.preventDefault();
      advance();
    } else if (event.key === 'o') {
      event.preventDefault();
      openSource();
    } else if (event.key === 'e') {
      event.preventDefault();
      interacted = true;
      const button = document.querySelector<HTMLElement>('[data-review-note]');
      noteAnchor = button?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="review-page">
  <header class="review-header">
    <div class="header-inner">
      <NavigationDropdown currentTitle="Review" />
      {#if current}
        <span class="progress">{index + 1} of {total}</span>
      {/if}
    </div>
  </header>

  <div class="review-body">
    {#if !ready || !deck}
      <p class="state-note" aria-live="polite">Gathering your highlights…</p>
    {:else if current && source && live}
      <article class="card">
        <blockquote class="quote"><mark>{live.selector.exact}</mark></blockquote>

        {#if live.note}
          <p class="note">{live.note}</p>
        {/if}

        <button class="source" onclick={openSource}>
          <span class="source-title">{source.title}</span>
          {#if source.domain}
            <span class="source-domain">{source.domain}</span>
          {/if}
        </button>

        <div class="actions">
          <button class="next" onclick={advance}>
            <span>{index + 1 === total ? 'Finish' : 'Next'}</span>
            <Icon name="arrow-right" size={16} />
          </button>

          <div class="secondary">
            <button
              class="action-btn"
              data-review-note
              onclick={openNoteEditor}
              title={live.note ? 'Edit note (e)' : 'Add a note (e)'}
              aria-label={live.note ? 'Edit note' : 'Add a note'}
            >
              <Icon name="message-circle" size={16} />
            </button>
            {#if !live.marginUri}
              <button
                class="action-btn"
                onclick={handleSaveToMargin}
                title="Save to Margin"
                aria-label="Save to Margin"
              >
                <Icon name="margin" size={16} />
              </button>
            {/if}
            <button
              class="action-btn"
              onclick={openSource}
              title="Open the article (o)"
              aria-label="Open the article"
            >
              <Icon name="external-link" size={16} />
            </button>
            <button
              class="action-btn danger"
              onclick={openRemovePrompt}
              title="Remove highlight"
              aria-label="Remove highlight"
            >
              <Icon name="trash" size={16} />
            </button>
          </div>
        </div>
      </article>

      <p class="hint">→ next · o open · e note</p>
    {:else if done && reviewed > 0}
      <section class="state" aria-live="polite">
        <h1>That's your review</h1>
        <p>{reviewed} highlight{reviewed === 1 ? '' : 's'} revisited.</p>
        <a href="/highlights">All highlights</a>
      </section>
    {:else}
      <section class="state" aria-live="polite">
        <h1>Nothing to review right now</h1>
        <p>
          Highlight a passage while reading and it joins the deck. Come back tomorrow for another
          handful.
        </p>
        <a href="/highlights">All highlights</a>
      </section>
    {/if}
  </div>
</div>

{#if noteAnchor}
  <HighlightPopover
    mode="view"
    initialView="note"
    anchorRect={noteAnchor}
    existingNote={live?.note ?? ''}
    onSaveNote={handleSaveNote}
    onClose={() => (noteAnchor = null)}
  />
{/if}

<RemoveHighlightModal
  open={removePrompt}
  onMargin={Boolean(live?.marginUri)}
  onRemove={confirmRemove}
  onclose={() => (removePrompt = false)}
/>

{#if readerItem}
  <SavedReader {readerItem} onClose={closeReader} />
{/if}

<style>
  .review-page {
    width: 100%;
  }

  /* Flat header matching the highlights page: no border at rest, no shadow. */
  .review-header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--color-bg);
  }

  .header-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    max-width: 680px;
    margin: 0 auto;
    padding: 0.75rem 1rem;
  }

  .progress {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .review-body {
    max-width: 680px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* The 3px gold rule on a quoted highlight — the one sanctioned colored
     side-border, as a quotation convention (DESIGN.md). */
  .quote {
    margin: 0;
    padding: 0.125rem 0 0.125rem 1rem;
    border-left: 3px solid color-mix(in srgb, #f5c518 70%, transparent);
  }

  .quote mark {
    background-color: color-mix(in srgb, #f5c518 25%, transparent);
    color: inherit;
    border-radius: 1px;
    font-size: var(--text-lg);
    line-height: var(--leading-relaxed, 1.6);
  }

  .note {
    margin: 0;
    padding-left: 1rem;
    font-size: var(--text-md);
    line-height: var(--leading-relaxed, 1.6);
    color: var(--color-text-secondary);
    white-space: pre-wrap;
  }

  .source {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    width: 100%;
    padding: 0 0 0 1rem;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    font: inherit;
  }

  .source-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .source:hover .source-title {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .source-domain {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-top: 0.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }

  /* One primary action per card, in the one interaction blue. */
  .next {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 44px;
    padding: 0.5rem 1.1rem;
    border: 0;
    border-radius: 6px;
    background: var(--color-primary);
    color: #fff;
    font: inherit;
    font-weight: var(--weight-semibold);
    cursor: pointer;
    transition: filter 0.2s ease;
  }

  .next:hover {
    filter: brightness(0.95);
  }

  .secondary {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color 0.15s ease,
      background-color 0.15s ease;
  }

  .action-btn:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .action-btn.danger:hover {
    color: var(--color-error, #cc0000);
  }

  .hint {
    margin: 1.5rem 0 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .state {
    display: grid;
    gap: 0.5rem;
    padding: 2rem 0;
  }

  .state h1 {
    margin: 0;
    font-size: 1.25rem;
    line-height: var(--leading-tight);
  }

  .state p {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .state a {
    width: fit-content;
    margin-top: 0.5rem;
    color: var(--color-primary);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  .state-note {
    margin: 2rem 0 0;
    color: var(--color-text-secondary);
  }

  /* The keyboard hint is meaningless without a keyboard. */
  @media (hover: none) {
    .hint {
      display: none;
    }
  }
</style>
