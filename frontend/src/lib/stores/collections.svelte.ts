import { db, type IntegrationCollectionCacheEntry } from '$lib/services/db';
import { api, ScopeUpgradeError } from '$lib/services/api';
import type { SembleCollection, MarginCollection, CurrentsCollection } from '$lib/types';

export type IntegrationKind = 'semble' | 'margin' | 'currents';

/**
 * A collection as the picker needs it. `lastUsedAt` is local-only: neither
 * Semble nor Margin reports when a collection was last filed into, so the
 * picker's "recently used" band is built from what this device remembers
 * (stamped by markUsed, merged forward across every cache refresh).
 */
export type CollectionEntry = (SembleCollection | MarginCollection | CurrentsCollection) & {
  lastUsedAt?: number;
};

/**
 * Keep the later of two recency stamps. Every merge point below is racing a
 * possible markUsed, so "the one we happen to be holding" is never the right
 * answer — the newer one is.
 */
function newerStamp(a: number | undefined, b: number | undefined): number | undefined {
  if (typeof a !== 'number') return b;
  if (typeof b !== 'number') return a;
  return Math.max(a, b);
}

function createCollectionsStore() {
  const collections = $state<Record<IntegrationKind, CollectionEntry[]>>({
    semble: [],
    margin: [],
    currents: [],
  });
  const loading = $state<Record<IntegrationKind, boolean>>({
    semble: false,
    margin: false,
    currents: false,
  });
  const refreshing = $state<Record<IntegrationKind, boolean>>({
    semble: false,
    margin: false,
    currents: false,
  });
  const error = $state<Record<IntegrationKind, string | null>>({
    semble: null,
    margin: null,
    currents: null,
  });

  async function readCache(integration: IntegrationKind): Promise<CollectionEntry[]> {
    const rows = await db.integrationCollections.where('integration').equals(integration).toArray();
    return rows.map((r) => ({
      uri: r.uri,
      cid: r.cid,
      name: r.name,
      description: r.description,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
  }

  async function writeCache(integration: IntegrationKind, list: CollectionEntry[]) {
    const now = Date.now();
    // Replace the whole cache for this integration so deleted collections disappear.
    await db.transaction('rw', db.integrationCollections, async () => {
      const existing = await db.integrationCollections
        .where('integration')
        .equals(integration)
        .toArray();
      // Recency is ours, not the server's, so it has to survive the wholesale
      // replace below — otherwise every background refresh would erase the
      // "recently used" band the picker leads with.
      const usedAt = new Map(existing.map((r) => [r.uri, r.lastUsedAt]));
      const rows: IntegrationCollectionCacheEntry[] = list.map((c) => ({
        integration,
        uri: c.uri,
        cid: c.cid,
        name: c.name,
        description: c.description,
        createdAt: c.createdAt,
        cachedAt: now,
        // Not `??`: the caller's stamp can be the stale one (it was read before
        // its network round-trip), so a markUsed that landed in the meantime
        // has to win rather than be overwritten by the older defined value.
        lastUsedAt: newerStamp(c.lastUsedAt, usedAt.get(c.uri)),
      }));
      await db.integrationCollections.where('integration').equals(integration).delete();
      if (rows.length > 0) await db.integrationCollections.bulkPut(rows);
    });
  }

  async function fetchFromApi(integration: IntegrationKind): Promise<CollectionEntry[]> {
    if (integration === 'semble') {
      const res = await api.listSembleCollections();
      return res.collections;
    } else if (integration === 'margin') {
      const res = await api.listMarginCollections();
      return res.collections;
    }
    const res = await api.listCurrentsCollections();
    return res.collections;
  }

  /**
   * Stale-while-revalidate loader. Populates state from Dexie immediately (if any),
   * then kicks off a network refresh. Network failures are silent when cache exists.
   */
  async function loadAndRefresh(integration: IntegrationKind): Promise<void> {
    error[integration] = null;

    let cached: CollectionEntry[] = [];
    try {
      cached = await readCache(integration);
    } catch (err) {
      console.error(`Failed to read ${integration} collections cache:`, err);
    }

    const hasCache = cached.length > 0;
    if (hasCache) {
      collections[integration] = cached;
      loading[integration] = false;
      refreshing[integration] = true;
    } else {
      collections[integration] = [];
      loading[integration] = true;
      refreshing[integration] = false;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      // Offline: keep whatever cache we have, stop loading spinners.
      loading[integration] = false;
      refreshing[integration] = false;
      if (!hasCache) {
        error[integration] = 'offline';
      }
      return;
    }

    try {
      const fresh = await fetchFromApi(integration);
      // The API answer carries no lastUsedAt; carry it over from what we cached
      // so the list doesn't lose its recency ordering mid-refresh. `cached` is a
      // pre-fetch snapshot, so fold live state over it too: the user can confirm
      // a save (markUsed) while a slow listing is still in flight, and that stamp
      // must not be rolled back by this assignment.
      const usedAt = new Map(cached.map((c) => [c.uri, c.lastUsedAt]));
      for (const c of collections[integration]) {
        usedAt.set(c.uri, newerStamp(c.lastUsedAt, usedAt.get(c.uri)));
      }
      const merged: CollectionEntry[] = fresh.map((c) => ({ ...c, lastUsedAt: usedAt.get(c.uri) }));
      collections[integration] = merged;
      await writeCache(integration, merged);
    } catch (err) {
      const msg =
        err instanceof ScopeUpgradeError
          ? 'scope_upgrade_required'
          : err instanceof Error
            ? err.message
            : 'Failed to load collections';
      // Cached collection names remain useful for transient failures, but they
      // cannot prove that the current session is authorized. A scope failure is
      // authoritative (including after an account/session change), so surface it
      // even when IndexedDB still holds rows from an earlier session.
      if (!hasCache || err instanceof ScopeUpgradeError) {
        error[integration] = msg;
      } else {
        console.error(`Background refresh of ${integration} collections failed:`, err);
      }
    } finally {
      loading[integration] = false;
      refreshing[integration] = false;
    }
  }

  async function invalidate(integration?: IntegrationKind): Promise<void> {
    const kinds: IntegrationKind[] = integration ? [integration] : ['semble', 'margin', 'currents'];
    for (const k of kinds) {
      collections[k] = [];
      loading[k] = false;
      refreshing[k] = false;
      error[k] = null;
    }
    if (integration) {
      await db.integrationCollections.where('integration').equals(integration).delete();
    } else {
      await db.integrationCollections.clear();
    }
  }

  /**
   * Stamp collections as just-used so the picker can lead with them next time.
   * Called when a save is confirmed, not when it lands: an offline save that
   * sits in the queue still reflects a choice the reader just made.
   */
  async function markUsed(integration: IntegrationKind, uris: string[]): Promise<void> {
    if (uris.length === 0) return;
    const now = Date.now();
    const touched = new Set(uris);
    collections[integration] = collections[integration].map((c) =>
      touched.has(c.uri) ? { ...c, lastUsedAt: now } : c
    );
    try {
      await db.transaction('rw', db.integrationCollections, async () => {
        for (const uri of touched) {
          await db.integrationCollections.update([integration, uri], { lastUsedAt: now });
        }
      });
    } catch (err) {
      // Recency is a convenience, never a correctness concern — a failed write
      // costs one well-ordered list, not a save.
      console.error(`Failed to record ${integration} collection use:`, err);
    }
  }

  return {
    get collections() {
      return collections;
    },
    get loading() {
      return loading;
    },
    get refreshing() {
      return refreshing;
    },
    get error() {
      return error;
    },
    loadAndRefresh,
    markUsed,
    invalidate,
  };
}

export const collectionsStore = createCollectionsStore();
