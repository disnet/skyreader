import type { FilteredView } from '$lib/types';

export interface RemoteChannel {
  uuid: string;
  name: string;
  config: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface SyncOperations {
  /** Remote channels to add locally (not present locally, not deleted). */
  addLocally: Array<Omit<FilteredView, 'id'>>;
  /** Local channels to update from remote (remote is newer). */
  updateLocally: Array<{ uuid: string; data: Omit<FilteredView, 'id'> }>;
  /** Local channel UUIDs to delete (deleted on remote). */
  deleteLocally: string[];
  /** Local channels to push to remote (not present on remote). */
  pushToRemote: FilteredView[];
  /** UUIDs to send DELETE to backend (locally-pending deletes that need retrying). */
  retryDeletes: string[];
  /** Updated pending-delete set after reconciliation. */
  pendingDeletesAfter: Set<string>;
}

/** Extract the JSON config blob from a FilteredView (everything except id, uuid, name, position, timestamps). */
export function toConfig(view: FilteredView): Record<string, unknown> {
  const {
    id: _id,
    uuid: _uuid,
    name: _name,
    position: _pos,
    createdAt: _ca,
    updatedAt: _ua,
    ...config
  } = view;
  return config;
}

/** Reconstruct a partial FilteredView from a remote channel row. */
export function fromRemote(remote: RemoteChannel): Omit<FilteredView, 'id'> {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(remote.config);
  } catch {
    // invalid config, use defaults
  }
  return {
    uuid: remote.uuid,
    name: remote.name,
    position: remote.position,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    readFilter: (config.readFilter as FilteredView['readFilter']) ?? 'all',
    sortOrder: (config.sortOrder as FilteredView['sortOrder']) ?? 'newest',
    ...config,
  } as Omit<FilteredView, 'id'>;
}

/**
 * Compute the set of sync operations needed to reconcile local and remote state.
 * Pure function — no side effects, no I/O.
 */
export function computeSyncOperations(
  localViews: FilteredView[],
  remoteChannels: RemoteChannel[],
  deletedUuids: string[],
  pendingDeletes: Set<string>
): SyncOperations {
  const localByUuid = new Map(localViews.filter((v) => v.uuid).map((v) => [v.uuid, v]));
  const remoteByUuid = new Map(remoteChannels.map((r) => [r.uuid, r]));
  const remoteDeletedSet = new Set(deletedUuids);

  const pendingDeletesAfter = new Set(pendingDeletes);

  const deleteLocally: string[] = [];
  const addLocally: Array<Omit<FilteredView, 'id'>> = [];
  const updateLocally: Array<{ uuid: string; data: Omit<FilteredView, 'id'> }> = [];
  const retryDeletes: string[] = [];

  // Remove locally any channels that were deleted on another device
  for (const uuid of remoteDeletedSet) {
    if (localByUuid.has(uuid)) {
      deleteLocally.push(uuid);
    }
    // If we also had a pending delete for this, the backend already knows — clear it
    pendingDeletesAfter.delete(uuid);
  }

  // Retry sending any pending deletes to the backend
  for (const uuid of pendingDeletes) {
    if (!remoteDeletedSet.has(uuid)) {
      retryDeletes.push(uuid);
    }
  }

  // All UUIDs we consider "deleted" — both remote and locally-pending
  const allDeletedUuids = new Set([...remoteDeletedSet, ...pendingDeletesAfter]);

  // Merge remote → local
  for (const [uuid, remote] of remoteByUuid) {
    if (allDeletedUuids.has(uuid)) continue;
    const local = localByUuid.get(uuid);
    if (!local) {
      addLocally.push(fromRemote(remote));
    } else if (remote.updatedAt > local.updatedAt) {
      updateLocally.push({ uuid, data: fromRemote(remote) });
    }
  }

  // Local channels not in remote (and not deleted) → push to backend
  const pushToRemote = localViews.filter(
    (v) => v.uuid && !remoteByUuid.has(v.uuid) && !allDeletedUuids.has(v.uuid)
  );

  return {
    addLocally,
    updateLocally,
    deleteLocally,
    pushToRemote,
    retryDeletes,
    pendingDeletesAfter,
  };
}
