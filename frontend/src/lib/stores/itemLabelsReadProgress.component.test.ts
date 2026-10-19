// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// A reading position can be filed under any of a save's keys, depending on the
// surface and device that wrote it; restore takes the newest across them. Writes
// are debounced per item and flushed when the page is hidden.
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

const URI = 'at://did:plc:me/app.skyreader.feed.saved/3kabc';
const GUID = 'https://example.com/post#guid';

function remote(itemKey: string, paragraphIndex: number, lastReadAt: number) {
  return {
    itemKey,
    itemType: 'saved',
    label: 'readProgress',
    props: { paragraphIndex, totalParagraphs: 40, lastReadAt },
    createdAt: 1,
    updatedAt: Math.floor(lastReadAt / 1000),
    deletedAt: null,
  };
}

describe('read progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('restores the newest position across a save’s keys, skipping the opened marker', async () => {
    api.getAllLabels.mockResolvedValueOnce({
      labels: [remote(GUID, 5, 1_000), remote(URI, 22, 2_000), remote('3kabc', -1, 3_000)],
      hasMore: false,
    });
    await itemLabelsStore.load();

    expect(itemLabelsStore.getReadProgress(URI)?.paragraphIndex).toBe(22);
    expect(itemLabelsStore.getLatestReadProgress([GUID, URI, '3kabc'])).toEqual({
      paragraphIndex: 22,
      totalParagraphs: 40,
      lastReadAt: 2_000,
    });
    expect(itemLabelsStore.getLatestReadProgress(['nothing-here'])).toBeNull();
  });

  it('keeps one pending write per item and flushes them all on demand', async () => {
    vi.useFakeTimers();
    itemLabelsStore.setReadProgress('item-a', 'article', 7, 30);
    itemLabelsStore.setReadProgress('item-b', 'article', 3, 30);
    expect(api.addLabel).not.toHaveBeenCalled();

    itemLabelsStore.flushReadProgress();
    await vi.runAllTimersAsync();

    const written = api.addLabel.mock.calls.map(
      (c) => (c as unknown as [{ itemKey: string }])[0].itemKey
    );
    expect(written.sort()).toEqual(['item-a', 'item-b']);
    expect(itemLabelsStore.getReadProgress('item-a')?.paragraphIndex).toBe(7);
  });
});
