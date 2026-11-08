// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Startup reads the labels cache alone (loadCached); the backend half runs in
// the app refresh. A first login's full snapshot must not be fetched twice
// when a page's delta pull lands during it, and `isLoading` must not stay set
// when startup never reaches the backend.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn(async () => {});
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue, cancelPending: vi.fn() } }));

const api = {
  addLabel: vi.fn(async () => ({ success: true })),
  getAllLabels: vi.fn(),
  getReadPositions: vi.fn(async () => ({ positions: [], hasMore: false })),
};
vi.mock('$lib/services/api', () => ({ api }));

const table = () => ({
  get: async () => undefined,
  put: async () => {},
  toArray: async () => [],
  where: () => ({
    equals: () => ({
      delete: async () => {},
      first: async () => undefined,
      toArray: async () => [],
    }),
  }),
  bulkPut: async () => {},
  bulkDelete: async () => {},
  clear: async () => {},
});
vi.mock('$lib/services/db', () => ({
  db: { itemLabels: table(), articles: table(), saved: table() },
  getMetadata: async () => undefined,
  setMetadata: async () => {},
}));
vi.mock('$lib/services/safeDb.svelte', () => ({
  safePut: async () => {},
  safeBulkPut: async () => {},
}));
vi.mock('./auth.svelte', () => ({ auth: { isGuest: false } }));
const syncState = { isOnline: true };
vi.mock('./sync.svelte', () => ({
  syncStore: {
    get isOnline() {
      return syncState.isOnline;
    },
    markSynced: () => {},
  },
}));
vi.mock('./saves.svelte', () => ({ savesStore: { articles: [], loading: false } }));

const { itemLabelsStore } = await import('./itemLabels.svelte');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('labels startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncState.isOnline = true;
  });

  it('reads only the cache at startup, waiting for the refresh to answer', async () => {
    await itemLabelsStore.loadCached();

    expect(api.getAllLabels).not.toHaveBeenCalled();
    expect(itemLabelsStore.isLoading).toBe(true);
  });

  it('stops waiting when startup never reached the backend', async () => {
    await itemLabelsStore.loadCached();
    itemLabelsStore.settleStartup();

    expect(itemLabelsStore.isLoading).toBe(false);
  });

  it('shares one snapshot between the refresh and a delta pull fired meanwhile', async () => {
    const snapshot = deferred<{ labels: never[] }>();
    api.getAllLabels.mockReturnValueOnce(snapshot.promise);

    const loading = itemLabelsStore.load();
    await vi.waitFor(() => expect(api.getAllLabels).toHaveBeenCalledTimes(1));
    const pulling = itemLabelsStore.pullDelta();
    itemLabelsStore.settleStartup();
    expect(itemLabelsStore.isLoading).toBe(true);

    snapshot.resolve({ labels: [] });
    await Promise.all([loading, pulling]);
    expect(api.getAllLabels).toHaveBeenCalledTimes(1);
    expect(itemLabelsStore.isLoading).toBe(false);
  });
});
