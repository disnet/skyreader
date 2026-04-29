import { browser } from '$app/environment';
import { savesStore } from './saves.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { generateAllSavedSuggestions } from '$lib/utils/channelLogic';
import type { SavedChannelSuggestion } from '$lib/utils/channelLogic';

export type { SavedChannelSuggestion };

const STORAGE_KEY = 'skyreader-dismissed-saved-suggestions';
const MAX_INLINE_SUGGESTIONS = 3;

function createSavedChannelSuggestionsStore() {
  let dismissedIds = $state<Set<string>>(new Set());

  // Restore dismissed suggestions from localStorage
  if (browser) {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        dismissedIds = new Set(JSON.parse(stored));
      }
    } catch {
      // Ignore parse errors
    }
  }

  function persistDismissals() {
    if (browser) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissedIds]));
    }
  }

  function dismiss(id: string) {
    dismissedIds = new Set([...dismissedIds, id]);
    persistDismissals();
  }

  let allSuggestions = $derived.by((): SavedChannelSuggestion[] => {
    // Access reactive dependencies
    savesStore.articles;
    filteredViewsStore.views;
    itemLabelsStore.archivedCount;

    // Suggestions should reflect the inbox (non-archived) view, since that's
    // what newly-created saved channels default to showing.
    const inboxItems = savesStore.articles.filter((bm) => {
      const archiveKey = bm.itemGuid || bm.uri || '';
      return !itemLabelsStore.isArchived(archiveKey);
    });

    return generateAllSavedSuggestions(
      {
        savedItems: inboxItems,
        views: filteredViewsStore.views,
      },
      dismissedIds
    );
  });

  let topSuggestions = $derived(allSuggestions.slice(0, MAX_INLINE_SUGGESTIONS));
  let hasMoreSuggestions = $derived(allSuggestions.length > MAX_INLINE_SUGGESTIONS);

  return {
    /** Top 3 suggestions for inline display in sidebar/mobile switcher */
    get suggestions() {
      return topSuggestions;
    },
    /** All active suggestions for the discovery page */
    get allSuggestions() {
      return allSuggestions;
    },
    get hasMore() {
      return hasMoreSuggestions;
    },
    dismiss,
  };
}

export const savedChannelSuggestions = createSavedChannelSuggestionsStore();
