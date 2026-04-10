import { db, type IntegrationCollectionCacheEntry } from '$lib/services/db';
import { api } from '$lib/services/api';
import type { SembleCollection, MarginCollection } from '$lib/types';

export type IntegrationKind = 'semble' | 'margin';
export type CollectionEntry = SembleCollection | MarginCollection;

function createCollectionsStore() {
  const collections = $state<Record<IntegrationKind, CollectionEntry[]>>({
    semble: [],
    margin: [],
  });
  const loading = $state<Record<IntegrationKind, boolean>>({
    semble: false,
    margin: false,
  });
  const refreshing = $state<Record<IntegrationKind, boolean>>({
    semble: false,
    margin: false,
  });
  const error = $state<Record<IntegrationKind, string | null>>({
    semble: null,
    margin: null,
  });

  async function readCache(integration: IntegrationKind): Promise<CollectionEntry[]> {
    const rows = await db.integrationCollections.where('integration').equals(integration).toArray();
    return rows.map((r) => ({
      uri: r.uri,
      cid: r.cid,
      name: r.name,
      description: r.description,
      createdAt: r.createdAt,
    }));
  }

  async function writeCache(integration: IntegrationKind, list: CollectionEntry[]) {
    const now = Date.now();
    const rows: IntegrationCollectionCacheEntry[] = list.map((c) => ({
      integration,
      uri: c.uri,
      cid: c.cid,
      name: c.name,
      description: c.description,
      createdAt: c.createdAt,
      cachedAt: now,
    }));
    // Replace the whole cache for this integration so deleted collections disappear.
    await db.transaction('rw', db.integrationCollections, async () => {
      await db.integrationCollections.where('integration').equals(integration).delete();
      if (rows.length > 0) await db.integrationCollections.bulkPut(rows);
    });
  }

  async function fetchFromApi(integration: IntegrationKind): Promise<CollectionEntry[]> {
    if (integration === 'semble') {
      const res = await api.listSembleCollections();
      return res.collections;
    } else {
      const res = await api.listMarginCollections();
      return res.collections;
    }
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
      collections[integration] = fresh;
      await writeCache(integration, fresh);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load collections';
      if (!hasCache) {
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
    const kinds: IntegrationKind[] = integration ? [integration] : ['semble', 'margin'];
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
    invalidate,
  };
}

export const collectionsStore = createCollectionsStore();
