import { db } from '$lib/services/db';
import { safeAdd, safeUpdate } from '$lib/services/safeDb.svelte';
import type { FilteredView } from '$lib/types';

function createFilteredViewsStore() {
  let views = $state<FilteredView[]>([]);

  async function load() {
    const all = await db.filteredViews.orderBy('position').toArray();
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
