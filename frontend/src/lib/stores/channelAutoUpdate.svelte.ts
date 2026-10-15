import { subscriptionsStore } from './subscriptions.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { articlesStore } from './articles.svelte';
import {
  isValidAutoRule,
  computeSourceKeys as computeSourceKeysPure,
} from '$lib/utils/channelLogic';
import { keysOfTypes } from '$lib/utils/sourceFilter';

/**
 * Check all channels with autoRules and update their sourceKeys if needed.
 */
export async function syncAutoRuleChannels() {
  for (const view of filteredViewsStore.views) {
    if (!view.autoRule || view.id == null) continue;

    if (!isValidAutoRule(view.autoRule)) {
      console.warn(
        `Channel "${view.name}" (id=${view.id}) has invalid autoRule, skipping:`,
        view.autoRule
      );
      continue;
    }

    // A smart channel from before source groups may still narrow its rule by type.
    const newKeys = keysOfTypes(
      computeSourceKeysPure(
        view.autoRule,
        subscriptionsStore.subscriptions,
        articlesStore.allArticles
      ),
      view.typeFilter,
      subscriptionsStore.subscriptions
    );
    const currentKeys = view.sourceKeys ?? [];

    // Compare: only update if different
    const currentSet = new Set(currentKeys);
    const newSet = new Set(newKeys);
    if (currentSet.size === newSet.size && [...currentSet].every((k) => newSet.has(k))) {
      continue;
    }

    await filteredViewsStore.update(view.id, { sourceKeys: newKeys });
  }
}
