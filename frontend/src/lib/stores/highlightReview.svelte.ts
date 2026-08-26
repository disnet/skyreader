import { itemLabelsStore } from './itemLabels.svelte';
import { preferences } from './preferences.svelte';
import {
  buildHighlightDeck,
  isReviewable,
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
  let summary = $derived(
    summarizeHighlightDeck(itemLabelsStore.allHighlights, preferences.highlightReviewCount)
  );

  // Kept separate from `summary` so the nav badge, which only needs a number,
  // never pays to rank the pool. `$derived` is lazy, so this costs nothing until
  // something actually asks which highlights are in today's deck.
  let cards = $derived(
    buildHighlightDeck(itemLabelsStore.allHighlights, preferences.highlightReviewCount).cards
  );

  // What a "Review more" would deal once today's portion is spent: the same pool
  // with the daily filter lifted, so it counts highlights already seen today.
  // Only the end-of-deck states read it.
  let encore = $derived(
    summarizeHighlightDeck(
      itemLabelsStore.allHighlights,
      preferences.highlightReviewCount,
      new Date(),
      { includeReviewedToday: true }
    )
  );

  return {
    get status() {
      return summary.status;
    },
    /** Cards today's deck would deal — the quiet nav badge. 0 once it's done. */
    get dueCount() {
      return summary.dueCount;
    },
    /** Cards an encore hand would deal after today's portion is spent. */
    get encoreCount() {
      return encore.dueCount;
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
