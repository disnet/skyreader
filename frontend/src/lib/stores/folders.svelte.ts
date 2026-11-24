import { subscriptionsStore } from './subscriptions.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { renameFolderKey } from '$lib/utils/folders';

/**
 * Rename folder `from` to `to`, or merge it into `to` when that's a folder
 * already: its sources move, and a channel that took the old folder takes the
 * new one. If some sources couldn't move, the channel keeps both.
 */
export async function renameFolder(
  from: string,
  to: string
): Promise<{ moved: number; failed: number }> {
  const result = await subscriptionsStore.moveFolder(from, to);
  if (result.moved === 0) return result;
  const keepOld = result.failed > 0;
  for (const view of filteredViewsStore.views) {
    if (view.id == null) continue;
    const changes: { sourceKeys?: string[]; autoRule?: typeof view.autoRule } = {};
    const keys = view.sourceKeys ? renameFolderKey(view.sourceKeys, from, to, keepOld) : null;
    if (keys) changes.sourceKeys = keys;
    // A folder-rule channel from before folders were picked as sources.
    if (
      !keepOld &&
      view.autoRule?.type === 'category' &&
      view.autoRule.value.trim().toLowerCase() === from.toLowerCase()
    ) {
      changes.autoRule = { type: 'category', value: to };
    }
    if (Object.keys(changes).length > 0) await filteredViewsStore.update(view.id, changes);
  }
  return result;
}
