// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// A saved PDF's place in its Original view syncs as the `pdfPlace` label, so
// another device opens it where it was left. Merged by `lastReadAt`, like read
// progress: the newer place wins, wherever it is in the document.
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

const PDF = 'at://did:plc:me/app.skyreader.feed.saved/3kpdf';

function remote(page: number, at: number, lastReadAt: number) {
  return {
    itemKey: PDF,
    itemType: 'saved',
    label: 'pdfPlace',
    props: { page, at, lastReadAt },
    createdAt: 1,
    updatedAt: Math.floor(lastReadAt / 1000),
    deletedAt: null,
  };
}

describe('pdfPlace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncState.isOnline = true;
  });

  it('remembers a place and sends it to the server', async () => {
    await itemLabelsStore.setPdfPlace(PDF, 'saved', { page: 4, at: 0.25 });

    expect(itemLabelsStore.getPdfPlace(PDF)).toEqual({ page: 4, at: 0.25 });
    expect(api.addLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: PDF,
        label: 'pdfPlace',
        props: expect.objectContaining({ page: 4, at: 0.25, lastReadAt: expect.any(Number) }),
      })
    );
  });

  it("doesn't resend a place it already has", async () => {
    await itemLabelsStore.setPdfPlace(PDF, 'saved', { page: 5, at: 0.5 });
    api.addLabel.mockClear();
    await itemLabelsStore.setPdfPlace(PDF, 'saved', { page: 5, at: 0.5 });
    expect(api.addLabel).not.toHaveBeenCalled();
  });

  it('queues the place while offline', async () => {
    syncState.isOnline = false;
    await itemLabelsStore.setPdfPlace(PDF, 'saved', { page: 6, at: 0.1 });
    expect(api.addLabel).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'create',
      'label',
      `${PDF}\0pdfPlace`,
      expect.objectContaining({ label: 'pdfPlace', props: expect.objectContaining({ page: 6 }) })
    );
  });

  it("takes another device's newer place, and keeps its own newer one", async () => {
    await itemLabelsStore.setPdfPlace(PDF, 'saved', { page: 2, at: 0.5 });

    api.getAllLabels.mockResolvedValueOnce({
      labels: [remote(9, 0.75, Date.now() + 60_000)],
      nextSince: 'a',
    });
    await itemLabelsStore.pullDelta();
    expect(itemLabelsStore.getPdfPlace(PDF)).toEqual({ page: 9, at: 0.75 });

    api.getAllLabels.mockResolvedValueOnce({
      labels: [remote(1, 0.1, 1000)],
      nextSince: 'b',
    });
    await itemLabelsStore.pullDelta();
    expect(itemLabelsStore.getPdfPlace(PDF)).toEqual({ page: 9, at: 0.75 });
  });

  it('ignores a malformed place from the server', async () => {
    await itemLabelsStore.setPdfPlace(PDF, 'saved', { page: 3, at: 0.5 });
    api.getAllLabels.mockResolvedValueOnce({
      labels: [{ ...remote(3, 0.5, Date.now() + 60_000), props: { page: 0, at: 9 } }],
      nextSince: 'c',
    });
    await itemLabelsStore.pullDelta();
    expect(itemLabelsStore.getPdfPlace(PDF)).toEqual({ page: 3, at: 0.5 });
  });
});
