import { itemLabelsStore } from './itemLabels.svelte';
import { preferences } from './preferences.svelte';
import { summarizeHighlightDeck } from '$lib/utils/highlightReview';

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

  return {
    get status() {
      return summary.status;
    },
    /** Cards today's deck would deal — the quiet nav badge. 0 once it's done. */
    get dueCount() {
      return summary.dueCount;
    },
    /** Does the reader have any highlights at all? False hides the nav entry. */
    get hasHighlights() {
      return itemLabelsStore.allHighlights.length > 0;
    },
  };
}

export const highlightReviewStore = createHighlightReviewStore();
