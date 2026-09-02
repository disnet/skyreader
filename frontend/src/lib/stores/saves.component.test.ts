// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Guest saves are local-only: every mutation must take the offline branch
// (Dexie write + sync-queue entry, no API call, no extraction), because the
// queue that accumulates IS the migration on sign-in. A save that reached for
// the network would 401; a save that skipped the queue would silently not
// migrate. These tests pin both halves down.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedItem } from '$lib/types';

// ── Stand-ins ────────────────────────────────────────────────────────────────
// The real dependencies drag in Dexie, the HTTP client and the extractor. What
// is under test is the routing on top of them: which side of canReachBackend()
// each call lands on.

const savedRows = new Map<string, SavedItem>();
const articleRows: Array<{ guid: string; subscriptionId: number; content: string | null }> = [];

function whereEquals(rows: () => Record<string, unknown>[], field: string, val: unknown) {
  return {
    first: async () => rows().find((r) => r[field] === val),
    filter: (fn: (r: unknown) => boolean) => ({
      first: async () =>
        rows()
          .filter((r) => r[field] === val)
          .find(fn),
    }),
    delete: async () => {
      for (const [key, row] of [...savedRows]) {
        if ((row as unknown as Record<string, unknown>)[field] === val) savedRows.delete(key);
      }
    },
  };
}

vi.mock('$lib/services/db', () => ({
  db: {
    saved: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [...savedRows.values()] }) }),
      get: async (rkey: string) => savedRows.get(rkey),
      put: async (item: SavedItem) => void savedRows.set(item.rkey, item),
      delete: async (rkey: string) => void savedRows.delete(rkey),
      clear: async () => savedRows.clear(),
      where: (field: string) => ({
        equals: (val: unknown) =>
          whereEquals(
            () => [...savedRows.values()] as unknown as Record<string, unknown>[],
            field,
            val
          ),
      }),
    },
    articles: {
      where: (field: string) => ({
        equals: (val: unknown) =>
          whereEquals(() => articleRows as unknown as Record<string, unknown>[], field, val),
      }),
    },
  },
}));

vi.mock('$lib/services/safeDb.svelte', () => ({
  safePut: async (table: { put: (v: unknown) => Promise<void> }, value: unknown) =>
    table.put(value),
  safeBulkPut: async (table: { put: (v: unknown) => Promise<void> }, values: unknown[]) => {
    for (const v of values) await table.put(v);
  },
}));

const api = {
  getSaved: vi.fn(),
  getSavedBodies: vi.fn(),
  saveFromUrl: vi.fn(),
  updateSaved: vi.fn(),
  deleteSaved: vi.fn(),
  deleteSavedByGuid: vi.fn(),
};
vi.mock('$lib/services/api', () => ({ api }));

const extractArticle = vi.fn();
vi.mock('$lib/services/extract', () => ({ extractArticle }));

const enqueue = vi.fn(async () => {});
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue } }));

vi.mock('./savedSearch.svelte', () => ({
  savedSearchStore: { invalidate: vi.fn(), upsert: vi.fn(), remove: vi.fn() },
}));

const authState = { isGuest: true };
vi.mock('./auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
  },
}));

const syncState = { isOnline: true };
vi.mock('./sync.svelte', () => ({
  syncStore: {
    get isOnline() {
      return syncState.isOnline;
    },
  },
}));

const { savesStore } = await import('./saves.svelte');

describe('savesStore in guest mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    articleRows.length = 0;
    authState.isGuest = true;
    syncState.isOnline = true;
    // Drain the store's list between tests (its module state persists).
    for (const a of [...savesStore.articles]) void savesStore.remove(a.rkey);
    vi.clearAllMocks();
  });

  it('load() stops at the Dexie cache and never asks the backend', async () => {
    savedRows.set('3kaaaaaaaaaaa', {
      rkey: '3kaaaaaaaaaaa',
      uri: '',
      url: 'https://example.com/piece',
      title: 'A Piece',
      author: null,
      description: null,
      content: '<p>body</p>',
      contentType: 'article',
      domain: null,
      image: null,
      wordCount: 1,
      publishedAt: null,
      savedAt: '2026-08-01T00:00:00.000Z',
      itemGuid: 'guid-1',
    } as SavedItem);

    await savesStore.load();

    expect(savesStore.articles).toHaveLength(1);
    expect(api.getSaved).not.toHaveBeenCalled();
    expect(api.getSavedBodies).not.toHaveBeenCalled();
  });

  it('saveArticle writes locally with the RSS body and queues the create for sign-in', async () => {
    articleRows.push({ guid: 'guid-1', subscriptionId: 7, content: '<p>the rss body text</p>' });

    const saved = await savesStore.saveArticle({
      url: 'https://example.com/piece',
      guid: 'guid-1',
      subscriptionId: 7,
      title: 'A Piece',
    });

    // Online, but a guest: the network half must not run.
    expect(api.saveFromUrl).not.toHaveBeenCalled();
    expect(extractArticle).not.toHaveBeenCalled();

    // The local half did: full row in Dexie, visible in the store, queued.
    expect(savedRows.get(saved.rkey)?.content).toBe('<p>the rss body text</p>');
    expect(saved.wordCount).toBeGreaterThan(0);
    expect(savesStore.isSaved('guid-1')).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(
      'create',
      'saved',
      'guid-1',
      expect.objectContaining({ rkey: saved.rkey, url: 'https://example.com/piece' })
    );
  });

  it('unsaveByGuid removes locally and queues the delete', async () => {
    await savesStore.saveArticle({ url: 'https://example.com/piece', guid: 'guid-1' });
    enqueue.mockClear();

    await savesStore.unsaveByGuid('guid-1');

    expect(savesStore.isSaved('guid-1')).toBe(false);
    expect(savedRows.size).toBe(0);
    expect(api.deleteSavedByGuid).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'delete',
      'saved',
      'guid-1',
      expect.objectContaining({ itemGuid: 'guid-1' })
    );
  });

  it('getContent never falls back to the network for a guest', async () => {
    const saved = await savesStore.saveArticle({
      url: 'https://example.com/bodyless',
      guid: 'guid-2',
    });

    // No RSS body was available, so there is nothing locally — and for a guest
    // there is no server copy either. The answer is null, not a 401.
    expect(await savesStore.getContent(saved.rkey)).toBeNull();
    expect(api.getSavedBodies).not.toHaveBeenCalled();
  });
});
