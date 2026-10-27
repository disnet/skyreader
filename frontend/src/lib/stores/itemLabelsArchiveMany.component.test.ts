// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// The Queue's bulk Archive: archiveMany writes every key at once, sends them in
// bulk requests of at most 500, and queues whatever didn't reach the server.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn(async () => {});
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue, cancelPending: vi.fn() } }));

const api = {
  addLabel: vi.fn(async () => ({ success: true })),
  bulkAddLabels: vi.fn(async () => ({ success: true, added: 0 })),
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

let n = 0;
function keys(count: number): string[] {
  return Array.from({ length: count }, () => `https://example.com/${n++}`);
}

describe('archiveMany', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncState.isOnline = true;
  });

  it('archives every key locally and sends them in chunks of 500, once each', async () => {
    const ks = keys(501);
    await itemLabelsStore.archiveMany([...ks, ks[0]], 'saved');
    expect(ks.every((k) => itemLabelsStore.isArchived(k))).toBe(true);
    expect(api.bulkAddLabels).toHaveBeenCalledTimes(2);
    const sent = (api.bulkAddLabels.mock.calls as unknown as [{ itemKey: string }[]][]).flatMap(
      (c) => c[0]
    );
    expect(sent.map((l) => l.itemKey)).toEqual(ks);
    expect(api.addLabel).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips keys already archived', async () => {
    const [a, b] = keys(2);
    await itemLabelsStore.archiveItem(a, 'saved');
    vi.clearAllMocks();
    await itemLabelsStore.archiveMany([a, b], 'saved');
    expect(api.bulkAddLabels).toHaveBeenCalledWith([
      expect.objectContaining({ itemKey: b, label: 'archived' }),
    ]);
  });

  it('queues only the chunks the server did not take', async () => {
    const ks = keys(600);
    api.bulkAddLabels
      .mockResolvedValueOnce({ success: true, added: 500 })
      .mockRejectedValueOnce(new Error('offline'));
    await itemLabelsStore.archiveMany(ks, 'saved');
    expect(enqueue).toHaveBeenCalledTimes(100);
    expect(enqueue).toHaveBeenCalledWith(
      'create',
      'label',
      `${ks[500]}\0archived`,
      expect.objectContaining({ itemKey: ks[500], label: 'archived' })
    );
    expect(ks.every((k) => itemLabelsStore.isArchived(k))).toBe(true);
  });

  it('does not queue back a key unarchived while the requests were out', async () => {
    const [a, b] = keys(2);
    api.bulkAddLabels.mockImplementationOnce(async () => {
      await itemLabelsStore.unarchiveItem(a, 'saved');
      throw new Error('offline');
    });
    await itemLabelsStore.archiveMany([a, b], 'saved');
    const creates = (enqueue.mock.calls as unknown as unknown[][]).filter((c) => c[0] === 'create');
    expect(creates.map((c) => c[2])).toEqual([`${b}\0archived`]);
  });

  it('queues everything when offline', async () => {
    syncState.isOnline = false;
    await itemLabelsStore.archiveMany(keys(3), 'saved');
    expect(api.bulkAddLabels).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
});
