import { browser } from '$app/environment';
import { itemLabelsStore } from './itemLabels.svelte';
import { preferences } from './preferences.svelte';
import {
  buildHighlightDeck,
  isReviewable,
  startOfLocalDay,
  summarizeHighlightDeck,
} from '$lib/utils/highlightReview';

/**
 * One shared read of "what does today's review deck hold?".
 *
 * The sidebar, the mobile switcher, the nav dropdown and the Home card all ask
 * the same question, and each would otherwise walk the whole highlight corpus on
 * its own. Deriving it once here keeps every entry point showing the same number
 * and pays for the scan once.
 */
function createHighlightReviewStore() {
  // The deck is scoped to the local calendar day, but a `$derived` recomputes
  // only when something it read changes, and the wall clock is not something it
  // read. Left as-is, an installed PWA open across midnight would keep showing
  // yesterday's count in the sidebar, the dropdown, the switcher and the Home
  // card until a highlight happened to change.
  //
  // So the day is state, and midnight is an invalidation like any other.
  let dayStart = $state(startOfLocalDay(new Date()));
  let rollover: ReturnType<typeof setTimeout> | undefined;

  /**
   * "Now" for every derivation below. The value is the real clock, which the
   * 24-hour freshness window needs; reading `dayStart` on the way is what
   * subscribes the derivation to the day rolling over.
   */
  function reviewNow(): Date {
    return new Date(Math.max(Date.now(), dayStart));
  }

  function syncDay() {
    const start = startOfLocalDay(new Date());
    if (start !== dayStart) dayStart = start;
    scheduleRollover();
  }

  function scheduleRollover() {
    if (!browser) return;
    clearTimeout(rollover);
    // setHours(24, …) lands on the next local midnight, which is what we want
    // across a DST boundary — that day is 23 or 25 hours long, not 24.
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    // A second past the boundary, so the timer can't fire a hair early and
    // re-arm itself for the same day.
    rollover = setTimeout(syncDay, Math.max(1000, next.getTime() - Date.now() + 1000));
  }

  if (browser) {
    scheduleRollover();
    // Background tabs get their timers throttled and a sleeping device stops
    // them outright, so coming back to the app re-checks rather than trusting
    // that the rollover fired.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncDay();
    });
    window.addEventListener('focus', syncDay);
  }

  let summary = $derived(
    summarizeHighlightDeck(
      itemLabelsStore.allHighlights,
      preferences.highlightReviewCount,
      reviewNow()
    )
  );

  // Kept separate from `summary` so the nav badge, which only needs a number,
  // never pays to rank the pool. `$derived` is lazy, so this costs nothing until
  // something actually asks which highlights are in today's deck.
  let cards = $derived(
    buildHighlightDeck(itemLabelsStore.allHighlights, preferences.highlightReviewCount, reviewNow())
      .cards
  );

  return {
    get status() {
      return summary.status;
    },
    /** Cards today's deck would deal — the quiet nav badge. 0 once it's done. */
    get dueCount() {
      return summary.dueCount;
    },
    /** Today's deck itself, ranked. For entry points that name what's in it. */
    get cards() {
      return cards;
    },
    /**
     * Does the reader have any highlight the deck could ever deal? False hides
     * the nav entry and the "Review more" offer. Retired highlights don't count:
     * a corpus that's entirely been told "don't show again" has nothing to
     * offer, however many highlights the list holds.
     */
    get hasHighlights() {
      return itemLabelsStore.allHighlights.some((entry) => isReviewable(entry.highlight));
    },
  };
}

export const highlightReviewStore = createHighlightReviewStore();
