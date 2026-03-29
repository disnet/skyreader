import { db } from '$lib/services/db';
import { safeAdd, safeUpdate } from '$lib/services/safeDb.svelte';
import type { FilteredView } from '$lib/types';
import { migrateLegacyView } from '$lib/utils/sourceKeys';

function createFilteredViewsStore() {
  let views = $state<FilteredView[]>([]);

  async function load() {
    const all = await db.filteredViews.orderBy('position').toArray();

    // One-time migration: convert legacy views (sourceMode undefined) to new format
    const needsMigration = all.some((v) => v.sourceMode == null);
    if (needsMigration) {
      const subscriptions = await db.subscriptions.toArray();
      const allSubIds = subscriptions.map((s) => s.id).filter((id): id is number => id != null);
      const allDids = [
        ...new Set(
          subscriptions
            .filter((s) => s.sourceType?.startsWith('atproto.') && s.subjectDid)
            .map((s) => s.subjectDid!)
        ),
      ];

      for (const view of all) {
        if (view.sourceMode != null) continue;
        const migrated = migrateLegacyView(
          {
            showArticles: view.showArticles,
            showShares: view.showShares,
            showDocuments: view.showDocuments,
            feedMode: view.feedMode,
            feedIds: view.feedIds,
            accountMode: view.accountMode,
            accountDids: view.accountDids,
          },
          allSubIds,
          allDids
        );
        const updates: Partial<FilteredView> = {
          sourceMode: migrated.sourceMode,
          sourceKeys: migrated.sourceKeys,
          updatedAt: Date.now(),
        };
        Object.assign(view, updates);
        if (view.id != null) {
          await safeUpdate(db.filteredViews, view.id, updates);
        }
      }
    }

    views = all;
  }

  async function create(
    view: Omit<FilteredView, 'id' | 'createdAt' | 'updatedAt' | 'position'>
  ): Promise<number> {
    const now = Date.now();
    const maxPosition = views.length > 0 ? Math.max(...views.map((v) => v.position)) : -1;
    const newView: FilteredView = {
      ...view,
      createdAt: now,
      updatedAt: now,
      position: maxPosition + 1,
    };
    const id = await safeAdd(db.filteredViews, newView);
    newView.id = id as number;
    views = [...views, newView];
    return id as number;
  }

  async function update(id: number, changes: Partial<FilteredView>) {
    const updated = { ...changes, updatedAt: Date.now() };
    // Update in-memory first for immediate reactivity, then persist
    views = views.map((v) => (v.id === id ? { ...v, ...updated } : v));
    await safeUpdate(db.filteredViews, id, updated);
  }

  async function remove(id: number) {
    await db.filteredViews.delete(id);
    views = views.filter((v) => v.id !== id);
  }

  function getById(id: number): FilteredView | undefined {
    return views.find((v) => v.id === id);
  }

  return {
    get views() {
      return views;
    },
    load,
    create,
    update,
    remove,
    getById,
  };
}

export const filteredViewsStore = createFilteredViewsStore();
