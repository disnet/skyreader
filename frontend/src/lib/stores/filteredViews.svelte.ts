import { db, getMetadata, setMetadata } from '$lib/services/db';
import { safeAdd, safeUpdate } from '$lib/services/safeDb.svelte';
import { api } from '$lib/services/api';
import type { FilteredView, Channel } from '$lib/types';
import { migrateLegacyView, isRssSource } from '$lib/utils/sourceKeys';
import { toConfig, fromRemote, computeSyncOperations } from '$lib/utils/channelSync';

const PENDING_DELETES_KEY = 'channelsPendingDelete';

/** Load the set of UUIDs we've deleted locally but may not have confirmed with the backend. */
async function loadPendingDeletes(): Promise<Set<string>> {
  const arr = await getMetadata<string[]>(PENDING_DELETES_KEY);
  return new Set(arr ?? []);
}

/** Persist the pending-delete set. */
async function savePendingDeletes(uuids: Set<string>): Promise<void> {
  if (uuids.size === 0) {
    await setMetadata(PENDING_DELETES_KEY, []);
  } else {
    await setMetadata(PENDING_DELETES_KEY, [...uuids]);
  }
}

function createFilteredViewsStore() {
  let views = $state<FilteredView[]>([]);

  async function load() {
    const all = await db.filteredViews.orderBy('position').toArray();

    const subscriptions = await db.subscriptions.toArray();

    // One-time migration: convert legacy views (sourceMode undefined) to new format
    const needsLegacyMigration = all.some((v) => v.sourceMode == null);
    if (needsLegacyMigration) {
      const allSubRkeys = subscriptions.map((s) => s.rkey).filter(Boolean);
      const idToRkey = new Map<number, string>();
      for (const s of subscriptions) {
        if (s.id != null && s.rkey) idToRkey.set(s.id, s.rkey);
      }
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
          allSubRkeys,
          allDids,
          idToRkey
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

    // One-time migration: convert sourceKeys from rss~{dexieId} to rss~{rkey}
    const idToRkeyMap = new Map<string, string>();
    for (const s of subscriptions) {
      if (s.id != null && s.rkey) idToRkeyMap.set(String(s.id), s.rkey);
    }
    const hasNumericRssKeys = all.some(
      (v) => v.sourceKeys?.some((key) => isRssSource(key) && /^rss~\d+$/.test(key))
    );
    if (hasNumericRssKeys) {
      for (const view of all) {
        if (!view.sourceKeys?.length) continue;
        let changed = false;
        const newKeys = view.sourceKeys.map((key) => {
          if (!isRssSource(key)) return key;
          const match = key.match(/^rss~(\d+)$/);
          if (!match) return key;
          const rkey = idToRkeyMap.get(match[1]);
          if (!rkey) return key; // can't resolve, keep as-is
          changed = true;
          return `rss~${rkey}`;
        });
        if (changed) {
          const updates: Partial<FilteredView> = { sourceKeys: newKeys, updatedAt: Date.now() };
          Object.assign(view, updates);
          if (view.id != null) {
            await safeUpdate(db.filteredViews, view.id, updates);
          }
        }
      }
    }

    views = all;
  }

  /** Sync with backend: merge remote channels with local, bidirectionally. */
  async function syncWithBackend() {
    try {
      const { channels: remoteChannels, deletedUuids } = await api.getChannels();
      const pendingDeletes = await loadPendingDeletes();

      const ops = computeSyncOperations(
        views,
        remoteChannels,
        deletedUuids ?? [],
        pendingDeletes
      );

      // Apply local deletions
      for (const uuid of ops.deleteLocally) {
        const local = views.find((v) => v.uuid === uuid);
        if (local?.id != null) {
          await db.filteredViews.delete(local.id);
        }
        views = views.filter((v) => v.uuid !== uuid);
      }

      // Retry pending deletes
      const retriedOk = new Set<string>();
      for (const uuid of ops.retryDeletes) {
        try {
          await api.deleteChannel(uuid);
          retriedOk.add(uuid);
        } catch {
          // Still can't reach backend — keep in pending set for next sync
        }
      }
      for (const uuid of retriedOk) ops.pendingDeletesAfter.delete(uuid);
      await savePendingDeletes(ops.pendingDeletesAfter);

      // Add new channels from remote
      for (const parsed of ops.addLocally) {
        const id = await safeAdd(db.filteredViews, parsed);
        views = [...views, { ...parsed, id: id as number }];
      }

      // Update local channels from remote
      for (const { uuid, data } of ops.updateLocally) {
        const local = views.find((v) => v.uuid === uuid);
        if (local?.id != null) {
          await safeUpdate(db.filteredViews, local.id, data);
        }
        views = views.map((v) => (v.uuid === uuid ? { ...v, ...data } : v));
      }

      // Push local-only channels to remote
      if (ops.pushToRemote.length > 0) {
        await api.syncChannels(
          ops.pushToRemote.map((v) => ({
            uuid: v.uuid,
            name: v.name,
            config: JSON.stringify(toConfig(v)),
            position: v.position,
            createdAt: v.createdAt,
            updatedAt: v.updatedAt,
          }))
        );
      }
    } catch (e) {
      // Sync failed (offline, auth expired, etc.) — continue with local data
      console.warn('Channel sync failed:', e);
    }
  }

  /** Push a single channel to the backend (fire-and-forget). */
  function pushToBackend(view: FilteredView) {
    api
      .upsertChannel(view.uuid, {
        name: view.name,
        config: JSON.stringify(toConfig(view)),
        position: view.position,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
      })
      .catch((e) => {
        console.warn('Failed to push channel to backend:', e);
      });
  }

  async function create(
    view: Omit<FilteredView, 'id' | 'uuid' | 'createdAt' | 'updatedAt' | 'position'>
  ): Promise<string> {
    const now = Date.now();
    const maxPosition = views.length > 0 ? Math.max(...views.map((v) => v.position)) : -1;
    const uuid = crypto.randomUUID();
    const newView: FilteredView = {
      ...view,
      uuid,
      createdAt: now,
      updatedAt: now,
      position: maxPosition + 1,
    };
    const id = await safeAdd(db.filteredViews, newView);
    newView.id = id as number;
    views = [...views, newView];
    pushToBackend(newView);
    return uuid;
  }

  async function update(id: number, changes: Partial<FilteredView>) {
    const updated = { ...changes, updatedAt: Date.now() };
    // Update in-memory first for immediate reactivity, then persist
    views = views.map((v) => (v.id === id ? { ...v, ...updated } : v));
    await safeUpdate(db.filteredViews, id, updated);
    const view = views.find((v) => v.id === id);
    if (view) pushToBackend(view);
  }

  async function remove(id: number) {
    const view = views.find((v) => v.id === id);
    await db.filteredViews.delete(id);
    views = views.filter((v) => v.id !== id);
    if (view?.uuid) {
      // Persist the delete intent BEFORE the fire-and-forget API call.
      // This prevents syncWithBackend from re-adding the channel if the DELETE fails.
      const pendingDeletes = await loadPendingDeletes();
      pendingDeletes.add(view.uuid);
      await savePendingDeletes(pendingDeletes);

      // Fire-and-forget DELETE to backend; if it fails, sync will retry
      api
        .deleteChannel(view.uuid)
        .then(async () => {
          // Success — remove from pending deletes
          const current = await loadPendingDeletes();
          current.delete(view.uuid);
          await savePendingDeletes(current);
        })
        .catch((e) => {
          console.warn('Failed to delete channel remotely, will retry on next sync:', e);
        });
    }
  }

  function getById(id: number): FilteredView | undefined {
    return views.find((v) => v.id === id);
  }

  function getByUuid(uuid: string): FilteredView | undefined {
    return views.find((v) => v.uuid === uuid);
  }

  return {
    get views() {
      return views;
    },
    /** Alias for views — prefer this in new code. */
    get channels(): Channel[] {
      return views;
    },
    load,
    syncWithBackend,
    create,
    update,
    remove,
    getById,
    getByUuid,
  };
}

export const filteredViewsStore = createFilteredViewsStore();
