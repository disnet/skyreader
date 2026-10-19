import { db, getMetadata, setMetadata } from '$lib/services/db';
import { safeAdd, safeUpdate } from '$lib/services/safeDb.svelte';
import { api } from '$lib/services/api';
import { auth } from './auth.svelte';
import type { FilteredView, Channel } from '$lib/types';
import {
  migrateLegacyView,
  isRssSource,
  isDocumentsSource,
  parseSourceKey,
  documentsSourceKey,
} from '$lib/utils/sourceKeys';
import {
  toConfig,
  fromRemote,
  computeSyncOperations,
  planReorder,
  sortByPosition,
} from '$lib/utils/channelSync';
import { CHANNEL_FILTER_VERSION, upgradeChannelFilter } from '$lib/utils/sourceFilter';
import { foldSavedChannel } from '$lib/utils/savesChannel';

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

    // The old Saved channel type is now a channel that takes in Your saves
    // (utils/savesChannel.ts). First, so the migrations below see a feed channel.
    // Kept here only; the next edit carries it to the server.
    for (const view of all) {
      const updates = foldSavedChannel(view);
      if (!updates) continue;
      Object.assign(view, updates);
      if (view.id != null) {
        await safeUpdate(db.filteredViews, view.id, updates);
      }
    }

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
    const hasNumericRssKeys = all.some((v) =>
      v.sourceKeys?.some((key) => isRssSource(key) && /^rss~\d+$/.test(key))
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
          const updates: Partial<FilteredView> = {
            sourceKeys: newKeys,
            updatedAt: Date.now(),
          };
          Object.assign(view, updates);
          if (view.id != null) {
            await safeUpdate(db.filteredViews, view.id, updates);
          }
        }
      }
    }

    // One-time migration: convert documents source keys from the legacy
    // {did}~documents form to {rkey}~documents, so two publications owned by one
    // author become distinct sources. Only DIDs with exactly one documents
    // subscription are migrated — an ambiguous DID (now multiple publications)
    // stays in legacy whole-author form, which resolveDocScopes still honors.
    const didToRkey = new Map<string, string>();
    const didDocSubCount = new Map<string, number>();
    for (const s of subscriptions) {
      if (s.sourceType === 'atproto.documents' && s.subjectDid && s.rkey) {
        didDocSubCount.set(s.subjectDid, (didDocSubCount.get(s.subjectDid) || 0) + 1);
        didToRkey.set(s.subjectDid, s.rkey);
      }
    }
    const hasLegacyDocKeys = all.some((v) =>
      v.sourceKeys?.some(
        (key) => isDocumentsSource(key) && parseSourceKey(key).id.startsWith('did:')
      )
    );
    if (hasLegacyDocKeys) {
      for (const view of all) {
        if (!view.sourceKeys?.length) continue;
        let changed = false;
        const newKeys = view.sourceKeys.map((key) => {
          if (!isDocumentsSource(key)) return key;
          const id = parseSourceKey(key).id;
          if (!id.startsWith('did:')) return key; // already rkey-based
          if ((didDocSubCount.get(id) || 0) !== 1) return key; // ambiguous — keep legacy
          const rkey = didToRkey.get(id);
          if (!rkey) return key; // unresolvable — keep legacy (back-compat resolves it)
          changed = true;
          return documentsSourceKey(rkey);
        });
        if (changed) {
          const updates: Partial<FilteredView> = {
            sourceKeys: newKeys,
            updatedAt: Date.now(),
          };
          Object.assign(view, updates);
          if (view.id != null) {
            await safeUpdate(db.filteredViews, view.id, updates);
          }
        }
      }
    }

    // Fold each channel's old type filter into its sources, and keep old exclude
    // channels free of follows links (utils/sourceFilter.ts). Also covers the
    // older fix for manual include channels that still carried a type filter.
    const upgradedViews: FilteredView[] = [];
    for (const view of all) {
      if (view.sourceMode == null) continue;
      if ((view.filterVersion ?? 0) >= CHANNEL_FILTER_VERSION) continue;
      const upgraded = upgradeChannelFilter(view);
      const updates: Partial<FilteredView> = {
        sourceMode: upgraded.sourceMode,
        sourceKeys: upgraded.sourceKeys,
        typeFilter: upgraded.typeFilter,
        filterVersion: upgraded.filterVersion,
        updatedAt: Date.now(),
      };
      Object.assign(view, updates);
      if (view.id != null) {
        await safeUpdate(db.filteredViews, view.id, updates);
      }
      upgradedViews.push(view);
    }

    views = sortByPosition(all);

    // Propagate the upgrade to the backend so other devices pick it up.
    // syncWithBackend doesn't push updates to channels that already exist on
    // the remote, so we have to do it explicitly here.
    for (const view of upgradedViews) {
      pushToBackend(view);
    }
  }

  /** Sync with backend: merge remote channels with local, bidirectionally. */
  async function syncWithBackend() {
    // A guest's channels live only in this browser. There is no remote to merge
    // with — and the first authed sync after sign-in pushes them to the new
    // account via ops.pushToRemote, which is the whole migration.
    if (auth.isGuest) return;
    try {
      const { channels: remoteChannels, deletedUuids } = await api.getChannels();
      const pendingDeletes = await loadPendingDeletes();

      const ops = computeSyncOperations(views, remoteChannels, deletedUuids ?? [], pendingDeletes);

      // Build the new views state without mutating `views` until all DB ops succeed.
      let updatedViews = [...views];

      // Apply local deletions to DB
      for (const uuid of ops.deleteLocally) {
        const local = updatedViews.find((v) => v.uuid === uuid);
        if (local?.id != null) {
          await db.filteredViews.delete(local.id);
        }
        updatedViews = updatedViews.filter((v) => v.uuid !== uuid);
      }

      // A Saved channel's config arrives as the channel it now is.
      // Add new channels from remote to DB
      for (const remote of ops.addLocally) {
        const parsed = { ...remote, ...foldSavedChannel(remote as FilteredView) };
        const id = await safeAdd(db.filteredViews, parsed);
        updatedViews = [...updatedViews, { ...parsed, id: id as number }];
      }

      // Update local channels from remote in DB
      for (const { uuid, data: remote } of ops.updateLocally) {
        // A query (or Library sources) taken out on another device is absent from
        // its config, and a merge would keep this device's: name it, so the merge clears it.
        const data = {
          query: undefined,
          librarySources: undefined,
          ...remote,
          ...foldSavedChannel(remote as FilteredView),
        };
        const local = updatedViews.find((v) => v.uuid === uuid);
        if (local?.id != null) {
          await safeUpdate(db.filteredViews, local.id, data);
        }
        updatedViews = updatedViews.map((v) => (v.uuid === uuid ? { ...v, ...data } : v));
      }

      // All DB ops succeeded — commit the in-memory state atomically. A reorder
      // made on another device arrives as new positions, so re-sort.
      views = sortByPosition(updatedViews);

      // Retry pending deletes (network-only, doesn't affect local state)
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
    // Guest channels stay local; syncWithBackend pushes them after sign-in.
    if (auth.isGuest) return;
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
      filterVersion: CHANNEL_FILTER_VERSION,
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

  /**
   * Put the channels in a new order (`order` is their uuids, top first). Only
   * the channels that change place are written, stamped newer so the order
   * wins on other devices, and pushed together in one request.
   */
  async function reorder(order: string[]) {
    const changes = planReorder(views, order);
    if (changes.length === 0) return;
    const now = Date.now();
    const byUuid = new Map(changes.map((c) => [c.uuid, c.position]));
    views = sortByPosition(
      views.map((v) =>
        byUuid.has(v.uuid) ? { ...v, position: byUuid.get(v.uuid)!, updatedAt: now } : v
      )
    );
    const moved = views.filter((v) => byUuid.has(v.uuid));
    for (const view of moved) {
      if (view.id != null) {
        await safeUpdate(db.filteredViews, view.id, {
          position: view.position,
          updatedAt: view.updatedAt,
        });
      }
    }
    // Guest channels stay local; syncWithBackend pushes them after sign-in.
    if (auth.isGuest) return;
    api
      .syncChannels(
        moved.map((v) => ({
          uuid: v.uuid,
          name: v.name,
          config: JSON.stringify(toConfig(v)),
          position: v.position,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        }))
      )
      .catch((e) => {
        console.warn('Failed to push channel order to backend:', e);
      });
  }

  async function remove(id: number) {
    const view = views.find((v) => v.id === id);
    await db.filteredViews.delete(id);
    views = views.filter((v) => v.id !== id);
    // A guest channel never reached the backend, so there is nothing to delete
    // remotely — and recording a pending delete would fire a stray DELETE at
    // whatever account signs in later.
    if (view?.uuid && !auth.isGuest) {
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
    reorder,
    remove,
    getById,
    getByUuid,
  };
}

export const filteredViewsStore = createFilteredViewsStore();
