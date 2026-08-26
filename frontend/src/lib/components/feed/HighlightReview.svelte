<script lang="ts">
  // Highlight review — a finite deck of a handful of highlights, one card at a
  // time. Deliberately not a durable issue like the daily magazine: a session is
  // a few minutes, so the deck is derived at open and repeat-avoidance rides the
  // per-highlight `lastReviewedAt` stamp, which syncs with the highlight itself.
  import { pushState } from '$app/navigation';
  import { page } from '$app/state';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import HighlightSettings from '$lib/components/settings/HighlightSettings.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import RemoveHighlightModal from '$lib/components/feed/RemoveHighlightModal.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { highlightReviewStore } from '$lib/stores/highlightReview.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import {
    saveHighlightToMargin,
    deleteHighlight,
    updateHighlightNoteOnMargin,
  } from '$lib/services/marginHighlights';
  import { maybeImportMarginHighlights } from '$lib/services/marginHighlightImport';
  import {
    buildHighlightDeck,
    deckUntouched,
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
  // Session tally, across every hand — `index` and `interacted` are per hand.
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

  // The deck size this hand was dealt at. Plain, not `$state`: the redeal effect
  // writes it, and it exists only to notice a change in the preference.
  let dealtCount = 0;

  // Sticky for the rest of the visit: a redeal triggered by a settings change
  // must not quietly drop an encore hand back to the (empty) daily pool.
  let encoreMode = false;

  function dealDeck() {
    dealtCount = preferences.highlightReviewCount;
    deck = buildHighlightDeck(itemLabelsStore.allHighlights, dealtCount, new Date(), {
      includeReviewedToday: encoreMode,
    }).cards;
    emptyOnDeal = deck.length === 0;
  }

  $effect(() => {
    if (dealt || !storesReady) return;
    dealt = true;
    dealDeck();
  });

  // Resizing the deck from the settings panel takes effect now if the reader
  // hasn't started — otherwise it would look like the control did nothing — and
  // waits for the next session once they have.
  $effect(() => {
    const size = preferences.highlightReviewCount;
    if (!dealt || size === dealtCount) return;
    if (deckUntouched({ index, interacted })) dealDeck();
    else dealtCount = size;
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
        if (shouldRedealAfterImport(result, { index, interacted })) dealDeck();
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
    dismissRetireNotice();
    void itemLabelsStore.markHighlightReviewed(entry.itemKey, entry.highlight.id);
    reviewed += 1;
    index += 1;
  }

  // Going back is navigation, not un-reviewing: the card you already advanced
  // past keeps its stamp, so stepping back to re-read it and moving on again
  // doesn't double-count or resurrect it tomorrow. It exists so a mis-swipe
  // costs a gesture rather than the passage.
  function stepBack() {
    if (index === 0) return;
    interacted = true;
    dismissRetireNotice();
    index -= 1;
  }

  // --- Don't show again: retire from the deck without deleting anything ------
  //
  // The highlight stays in the highlights list and on Margin; it just stops
  // being dealt, on every device. Not destructive, so it takes no confirmation
  // — but the card vanishes on the press, so the undo below is what tells the
  // reader it worked and what makes the choice cheap to make.
  const RETIRE_UNDO_MS = 10000;
  let retireNotice = $state<{ entry: HighlightEntry; position: number } | null>(null);
  let retireTimer: ReturnType<typeof setTimeout> | undefined;

  function dismissRetireNotice() {
    clearTimeout(retireTimer);
    retireNotice = null;
  }

  function retireCurrent() {
    const entry = current;
    if (!entry) return;
    interacted = true;
    void itemLabelsStore.setHighlightReviewRetired(entry.itemKey, entry.highlight.id, true);
    // Drop it without stamping it reviewed — it isn't a review, it's a recusal.
    // The index stays put, so the next card slides into this one's place.
    if (deck) deck = deck.filter((card) => card.highlight.id !== entry.highlight.id);
    clearTimeout(retireTimer);
    retireNotice = { entry, position: index };
    retireTimer = setTimeout(() => (retireNotice = null), RETIRE_UNDO_MS);
  }

  function undoRetire() {
    const pending = retireNotice;
    dismissRetireNotice();
    if (!pending) return;
    void itemLabelsStore.setHighlightReviewRetired(
      pending.entry.itemKey,
      pending.entry.highlight.id,
      false
    );
    if (!deck) return;
    const restored = [...deck];
    const at = Math.min(pending.position, restored.length);
    restored.splice(at, 0, pending.entry);
    deck = restored;
    index = at;
  }

  // --- Swipe: the deck is a deck, so it should move like one -----------------
  //
  // Right carries you forward and left brings the last card back, matching the
  // arrow keys and the Next button rather than inventing a second grammar. The
  // card follows the finger and commits on release, so a half-swipe shows you
  // what it would do and springs back when you don't mean it. Touch only: on a
  // pointer, dragging a passage is how you select it.
  const AXIS_DECIDE_PX = 8;
  const COMMIT_RATIO = 0.22;
  const FLICK_VELOCITY = 0.4; // px per ms
  const EXIT_MS = 190;
  const ENTER_MS = 260;
  const SETTLE_MS = 240;

  let cardEl = $state<HTMLElement | null>(null);
  let dragX = $state(0);
  let travelMs = $state(0);
  let animating = $state(false);

  // The card thins out as it leaves rather than sliding at full strength, so the
  // passage reads as handed off instead of yanked away.
  let cardOpacity = $derived(
    dragX === 0 ? 1 : Math.max(0.25, 1 - Math.abs(dragX) / ((cardEl?.offsetWidth || 480) * 0.9))
  );

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    );
  }

  function resetTravel() {
    travelMs = 0;
    dragX = 0;
    animating = false;
  }

  function settleBack() {
    travelMs = prefersReducedMotion() ? 0 : SETTLE_MS;
    dragX = 0;
  }

  /** Commit a swipe: 1 moves forward through the deck, -1 steps back. */
  function commitSwipe(direction: 1 | -1) {
    if (animating) return;
    if (direction === -1 && index === 0) {
      settleBack();
      return;
    }
    if (prefersReducedMotion()) {
      resetTravel();
      if (direction === 1) advance();
      else stepBack();
      return;
    }
    animating = true;
    travelMs = EXIT_MS;
    dragX = direction * ((cardEl?.offsetWidth || 480) + 64);
    setTimeout(() => {
      if (direction === 1) advance();
      else stepBack();
      // Nothing left to fly in — the end-of-deck state takes the column.
      if (!deck || index >= deck.length) {
        resetTravel();
        return;
      }
      // Land the incoming card from the side the outgoing one left toward.
      travelMs = 0;
      dragX = -direction * Math.min((cardEl?.offsetWidth || 480) * 0.18, 88);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          travelMs = ENTER_MS;
          dragX = 0;
          setTimeout(() => (animating = false), ENTER_MS);
        })
      );
    }, EXIT_MS);
  }

  let touchStartX = 0;
  let touchStartY = 0;
  let touchLastX = 0;
  let touchLastT = 0;
  let touchVelocity = 0;
  let touchDecided = false;
  let dragging = false;

  function hasActiveSelection(): boolean {
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
  }

  function onTouchStart(event: TouchEvent) {
    if (animating || event.touches.length !== 1) {
      dragging = false;
      touchDecided = false;
      return;
    }
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    touchLastX = touchStartX;
    touchLastT = performance.now();
    touchVelocity = 0;
    touchDecided = false;
    dragging = false;
  }

  function onTouchMove(event: TouchEvent) {
    if (animating || event.touches.length !== 1) return;
    const x = event.touches[0].clientX;
    const dx = x - touchStartX;
    const dy = event.touches[0].clientY - touchStartY;
    if (!touchDecided) {
      if (Math.abs(dx) < AXIS_DECIDE_PX && Math.abs(dy) < AXIS_DECIDE_PX) return;
      touchDecided = true;
      // Vertical intent scrolls the page; a live selection belongs to the
      // browser's own handles, not to us.
      if (Math.abs(dx) > Math.abs(dy) && !hasActiveSelection()) {
        dragging = true;
        travelMs = 0;
      }
    }
    if (!dragging) return;
    if (hasActiveSelection()) {
      dragging = false;
      settleBack();
      return;
    }
    if (event.cancelable) event.preventDefault();
    // There's nothing behind the first card, so a leftward pull resists rather
    // than promising a move that can't happen.
    dragX = dx < 0 && index === 0 ? dx * 0.28 : dx;
    const now = performance.now();
    const dt = now - touchLastT;
    if (dt > 0) touchVelocity = (x - touchLastX) / dt;
    touchLastX = x;
    touchLastT = now;
  }

  function onTouchEnd() {
    const wasDragging = dragging;
    dragging = false;
    touchDecided = false;
    if (!wasDragging) return;
    const width = cardEl?.offsetWidth || 480;
    const far = Math.abs(dragX) > width * COMMIT_RATIO;
    const flicked = Math.abs(touchVelocity) > FLICK_VELOCITY && Math.abs(dragX) > 24;
    if (!far && !flicked) {
      settleBack();
      return;
    }
    commitSwipe(dragX > 0 ? 1 : -1);
  }

  // touchmove has to be non-passive to claim the horizontal gesture, so it's
  // attached by hand rather than through the (passive) on* attributes.
  $effect(() => {
    const el = cardEl;
    if (!el) return;
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  });

  $effect(() => () => clearTimeout(retireTimer));

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
      if (!animating) commitSwipe(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!animating && index > 0) commitSwipe(-1);
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

  // Finishing the deck is where the day's review ends by design, but a reader
  // who wants to keep going shouldn't have to leave and come back to do it.
  //
  // Two shapes of "more". While highlights are still due today, another hand is
  // genuinely the next ones due — the hand just finished stamped its own cards,
  // so they can't come back. Once the day's portion is spent, "more" can only
  // mean going around again, which the button says plainly rather than dressing
  // up with a count.
  let moreDue = $derived(highlightReviewStore.dueCount);
  let isEncore = $derived(moreDue === 0);
  let canReviewMore = $derived(highlightReviewStore.hasHighlights);

  function reviewMore() {
    encoreMode = isEncore;
    index = 0;
    interacted = false;
    dismissRetireNotice();
    resetTravel();
    dealDeck();
  }

  // --- Settings, in reach of the deck they configure (deck size, Margin
  // ingest). An inline disclosure rather than an overlay: the page is one card
  // tall, so there's nothing for a modal to protect.
  let settingsOpen = $state(false);

  // An import that lands while the reader hasn't started should join this
  // session — turning the toggle on and still reading "nothing to review" is
  // the opposite of what the control promised.
  function handleSettingsImport() {
    if (deckUntouched({ index, interacted })) dealDeck();
  }

  // --- Mobile chrome. The installed PWA has no browser back button, so the
  // bottom bar's switcher is the only way off this page down here. The deck
  // doesn't scroll, so the bar stays put rather than riding scroll direction.
  let feedSwitcherOpen = $state(false);
  let notifSheetOpen = $state(false);

  // Channel create/edit routes through the always-mounted sidebar modal, the
  // same way the highlights list does it.
  function handleCreateChannel(type: 'feed' | 'saved' = 'feed') {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(null, type);
  }

  function handleEditChannel(id: number) {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(id);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet moreButton()}
  {#if canReviewMore}
    <button class="more" onclick={reviewMore}>
      <span>{isEncore ? 'Review more' : `Review ${moreDue} more`}</span>
      <Icon name="arrow-right" size={16} />
    </button>
    {#if isEncore}
      <p class="more-note">This brings back the ones you saw earliest today.</p>
    {/if}
  {/if}
{/snippet}

<div class="review-page">
  <header class="review-header">
    <div class="header-inner">
      <div class="header-nav"><NavigationDropdown currentTitle="Review" /></div>
      <div class="header-actions">
        {#if current}
          <button
            class="step-back"
            onclick={() => commitSwipe(-1)}
            disabled={index === 0 || animating}
            title="Previous highlight (left arrow)"
            aria-label="Previous highlight"
          >
            <Icon name="chevron-left" size={16} />
          </button>
          <span class="progress">{index + 1} of {total}</span>
        {/if}
        <button
          class="gear"
          class:open={settingsOpen}
          onclick={() => (settingsOpen = !settingsOpen)}
          aria-expanded={settingsOpen}
          aria-controls="review-settings"
          title="Review settings"
          aria-label="Review settings"
        >
          <Icon name="settings" size={16} />
        </button>
      </div>
    </div>
  </header>

  <div class="review-body">
    {#if settingsOpen}
      <section id="review-settings" class="settings-panel" aria-label="Review settings">
        <HighlightSettings returnUrl="/highlights/review" onImported={handleSettingsImport} />
      </section>
    {/if}

    {#if !ready || !deck}
      <p class="state-note" aria-live="polite">Gathering your highlights…</p>
    {:else if current && source && live}
      <article
        class="deck-card"
        bind:this={cardEl}
        style:transform={dragX === 0 ? undefined : `translate3d(${dragX}px, 0, 0)`}
        style:opacity={cardOpacity === 1 ? undefined : cardOpacity}
        style:transition={travelMs === 0
          ? 'none'
          : `transform ${travelMs}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${travelMs}ms ease`}
      >
        <blockquote class="passage">{live.selector.exact}</blockquote>

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
          <div class="lead">
            <button class="next" onclick={() => commitSwipe(1)} disabled={animating}>
              <span>{index + 1 === total ? 'Finish' : 'Next'}</span>
              <Icon name="arrow-right" size={16} />
            </button>

            <button
              class="retire"
              onclick={retireCurrent}
              title="Keep the highlight, stop dealing it in review"
            >
              <Icon name="circle-slash" size={15} />
              <span>Don't show again</span>
            </button>
          </div>

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

      <p class="hint">→ next · ← back · o open · e note</p>
      {#if index === 0 && total > 1}
        <p class="swipe-hint">Swipe to move through the deck.</p>
      {/if}
    {:else if done && reviewed > 0}
      <section class="state" aria-live="polite">
        <h1>That's your review</h1>
        <p>{reviewed} highlight{reviewed === 1 ? '' : 's'} revisited.</p>
        {@render moreButton()}
        <a href="/highlights">All highlights</a>
      </section>
    {:else if canReviewMore}
      <!-- Highlights exist, but today's portion is already spent — arrived at by
           coming back after a session rather than by finishing one here. -->
      <section class="state" aria-live="polite">
        <h1>That's today's review</h1>
        <p>Come back tomorrow for the next handful.</p>
        {@render moreButton()}
        <a href="/highlights">All highlights</a>
      </section>
    {:else}
      <section class="state" aria-live="polite">
        <h1>Nothing to review right now</h1>
        <p>Highlight a passage while reading and it joins the deck.</p>
        <a href="/highlights">All highlights</a>
      </section>
    {/if}

    {#if retireNotice}
      <p class="retired-note" aria-live="polite">
        <span>Kept, but it won't come up in review again.</span>
        <button onclick={undoRetire}>Undo</button>
      </p>
    {/if}
  </div>

  {#if mobileStore.isMobile && !readerItem}
    <MobileBottomBar
      controlsVisible={true}
      currentTitle="Review"
      onScrollToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
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
        currentTitle="Review"
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

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .progress {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* Where you are in the deck and how to go back belong together, so the back
     control sits with the count rather than in the card. */
  .step-back {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-right: -0.375rem;
    padding: 0;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color 0.15s ease,
      background-color 0.15s ease,
      opacity 0.15s ease;
  }

  .step-back:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .step-back:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .gear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
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

  .gear:hover,
  .gear.open {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  /* Flat by default: a bordered panel in the column, not a floating sheet. */
  .settings-panel {
    margin-bottom: 1.5rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  /* `overflow-x: clip` gives the card somewhere to go on a swipe without turning
     the column into a scroll container. */
  .review-body {
    max-width: 680px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    overflow-x: clip;
  }

  @media (max-width: 1000px) {
    /* The bottom bar owns navigation down here, so the header keeps only what
       the bar can't carry: where you are in the deck, and the settings for it.
       Those two take the full width rather than huddling on one side. */
    .header-nav {
      display: none;
    }

    .header-actions {
      flex: 1;
    }

    /* Right-aligned whether or not there's a progress count beside it — the
       end-of-deck states have no progress but still want their settings. */
    .gear {
      margin-left: auto;
    }

    .review-body {
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }

  /* The card is the highlight, so marking the passage would be marking the whole
     surface. No gold, no chrome: the reader's own article face at reading size,
     alone in the column, with everything else stepping back to metadata scale.
     `touch-action: pan-y` leaves vertical scrolling to the page and claims the
     horizontal axis for the swipe. */
  .deck-card {
    display: flex;
    flex-direction: column;
    padding-top: clamp(0.5rem, 3vh, 1.5rem);
    touch-action: pan-y;
  }

  .passage {
    margin: 0;
    font-family: var(--article-font);
    font-size: calc(var(--article-font-size, 1.125rem) * 1.15);
    line-height: 1.55;
    color: var(--color-text);
    text-wrap: pretty;
  }

  .note {
    margin: 1.25rem 0 0;
    padding-left: 0.875rem;
    border-left: 1px solid var(--color-border);
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
    margin-top: 2rem;
    padding: 0;
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
    gap: 0.75rem 1rem;
    flex-wrap: wrap;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }

  /* The two decisions a card asks for — move on, or stop asking — sit together;
     the icon cluster stays what it was, tools rather than decisions. */
  .lead {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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

  .next:hover:not(:disabled) {
    filter: brightness(0.95);
  }

  .next:disabled {
    cursor: default;
  }

  /* Not destructive and not urgent: nothing is deleted, so it stays a quiet
     bordered control rather than borrowing the danger red. */
  .retire {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 44px;
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .retire:hover {
    color: var(--color-text);
    border-color: var(--color-text-secondary);
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

  .hint,
  .swipe-hint {
    margin: 1.5rem 0 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  /* Retiring makes the card disappear, so this line is the only proof the press
     did what it said — and the only cheap way back from a mis-tap. */
  .retired-note {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    margin: 1.5rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .retired-note button {
    padding: 0;
    background: none;
    border: none;
    color: var(--color-primary);
    font: inherit;
    font-weight: var(--weight-semibold);
    cursor: pointer;
  }

  .retired-note button:hover {
    text-decoration: underline;
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

  /* Quiet: another hand is offered, not urged. The primary button belongs to
     the card you're reading, not to going around again. */
  .more {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    width: fit-content;
    min-height: 44px;
    margin-top: 0.5rem;
    padding: 0.5rem 1.1rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: none;
    color: var(--color-text);
    font: inherit;
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .more:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .more-note {
    font-size: var(--text-sm);
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

  /* The keyboard hint is meaningless without a keyboard, and the swipe cue is
     meaningless with one. */
  @media (hover: none) {
    .hint {
      display: none;
    }
  }

  @media (hover: hover) {
    .swipe-hint {
      display: none;
    }
  }

  @media (max-width: 560px) {
    /* Two decisions deserve the full width down here; the tools follow beneath. */
    .lead {
      width: 100%;
    }

    .retire {
      flex: 1;
      justify-content: center;
    }

    .secondary {
      width: 100%;
    }
  }

  /* The card's travel is driven from script (it follows a finger), so the
     reduced-motion path lives there too — commits jump rather than slide. This
     covers the declarative transitions around it. */
  @media (prefers-reduced-motion: reduce) {
    .step-back,
    .next,
    .retire,
    .action-btn,
    .gear,
    .more {
      transition: none;
    }
  }
</style>
