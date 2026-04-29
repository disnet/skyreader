import { browser } from '$app/environment';
import { subscriptionsStore } from './subscriptions.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { articlesStore } from './articles.svelte';
import { generateAllSuggestions } from '$lib/utils/channelLogic';
import type { ChannelSuggestion } from '$lib/utils/channelLogic';

export type { ChannelSuggestion };

const STORAGE_KEY = 'skyreader-dismissed-suggestions';
const MAX_INLINE_SUGGESTIONS = 3;

function createChannelSuggestionsStore() {
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

  let allSuggestions = $derived.by((): ChannelSuggestion[] => {
    // Access reactive dependencies
    subscriptionsStore.subscriptions;
    filteredViewsStore.views;
    articlesStore.allArticles;

    return generateAllSuggestions(
      {
        subscriptions: subscriptionsStore.subscriptions,
        articles: articlesStore.allArticles,
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

export const channelSuggestions = createChannelSuggestionsStore();
