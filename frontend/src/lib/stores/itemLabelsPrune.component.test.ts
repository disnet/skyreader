// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// pruneStaleReads drops this device's copy of old read labels for items it no
// longer holds, and nothing else.
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/services/sync-queue', () => ({
  syncQueue: { enqueue: vi.fn(async () => {}), cancelPending: vi.fn() },
}));
vi.mock('$lib/services/api', () => ({ api: {} }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const OLD = NOW - 120 * DAY;
const read = (itemKey: string, updatedAt: number, itemType = 'article') => ({
  itemKey,
  itemType,
  label: 'read',
  props: { readAt: updatedAt },
  createdAt: updatedAt,
  updatedAt,
});
const cached = [
  read('gone', OLD),
  read('gone-doc', OLD, 'document'),
  read('held-article', OLD),
  read('held-doc', OLD, 'document'),
  read('saved-guid', OLD),
  read('queued', OLD),
  read('recent', NOW - 10 * DAY),
  read('on-screen', OLD),
  { ...read('archived-old', OLD), label: 'archived' },
];

const deleted: Array<[string, string]> = [];
const keysOf = (keys: string[]) => ({ orderBy: () => ({ uniqueKeys: async () => keys }) });
vi.mock('$lib/services/db', () => ({
  db: {
    itemLabels: {
      toArray: async () => cached,
      where: () => ({
        anyOf: (pairs: Array<[string, string]>) => ({
          and: (keep: (l: (typeof cached)[number]) => boolean) => ({
            delete: async () => {
              for (const [key, label] of pairs) {
                const row = cached.find((l) => l.itemKey === key && l.label === label);
                if (row && keep(row)) deleted.push([key, label]);
              }
            },
          }),
        }),
      }),
    },
    articles: keysOf(['held-article']),
    socialDocuments: keysOf(['held-doc']),
    syncQueue: {
      where: () => ({
        between: ([collection]: [string, string]) => ({
          toArray: async () =>
            [
              { collection: 'reading', key: 'queued' },
              { collection: 'reading', key: 'queued-new' },
              { collection: 'label', key: 'gone' },
            ].filter((e) => e.collection === collection),
        }),
      }),
    },
    saved: { toArray: async () => [] },
  },
  getMetadata: async () => undefined,
  setMetadata: async () => {},
}));
vi.mock('$lib/services/safeDb.svelte', () => ({
  safePut: async () => {},
  safeBulkPut: async () => {},
}));
vi.mock('./auth.svelte', () => ({ auth: { isGuest: false, user: { did: 'did:plc:me' } } }));
vi.mock('./sync.svelte', () => ({ syncStore: { isOnline: false, markSynced: () => {} } }));
vi.mock('./saves.svelte', () => ({
  savesStore: {
    articles: [{ rkey: 'r1', uri: 'at://x/y/r1', url: 'https://e.com/a', itemGuid: 'saved-guid' }],
    loading: false,
    isSaved: () => false,
  },
}));

const { itemLabelsStore } = await import('./itemLabels.svelte');

describe('pruneStaleReads', () => {
  it('drops old reads for items the device no longer holds, once a session', async () => {
    await itemLabelsStore.loadCached();

    expect(await itemLabelsStore.pruneStaleReads(['on-screen'], NOW)).toBe(2);

    expect(itemLabelsStore.isRead('gone')).toBe(false);
    expect(itemLabelsStore.isSocialRead('gone-doc')).toBe(false);
    expect(deleted).toEqual([
      ['gone', 'read'],
      ['gone-doc', 'read'],
    ]);
    // Held, saved, queued and recent reads stay, and so does every other label.
    for (const key of ['held-article', 'saved-guid', 'queued', 'recent', 'on-screen']) {
      expect(itemLabelsStore.isRead(key)).toBe(true);
    }
    expect(itemLabelsStore.isSocialRead('held-doc')).toBe(true);
    expect(itemLabelsStore.isArchived('archived-old')).toBe(true);

    expect(await itemLabelsStore.pruneStaleReads([], NOW)).toBe(0);
  });

  it('adopts served reads, but never over a read or unread still queued', async () => {
    // 'gone' lost its label above; 'queued' has a queued entry; 'fresh' is new.
    await itemLabelsStore.adoptServedReads(['gone', 'fresh', 'queued-new'], 'article');
    expect(itemLabelsStore.isRead('gone')).toBe(true);
    expect(itemLabelsStore.isRead('fresh')).toBe(true);
    expect(itemLabelsStore.isRead('queued-new')).toBe(false);
  });
});
