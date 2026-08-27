<script lang="ts">
  // Highlight review — a finite deck of a handful of highlights, one card at a
  // time. Deliberately not a durable issue like the daily magazine: a session is
  // a few minutes, so the deck is derived at open and repeat-avoidance rides the
  // per-highlight `lastReviewedAt` stamp, which syncs with the highlight itself.
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
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
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
    REVIEW_INTENT_DEFAULT,
    shouldRedealAfterImport,
    type HighlightEntry,
  } from '$lib/utils/highlightReview';
  import type { ReviewIntent } from '$lib/types';
  import {
    buildHighlightSourceLookups,
    resolveHighlightSource,
    type HighlightSource,
  } from '$lib/utils/highlightSource';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';

  $effect(() => {
    viewTitleStore.set('Review');
    return () => viewTitleStore.set('');
  });

  let sourceLookups = $derived(
    buildHighlightSourceLookups(
      articlesStore.allArticles,
      socialStore.documents,
      savesStore.articles,
      subscriptionsStore.subscriptions
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
  // What this hand has already tallied. Stepping back and coming forward again
  // is navigation, not a second review — and the deck can shrink underneath the
  // reader (a retire, a removal), so a position high-water mark would then skip
  // the card that slid into a place already passed. The highlight is the mark.
  // Plain, not `$state`: `reviewed` is the reactive half, this only gates it.
  let countedThisHand = new Set<string>();

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
  // the deck itself holds the highlight as it was when the deck was dealt. Taken
  // per entry rather than only for the current one, because the cards on either
  // side of it are on screen during a swipe and have to show the same truth.
  function liveOf(entry: HighlightEntry): HighlightEntry['highlight'] {
    return (
      itemLabelsStore.getHighlights(entry.itemKey).find((h) => h.id === entry.highlight.id) ??
      entry.highlight
    );
  }

  function sourceOf(entry: HighlightEntry): HighlightSource | null {
    return resolveHighlightSource(entry.itemKey, entry.itemType, sourceLookups, liveOf(entry));
  }

  let live = $derived(current ? liveOf(current) : null);
  let source = $derived(current ? sourceOf(current) : null);
  let done = $derived(Boolean(deck) && ready && index >= total);

  function advance() {
    const entry = current;
    if (!entry) return;
    interacted = true;
    intentOpen = false;
    dismissRetireNotice();
    void itemLabelsStore.markHighlightReviewed(entry.itemKey, entry.highlight.id);
    if (!countedThisHand.has(entry.highlight.id)) {
      countedThisHand.add(entry.highlight.id);
      reviewed += 1;
    }
    index += 1;
  }

  // Going back is navigation, not un-reviewing: the card you already advanced
  // past keeps its stamp, so stepping back to re-read it and moving on again
  // doesn't double-count or resurrect it tomorrow. It exists so a mis-swipe
  // costs a gesture rather than the passage.
  function stepBack() {
    if (index === 0) return;
    interacted = true;
    intentOpen = false;
    dismissRetireNotice();
    index -= 1;
  }

  // --- Frequency tuning: when should this one come back? --------------------
  //
  // One control per card answering one question. 'later' is the neutral middle
  // and the default, so an untuned highlight reads as "Later" rather than as an
  // empty setting. 'never' is the only choice that changes this session: it
  // drops the card, which is why it alone gets the undo below.
  const REVIEW_INTENTS: { value: ReviewIntent; label: string; hint: string }[] = [
    { value: 'soon', label: 'Soon', hint: 'ahead of the rest' },
    { value: 'later', label: 'Later', hint: 'the usual pace' },
    { value: 'someday', label: 'Someday', hint: 'now and then' },
    { value: 'never', label: 'Never', hint: 'stop showing it' },
  ];

  let intentOpen = $state(false);
  let intentAnchor = $state<HTMLElement | null>(null);
  let currentIntent = $derived<ReviewIntent>(live?.reviewIntent ?? REVIEW_INTENT_DEFAULT);
  let currentIntentLabel = $derived(
    REVIEW_INTENTS.find((option) => option.value === currentIntent)?.label ?? 'Later'
  );

  function openIntentMenu() {
    // Freeze before the menu opens: the import can finish while it's up, and the
    // setting must land on the card the reader was looking at.
    interacted = true;
    intentOpen = true;
  }

  function chooseIntent(intent: ReviewIntent) {
    const entry = current;
    intentOpen = false;
    if (!entry) return;
    interacted = true;
    // Captured before the write, because undo has to put back the pace the
    // reader was on, not the default. Read from `live`, not the deck entry: the
    // deck holds the highlight as it was dealt, so a reader who sets Soon and
    // then Never on the same card would otherwise undo to the default.
    const previous = (live ?? entry.highlight).reviewIntent ?? null;
    // Passing null for the default keeps an untuned highlight untouched rather
    // than writing a field that means "unset" anyway.
    void itemLabelsStore.setHighlightReviewIntent(
      entry.itemKey,
      entry.highlight.id,
      intent === REVIEW_INTENT_DEFAULT ? null : intent
    );
    if (intent === 'never') dropCurrentCard(entry, previous);
  }

  // 'never' is the one setting that acts on this session. The card vanishes on
  // the press, so this notice is the only proof it worked and the only cheap way
  // back from a mis-tap.
  const RETIRE_UNDO_MS = 10000;
  let retireNotice = $state<{
    entry: HighlightEntry;
    position: number;
    /** The pace the highlight was on before Never, so undo can put it back. */
    previous: ReviewIntent | null;
  } | null>(null);
  let retireTimer: ReturnType<typeof setTimeout> | undefined;

  function dismissRetireNotice() {
    clearTimeout(retireTimer);
    retireNotice = null;
  }

  function dropCurrentCard(entry: HighlightEntry, previous: ReviewIntent | null) {
    // Dropped without a reviewed stamp — it isn't a review, it's a recusal. The
    // index stays put, so the next card slides into this one's place.
    if (deck) deck = deck.filter((card) => card.highlight.id !== entry.highlight.id);
    clearTimeout(retireTimer);
    retireNotice = { entry, position: index, previous };
    retireTimer = setTimeout(() => (retireNotice = null), RETIRE_UNDO_MS);
  }

  function undoRetire() {
    const pending = retireNotice;
    dismissRetireNotice();
    if (!pending) return;
    // Undo means "as you were", so restore the pace Never replaced. Writing null
    // here would quietly reset a 'soon' or 'someday' highlight to the default.
    void itemLabelsStore.setHighlightReviewIntent(
      pending.entry.itemKey,
      pending.entry.highlight.id,
      pending.previous
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
  // Three rules, in the order they matter:
  //
  //  1. Two cards, always. Going forward, the next card was already underneath
  //     and gets uncovered as the front one leaves; going back, the card you
  //     passed comes over the top from the right. Nothing waits offstage and
  //     flies in after a gap, because that isn't a thing cards do.
  //  2. The moving card lifts. At rest the passage is flat text in the column
  //     like everything else here; the moment it moves it takes a surface and a
  //     shadow. That lift is most of why a swipe reads as a card at all rather
  //     than as text sliding around.
  //  3. Weight. The card pivots around wherever the finger took hold of it, and
  //     it leaves at the speed it was thrown — a flick snaps out, a shove drifts.
  //  4. Up is out of the deck. Across moves through it; lifting a card off the
  //     top is how you say never show this one again, which is the one thing a
  //     card can do that isn't navigation.
  //
  // Touch only: on a pointer, dragging a passage is how you select it.
  const AXIS_DECIDE_PX = 8;
  const COMMIT_RATIO = 0.22;
  const FLICK_VELOCITY = 0.4; // px per ms
  const SETTLE_MS = 260;
  const MIN_EXIT_MS = 140;
  const MAX_EXIT_MS = 320;
  /** Speed floor, px/ms, so a pressed button throws the card as firmly as a hand. */
  const MIN_EXIT_SPEED = 1.6;
  /** Clear air between the card that left and the one that took its place. */
  const DECK_GAP = 32;
  const MAX_TILT_DEG = 4.5;
  /** How far up a card has to go before letting go retires it, as a share of its
      own height — capped, so a very tall passage doesn't ask for a whole arm. */
  const RETIRE_RATIO = 0.2;
  const RETIRE_MAX_PX = 150;
  /** Back drags move the incoming card faster than the finger: it starts a whole
      card-width offstage, and 1:1 would mean crossing the screen to see it. */
  const BACK_GAIN = 2.2;
  // A thrown card barely slows down before it's gone. Easing out hard is the
  // tell that nothing was really thrown.
  const EXIT_EASE = 'cubic-bezier(0.25, 0.6, 0.4, 1)';
  // One that didn't go far enough drops back into the stack with a little
  // overshoot rather than gliding to a halt.
  const SETTLE_EASE = 'cubic-bezier(0.22, 1.3, 0.42, 1)';

  let cardEl = $state<HTMLElement | null>(null);
  let dragX = $state(0);
  let dragY = $state(0);
  let travelMs = $state(0);
  let travelEase = $state(EXIT_EASE);
  let animating = $state(false);
  let dragging = false;
  /** Measured on grab rather than derived, so a mid-flight resize can't restate
      the geometry the animation in progress was aimed at. */
  let cardWidth = $state(480);
  let cardHeight = $state(420);
  /** What the deck is doing. Held rather than read off the drag offsets, because
      a card springing back is still mid-gesture at 0 and the card behind it has
      to stay where it is until the spring is done. */
  let gesture = $state<'none' | 'forward' | 'back' | 'retire'>('none');
  /** Whether the finger took the card by its top half. Paper pivots around a
      point on the far side of the grip, so this decides which way it swings. */
  let grabbedTop = $state(true);

  let nextEntry = $derived(deck && index + 1 < deck.length ? deck[index + 1] : null);
  let prevEntry = $derived(deck && index > 0 ? deck[index - 1] : null);
  /** The card underneath shows whenever this one is leaving, whether it's being
      moved past or lifted out; the one coming back over the top only going back. */
  let showUnder = $derived((gesture === 'forward' || gesture === 'retire') && Boolean(nextEntry));
  let showOver = $derived(gesture === 'back' && Boolean(prevEntry));

  // Going back, the front card isn't the one moving — it's being covered — so it
  // only drifts, and it doesn't tilt.
  let coveredByPrev = $derived(gesture === 'back' && Boolean(prevEntry));

  let tilt = $derived.by(() => {
    if (coveredByPrev || dragX === 0) return 0;
    const raw = (dragX / cardWidth) * 14;
    const capped = Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, raw));
    return grabbedTop ? capped : -capped;
  });

  let frontTransform = $derived(
    dragX === 0 && dragY === 0
      ? undefined
      : `translate3d(${coveredByPrev ? dragX * 0.05 : dragX}px, ${dragY}px, 0) rotate(${tilt}deg)`
  );
  // Far outside the card, on the side away from the grip.
  let frontOrigin = $derived(grabbedTop ? '50% 220%' : '50% -120%');

  /** The lift a release has to beat to retire the card. */
  let retireDistance = $derived(Math.min(RETIRE_MAX_PX, cardHeight * RETIRE_RATIO));
  /** Far enough up that letting go now would stop showing this highlight. */
  let retireArmed = $derived(gesture === 'retire' && -dragY >= retireDistance);

  /** How far the deck has been pushed, 0..1 — what the card underneath rises on. */
  let uncovered = $derived(
    gesture === 'retire'
      ? Math.min(1, -dragY / (retireDistance * 1.6))
      : Math.min(1, Math.abs(dragX) / (cardWidth * 0.55))
  );
  let underTransform = $derived(
    `translate3d(0, ${((1 - uncovered) * 10).toFixed(2)}px, 0) scale(${(0.94 + 0.06 * uncovered).toFixed(4)})`
  );
  let underOpacity = $derived(0.35 + 0.65 * uncovered);
  let overTransform = $derived(
    `translate3d(${Math.min(0, -(cardWidth + DECK_GAP) + dragX * BACK_GAIN).toFixed(2)}px, 0, 0)`
  );

  // The lift is never animated with the travel: a card under the finger has to
  // track it exactly, so only the surface it takes on fades in.
  const LIFT_TRANSITION = 'box-shadow 0.18s ease, border-radius 0.18s ease';
  let cardTransition = $derived(
    travelMs === 0
      ? LIFT_TRANSITION
      : `transform ${travelMs}ms ${travelEase}, opacity ${travelMs}ms ${travelEase}, ${LIFT_TRANSITION}`
  );

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    );
  }

  function resetTravel() {
    clearTimeout(settleTimer);
    travelMs = 0;
    dragX = 0;
    dragY = 0;
    gesture = 'none';
    animating = false;
  }

  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function settleBack() {
    if (prefersReducedMotion()) {
      resetTravel();
      return;
    }
    travelEase = SETTLE_EASE;
    travelMs = SETTLE_MS;
    dragX = 0;
    dragY = 0;
    // The gesture is still live until the card is home: dropping it now would
    // yank the card behind out of the picture while the front one is still
    // sliding back over it. A hand that's already taken hold again by then owns
    // the deck, so the spring doesn't get to end its gesture.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (animating || dragging) return;
      gesture = 'none';
      travelMs = 0;
    }, SETTLE_MS);
  }

  // Leaving the deck mid-flight would otherwise leave callbacks queued against a
  // component that no longer exists, the last of them clearing a freeze flag the
  // next mount never set.
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let mountFrame = 0;

  $effect(() => () => {
    clearTimeout(exitTimer);
    clearTimeout(settleTimer);
    cancelAnimationFrame(mountFrame);
  });

  /** Commit a swipe: 1 moves forward through the deck, -1 steps back. */
  function commitSwipe(direction: 1 | -1, velocity = 0) {
    if (animating) return;
    if (direction === -1 && index === 0) {
      settleBack();
      return;
    }
    // Freeze here rather than in advance()/stepBack(): those run a frame-time
    // later, and an import resolving inside that window would find the deck
    // untouched and redeal it out from under the card already flying off.
    interacted = true;
    if (prefersReducedMotion()) {
      resetTravel();
      if (direction === 1) advance();
      else stepBack();
      return;
    }
    clearTimeout(settleTimer);
    measureCard();
    animating = true;
    const fromRest = gesture === 'none';
    gesture = direction === 1 ? 'forward' : 'back';
    if (fromRest) {
      // A press, not a drag: the second card hasn't been mounted yet, and it has
      // to exist at its resting position for a frame before it can animate off
      // it. Two frames — one to mount, one to let the browser see it there.
      grabbedTop = true;
      travelMs = 0;
      dragX = 0;
      mountFrame = requestAnimationFrame(() => {
        mountFrame = requestAnimationFrame(() => throwCard(direction, velocity));
      });
    } else {
      throwCard(direction, velocity);
    }
  }

  function throwCard(direction: 1 | -1, velocity: number) {
    // Back drags are geared up, so the finger's speed isn't the card's speed.
    const gain = direction === 1 ? 1 : BACK_GAIN;
    const target = direction === 1 ? -(cardWidth + DECK_GAP) : (cardWidth + DECK_GAP) / BACK_GAIN;
    const travel = Math.abs(target - dragX) * gain;
    const speed = Math.max(Math.abs(velocity) * gain, MIN_EXIT_SPEED);
    const ms = Math.round(Math.min(MAX_EXIT_MS, Math.max(MIN_EXIT_MS, travel / speed)));
    travelEase = EXIT_EASE;
    travelMs = ms;
    dragX = target;
    exitTimer = setTimeout(() => {
      if (direction === 1) advance();
      else stepBack();
      // The card that was underneath — or the one that came over the top — is
      // the card now, already sitting exactly where it belongs. Nothing to fly
      // in: drop the travel and let it stand.
      resetTravel();
    }, ms);
  }

  /** Lift the card off the deck for good: it goes out the top and the highlight
      is set to never come back. Not a review — the card is being recused, which
      is why it leaves through `chooseIntent` and takes the undo notice with it. */
  function commitRetire(velocity = 0) {
    if (animating) return;
    const entry = current;
    if (!entry) return;
    interacted = true;
    if (prefersReducedMotion()) {
      resetTravel();
      chooseIntent('never');
      return;
    }
    clearTimeout(settleTimer);
    measureCard();
    animating = true;
    const fromRest = gesture === 'none';
    gesture = 'retire';
    if (fromRest) {
      travelMs = 0;
      dragY = 0;
      mountFrame = requestAnimationFrame(() => {
        mountFrame = requestAnimationFrame(() => throwCardOut(velocity));
      });
    } else {
      throwCardOut(velocity);
    }
  }

  function throwCardOut(velocity: number) {
    const target = -(cardHeight + DECK_GAP);
    const speed = Math.max(Math.abs(velocity), MIN_EXIT_SPEED);
    const ms = Math.round(
      Math.min(MAX_EXIT_MS, Math.max(MIN_EXIT_MS, Math.abs(target - dragY) / speed))
    );
    travelEase = EXIT_EASE;
    travelMs = ms;
    dragY = target;
    exitTimer = setTimeout(() => {
      // Still the card that was thrown: `chooseIntent` reads `current`, and the
      // deck hasn't moved under it yet.
      chooseIntent('never');
      resetTravel();
    }, ms);
  }

  function measureCard() {
    cardWidth = cardEl?.offsetWidth || cardWidth;
    cardHeight = cardEl?.offsetHeight || cardHeight;
  }

  /** An upward swipe is only ours when the page has nothing left to scroll —
      otherwise up means read on, and the card has no claim on it. This decides
      `touch-action` too, so it has to be known before the finger lands, not
      measured once it has. */
  let pageScrollable = $state(false);

  $effect(() => {
    const measure = () => {
      const doc = document.documentElement;
      pageScrollable = doc.scrollHeight - doc.clientHeight > 2;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  });

  let touchStartX = 0;
  let touchStartY = 0;
  let touchLastX = 0;
  let touchLastY = 0;
  let touchLastT = 0;
  let touchVelocity = 0;
  let touchDecided = false;
  /** Which axis this gesture claimed: across the deck, or up out of it. */
  let touchAxis: 'x' | 'y' | null = null;

  function hasActiveSelection(): boolean {
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
  }

  function onTouchStart(event: TouchEvent) {
    if (animating || intentOpen || event.touches.length !== 1) {
      // A second finger means this stopped being a swipe. Dropping the drag
      // without settling would strand the card wherever it was: `touchend` bails
      // on `!dragging`, so nothing else would ever put it back.
      abandonDrag();
      return;
    }
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    touchLastX = touchStartX;
    touchLastY = touchStartY;
    touchLastT = performance.now();
    touchVelocity = 0;
    touchDecided = false;
    touchAxis = null;
    dragging = false;
    const rect = cardEl?.getBoundingClientRect();
    cardWidth = rect?.width || cardWidth;
    cardHeight = rect?.height || cardHeight;
    grabbedTop = rect ? touchStartY - rect.top < rect.height / 2 : true;
  }

  function onTouchMove(event: TouchEvent) {
    if (animating || intentOpen || event.touches.length !== 1) return;
    const x = event.touches[0].clientX;
    const dx = x - touchStartX;
    const dy = event.touches[0].clientY - touchStartY;
    const y = event.touches[0].clientY;
    if (!touchDecided) {
      if (Math.abs(dx) < AXIS_DECIDE_PX && Math.abs(dy) < AXIS_DECIDE_PX) return;
      touchDecided = true;
      // A live selection belongs to the browser's own handles, not to us.
      if (hasActiveSelection()) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        touchAxis = 'x';
        dragging = true;
        travelMs = 0;
      } else if (dy < 0 && !pageScrollable) {
        // Up, with nothing left to read: the card comes off the deck. When the
        // page can still scroll, up means read on and this never fires — the
        // browser has the gesture, and `touch-action` has already said so.
        touchAxis = 'y';
        dragging = true;
        travelMs = 0;
        gesture = 'retire';
      }
    }
    if (!dragging) return;
    if (hasActiveSelection()) {
      dragging = false;
      settleBack();
      return;
    }
    if (event.cancelable) event.preventDefault();
    const now = performance.now();
    const dt = now - touchLastT;
    if (touchAxis === 'y') {
      // Pulled back down past where it started, the card resists rather than
      // sinking into the deck it's already on top of.
      dragY = dy < 0 ? dy : dy * 0.28;
      if (dt > 0) touchVelocity = (y - touchLastY) / dt;
    } else {
      // There's nothing behind the first card, so a rightward pull resists
      // rather than promising a move that can't happen.
      dragX = dx > 0 && index === 0 ? dx * 0.28 : dx;
      // Cross back over where the finger started and the deck follows: the
      // other card comes up, at zero offset, so there's nothing to jump.
      if (dragX < 0) gesture = 'forward';
      else if (dragX > 0) gesture = 'back';
      if (dt > 0) touchVelocity = (x - touchLastX) / dt;
    }
    touchLastX = x;
    touchLastY = y;
    touchLastT = now;
  }

  function onTouchEnd() {
    const wasDragging = dragging;
    const axis = touchAxis;
    dragging = false;
    touchDecided = false;
    touchAxis = null;
    if (!wasDragging) return;
    if (axis === 'y') {
      const lifted = -dragY;
      const far = lifted >= retireDistance;
      const flicked = touchVelocity < -FLICK_VELOCITY && lifted > 24;
      if (!far && !flicked) settleBack();
      else commitRetire(touchVelocity);
      return;
    }
    const far = Math.abs(dragX) > cardWidth * COMMIT_RATIO;
    const flicked = Math.abs(touchVelocity) > FLICK_VELOCITY && Math.abs(dragX) > 24;
    if (!far && !flicked) {
      settleBack();
      return;
    }
    commitSwipe(dragX < 0 ? 1 : -1, touchVelocity);
  }

  /** The gesture stopped being ours rather than ending: the system took it back,
      or another finger landed. Whatever the card was promising, the reader never
      released it, so it goes back on the deck instead of committing on the way
      out — a cancelled lift must not retire a highlight. A card already in
      flight is left alone; its own landing clears the travel. */
  function abandonDrag() {
    const wasDragging = dragging;
    dragging = false;
    touchDecided = false;
    touchAxis = null;
    if (wasDragging && !animating) settleBack();
  }

  // touchmove has to be non-passive to claim the gesture, so it's attached by
  // hand rather than through the (passive) on* attributes.
  $effect(() => {
    const el = cardEl;
    if (!el) return;
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', abandonDrag, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', abandonDrag);
    };
  });

  /** The intent button is the popover's anchor, but only the real card's — the
      cards behind it render the same face and must not claim it. */
  function anchorIntent(node: HTMLElement, live: boolean) {
    if (live) intentAnchor = node;
    return {
      destroy() {
        if (intentAnchor === node) intentAnchor = null;
      },
    };
  }

  $effect(() => () => clearTimeout(retireTimer));

  // --- Open the source article (in-app when we have it, else the web) ---
  // The shared reader stack, so the deck gets Back-to-close, scroll restore and a
  // `?read=` URL on the same terms as every other surface.
  const reader = useReaderStack();
  let readerItem = $derived(reader.readerItem);

  function openSource() {
    const target = source;
    if (!target) return;
    // Freeze like every other card action: going off to read the article is
    // exactly when a late import must not redeal the deck, or closing the
    // reader would land the reader on a different card than they left.
    interacted = true;
    if (target.displayItem) {
      reader.openReader(target.displayItem);
    } else if (target.url) {
      window.open(target.url, '_blank', 'noopener,noreferrer');
    }
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
    if (intentOpen && event.key === 'Escape') {
      intentOpen = false;
      intentAnchor?.focus();
      return;
    }
    // Every surface this component can put over the deck suppresses the deck's
    // own shortcuts — the mobile sheets included, or an arrow key would advance
    // and stamp a card the reader can't even see.
    if (readerItem || noteAnchor || removePrompt || intentOpen) return;
    if (feedSwitcherOpen || notifSheetOpen || !current) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // Space already belongs to whatever control has focus — it's how a button or
    // link is pressed. Claiming it here would advance the deck instead of
    // activating the button, leaving a keyboard-only reader unable to work any of
    // the deck's own controls. The arrows and letter shortcuts have no such
    // owner, so they stay live wherever focus sits.
    const activatable = target ? /^(BUTTON|A)$/.test(target.tagName) : false;

    if (event.key === 'ArrowRight' || (event.key === ' ' && !activatable)) {
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
  // A corpus that is entirely retired has nothing to deal, so it takes the same
  // branch as no highlights at all — but "highlight a passage" is the wrong
  // instruction for a reader whose list is full and whose every card says never.
  let corpusEmpty = $derived(itemLabelsStore.allHighlights.length === 0);

  function reviewMore() {
    encoreMode = isEncore;
    index = 0;
    // Per hand, not per session: an encore deals cards seen earlier today, and
    // revisiting one again really is another review.
    countedThisHand = new Set();
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

{#snippet intentChoices()}
  {#each REVIEW_INTENTS as option (option.value)}
    <!-- Never is not a pace, it's an exit: the rule says so before the label has
         to. -->
    {#if option.value === 'never'}
      <div class="intent-divider"></div>
    {/if}
    <button
      class="intent-option"
      class:selected={option.value === currentIntent}
      onclick={() => chooseIntent(option.value)}
      aria-pressed={option.value === currentIntent}
    >
      <span class="intent-check">
        {#if option.value === currentIntent}<Icon name="check" size={14} />{/if}
      </span>
      <span class="intent-label">{option.label}</span>
      <span class="intent-hint">{option.hint}</span>
    </button>
  {/each}
{/snippet}

{#snippet cardFace(entry: HighlightEntry, position: number, isCurrent: boolean)}
  {@const shown = liveOf(entry)}
  {@const src = sourceOf(entry)}
  {@const intent = shown.reviewIntent ?? REVIEW_INTENT_DEFAULT}
  {@const intentLabel = REVIEW_INTENTS.find((option) => option.value === intent)?.label ?? 'Later'}
  {@const menuOpen = isCurrent && intentOpen}

  <blockquote class="passage">{shown.selector.exact}</blockquote>

  {#if shown.note}
    <p class="note">{shown.note}</p>
  {/if}

  {#if src}
    <button class="source" onclick={openSource}>
      <span class="source-title">{src.title}</span>
      {#if src.domain}
        <span class="source-domain">{src.domain}</span>
      {/if}
    </button>
  {/if}

  <div class="actions">
    <div class="lead" class:menu-open={menuOpen}>
      <button class="next" onclick={() => commitSwipe(1)} disabled={animating}>
        <span>{position === total ? 'Finish' : 'Next'}</span>
        <Icon name="arrow-right" size={16} />
      </button>

      <button
        class="intent"
        class:open={menuOpen}
        use:anchorIntent={isCurrent}
        onclick={() => (intentOpen ? (intentOpen = false) : openIntentMenu())}
        aria-expanded={menuOpen}
        aria-haspopup="true"
        aria-label="When should this come back? Currently {intentLabel}"
        title="When should this come back?"
      >
        <Icon name="clock" size={15} />
        <span>{intentLabel}</span>
        <Icon name="chevron-down" size={14} />
      </button>

      {#if menuOpen && !mobileStore.isMobile}
        <div class="intent-menu" role="group" aria-label="When should this come back?">
          {@render intentChoices()}
        </div>
      {/if}
    </div>

    <div class="secondary">
      <button
        class="action-btn"
        data-review-note={isCurrent ? '' : undefined}
        onclick={openNoteEditor}
        title={shown.note ? 'Edit note (e)' : 'Add a note (e)'}
        aria-label={shown.note ? 'Edit note' : 'Add a note'}
      >
        <Icon name="message-circle" size={16} />
      </button>
      {#if !shown.marginUri}
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
{/snippet}

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
      <!-- A stack, not a slot: the neighbouring cards are real cards on the
           page for as long as the gesture lasts, so one can be uncovered and
           the other can come over the top. -->
      <div class="deck">
        <article
          class="deck-card"
          class:lifted={gesture !== 'none'}
          class:above-scrim={intentOpen}
          class:owns-vertical={!pageScrollable}
          bind:this={cardEl}
          style:transform={frontTransform}
          style:transform-origin={gesture === 'none' ? undefined : frontOrigin}
          style:transition={cardTransition}
        >
          <!-- The gesture says what it will do while there's still time to take
               it back. It rides the card because the card is what it's about. -->
          {#if gesture === 'retire'}
            <span class="retire-cue" class:armed={retireArmed} aria-hidden="true">
              Never show again
            </span>
          {/if}
          {@render cardFace(current, index + 1, true)}
        </article>

        {#if showUnder && nextEntry}
          <article
            class="deck-card behind under lifted"
            inert
            style:transform={underTransform}
            style:opacity={underOpacity}
            style:transition={cardTransition}
          >
            {@render cardFace(nextEntry, index + 2, false)}
          </article>
        {/if}

        {#if showOver && prevEntry}
          <article
            class="deck-card behind over lifted"
            inert
            style:transform={overTransform}
            style:transition={cardTransition}
          >
            {@render cardFace(prevEntry, index, false)}
          </article>
        {/if}
      </div>

      <p class="hint">→ or space next · ← back · o open · e note</p>
      <p class="swipe-hint">
        Swipe across to move through the deck{pageScrollable ? '.' : ', up to stop showing one.'}
      </p>
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
    {:else if corpusEmpty}
      <section class="state" aria-live="polite">
        <h1>Nothing to review right now</h1>
        <p>Highlight a passage while reading and it joins the deck.</p>
        <a href="/highlights">All highlights</a>
      </section>
    {:else}
      <!-- Highlights exist; every one of them is set to never come back. -->
      <section class="state" aria-live="polite">
        <h1>Nothing in rotation</h1>
        <p>Every highlight is set to never come back. Put one back to start again.</p>
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

{#if intentOpen && !mobileStore.isMobile}
  <!-- Click-away for the popover. Transparent, and it never covers the trigger,
       so a second press on the button closes rather than reopening. -->
  <button class="intent-scrim" onclick={() => (intentOpen = false)} tabindex="-1" aria-hidden="true"
  ></button>
{/if}

{#if mobileStore.isMobile}
  <BottomSheet
    open={intentOpen}
    onclose={() => (intentOpen = false)}
    title="When should this come back?"
  >
    <div class="intent-sheet">
      {@render intentChoices()}
    </div>
  </BottomSheet>
{/if}

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
  <SavedReader {readerItem} onClose={reader.closeReader} />
{/if}

<style>
  /* The clip sits out here, not on the reading column: a card thrown off the
     deck should leave the screen, not vanish at the edge of the column while
     it's still in plain sight. Horizontal only — clipping the vertical too
     would take the intent popover's bottom off with it. `clip` (not `hidden`)
     so this doesn't become a scroll container and take the sticky header down
     with it. */
  .review-page {
    width: 100%;
    overflow-x: clip;
  }

  /* Flat header matching the highlights page: no border at rest, no shadow. */
  .review-header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--color-bg);
  }

  /* A card lifted out of the deck goes up and under the header, and the shell
     leaves a strip of page above it for the card to show through. The header
     carries its own background up over that strip rather than the page getting
     clipped to hide it. */
  .review-header::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    height: 2rem;
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

  .review-body {
    max-width: 680px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
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

  /* The three cards share one cell, so one can sit under the other. Height comes
     from the front card; the others are laid over or under it and take no room. */
  .deck {
    position: relative;
  }

  /* The card is the highlight, so marking the passage would be marking the whole
     surface. No gold, no chrome: the reader's own article face at reading size,
     alone in the column, with everything else stepping back to metadata scale.
     `touch-action: pan-y` leaves vertical scrolling to the page and claims the
     horizontal axis for the swipe.

     The horizontal padding is cancelled by an equal negative margin, so the
     painted surface reaches the full width of the column while the text stays
     exactly where it sat before there was a surface at all. */
  .deck-card {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    padding-top: clamp(0.5rem, 3vh, 1.5rem);
    padding-inline: 1rem;
    margin-inline: -1rem;
    background: var(--color-bg);
    touch-action: pan-y;
    will-change: transform;
  }

  /* Flat by default, like the rest of the app — and a real object the moment it
     moves. This is the one state where the passage is genuinely floating over
     the page, which is what a shadow is for. */
  .deck-card.lifted {
    border-radius: 12px;
    box-shadow:
      0 1px 2px rgb(0 0 0 / 8%),
      0 18px 40px -14px rgb(0 0 0 / 28%);
  }

  @media (prefers-color-scheme: dark) {
    .deck-card.lifted {
      box-shadow:
        0 1px 2px rgb(0 0 0 / 30%),
        0 18px 40px -12px rgb(0 0 0 / 60%);
    }
  }

  /* The card now stacks (it has to, to sit over the one behind it), which puts
     its popover inside its own stacking context — under the click-away scrim
     unless the whole card comes up with it. */
  .deck-card.above-scrim {
    z-index: 3;
  }

  .deck-card.behind {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
  }

  /* The next card was always under this one, at its own size — a deck of uneven
     cards is uneven, and squaring it to the front card's height would mean the
     surface changing shape at the moment the two swap. */
  .deck-card.under {
    z-index: 0;
  }

  /* With nothing left to scroll, the card takes the vertical axis too, so an
     upward swipe can lift it out of the deck. Pinch-zoom is never ours to take. */
  .deck-card.owns-vertical {
    touch-action: pinch-zoom;
  }

  /* Hung off the bottom edge of the card, because the card is on its way up and
     out: a tag at the top would be off the screen before it could be read.
     Metadata scale, quiet border, no red — nothing is being deleted here, the
     highlight is only being taken out of rotation. It firms up once the card is
     far enough that letting go would do it. */
  .retire-cue {
    position: absolute;
    bottom: -0.85rem;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.25rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    white-space: nowrap;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .retire-cue.armed {
    color: var(--color-text);
    border-color: var(--color-text-secondary);
  }

  /* The one you already passed, coming back over the top. */
  .deck-card.over {
    z-index: 2;
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

  /* Nothing here is destructive, so the control stays a quiet bordered button
     rather than borrowing the danger red. It carries its own state as its
     label: the card always says where this highlight sits on the scale. */
  .intent {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 44px;
    padding: 0.5rem 0.75rem 0.5rem 0.9rem;
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

  .intent:hover,
  .intent.open {
    color: var(--color-text);
    border-color: var(--color-text-secondary);
  }

  /* The popover floats above the page, so it is one of the few things in this
     system that earns a shadow. */
  .lead {
    position: relative;
  }

  .lead.menu-open {
    z-index: 2;
  }

  .intent-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 2;
    min-width: 240px;
    padding: 0.25rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 15%);
  }

  /* Diffuse shadow reads weakly on a dark surface, so it carries a night value
     at roughly triple the alpha. */
  @media (prefers-color-scheme: dark) {
    .intent-menu {
      box-shadow: 0 4px 12px rgb(0 0 0 / 40%);
    }
  }

  .intent-scrim {
    position: fixed;
    inset: 0;
    z-index: 1;
    padding: 0;
    background: none;
    border: none;
    cursor: default;
  }

  .intent-sheet {
    display: flex;
    flex-direction: column;
    padding-bottom: 0.5rem;
  }

  /* A fixed label track rather than a content-sized one, so the hints line up
     across rows. Subgrid would express the intent better but its tracks are
     placed on the parent's content box, which stops coinciding the moment the
     row carries padding of its own. */
  .intent-option {
    display: grid;
    grid-template-columns: 14px 5.5rem 1fr;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .intent-divider {
    height: 1px;
    margin: 0.25rem 0.625rem;
    background: var(--color-border);
  }

  .intent-option:hover {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  /* Fixed-width gutter so the labels stay on one axis whether or not a row is
     the selected one. */
  .intent-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    flex-shrink: 0;
    color: var(--color-primary);
  }

  .intent-option.selected .intent-label {
    font-weight: var(--weight-semibold);
  }

  .intent-hint {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  /* A sheet has room the popover doesn't, and a finger needs the target. */
  @media (max-width: 1000px) {
    .intent-option {
      min-height: 48px;
      padding-inline: 0.25rem;
    }
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
    color: var(--color-error, #f44336);
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
    /* Two rows down here, and they line up: the decisions take the full width,
       the tools sit under them on the same left and right edges. The icons are
       optically inset by their own padding, so the row is pulled back out by
       that much to make the columns read as columns. */
    .actions {
      row-gap: 1rem;
    }

    .lead {
      width: 100%;
    }

    /* The primary action takes what the state chip doesn't need. */
    .next {
      flex: 1;
      justify-content: center;
    }

    .intent {
      flex: 0 0 auto;
    }

    .secondary {
      width: 100%;
      margin-inline: -10px;
    }

    /* Removal is the one action here you can't undo by moving on, so it keeps
       its distance from the three that are just tools. */
    .secondary .action-btn.danger {
      margin-left: auto;
    }
  }

  /* The card's travel is driven from script (it follows a finger), so the
     reduced-motion path lives there too — commits jump rather than slide. This
     covers the declarative transitions around it. */
  @media (prefers-reduced-motion: reduce) {
    .step-back,
    .next,
    .intent,
    .intent-option,
    .action-btn,
    .gear,
    .more {
      transition: none;
    }
  }
</style>
