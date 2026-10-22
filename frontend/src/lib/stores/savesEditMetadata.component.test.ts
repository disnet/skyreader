// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// savesStore.editMetadata: a reader's edit of a save's title/author/date shows
// at once, sticks across reloads (IndexedDB), and reaches the server — or waits
// in the sync queue when it can't. A rejected edit is put back.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedItem } from '$lib/types';

const savedRows = new Map<string, SavedItem>();

vi.mock('$lib/services/db', () => ({
  getMetadata: async () => null,
  setMetadata: async () => {},
  db: {
    saved: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [...savedRows.values()] }) }),
      get: async (rkey: string) => savedRows.get(rkey),
      put: async (item: SavedItem) => void savedRows.set(item.rkey, item),
      update: async (rkey: string, changes: Partial<SavedItem>) => {
        const row = savedRows.get(rkey);
        if (row) savedRows.set(rkey, { ...row, ...changes });
        return row ? 1 : 0;
      },
      delete: async (rkey: string) => void savedRows.delete(rkey),
      clear: async () => savedRows.clear(),
    },
  },
}));

vi.mock('$lib/services/safeDb.svelte', () => ({
  safePut: async (table: { put: (v: unknown) => Promise<void> }, v: unknown) => table.put(v),
  safeBulkPut: async (table: { put: (v: unknown) => Promise<void> }, vs: unknown[]) => {
    for (const v of vs) await table.put(v);
  },
  safeUpdate: async (
    table: { update: (k: string, v: unknown) => Promise<number> },
    k: string,
    v: unknown
  ) => table.update(k, v),
}));

class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

const api = {
  getSaved: vi.fn(),
  getSavedBodies: vi.fn(async () => ({ bodies: {} })),
  getSavedUpdates: vi.fn(async () => ({ articles: [], next: 0, more: false })),
  updateSaved: vi.fn(),
};
vi.mock('$lib/services/api', () => ({ api, ApiError }));

const enqueue = vi.fn(async () => {});
vi.mock('$lib/services/sync-queue', () => ({
  syncQueue: { enqueue, pendingSavedRkeys: async () => new Set<string>() },
}));

vi.mock('$lib/services/extract', () => ({ extractArticle: vi.fn() }));
vi.mock('./savedSearch.svelte', () => ({
  savedSearchStore: { invalidate: vi.fn(), upsert: vi.fn(), remove: vi.fn() },
}));
vi.mock('./auth.svelte', () => ({ auth: { isGuest: false } }));
const sync = { isOnline: true };
vi.mock('./sync.svelte', () => ({ syncStore: sync }));

const { savesStore } = await import('./saves.svelte');

const RKEY = 'aaaaaaaaaaaaa';
const original = {
  rkey: RKEY,
  uri: `at://x/${RKEY}`,
  url: 'https://example.com/a',
  title: 'Extracted',
  author: 'Site',
  description: null,
  content: 'body',
  savedAt: '2026-01-01T00:00:00Z',
} as unknown as SavedItem;

describe('savesStore.editMetadata', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sync.isOnline = true;
    savedRows.clear();
    savedRows.set(RKEY, { ...original });
    api.getSaved.mockResolvedValue({ full: false, cursor: null, articles: [] });
    await savesStore.load();
  });

  it('applies the edit locally and sends it, taking the server stamp', async () => {
    api.updateSaved.mockResolvedValue({ success: true, updatedAt: '2026-02-02T00:00:00.000Z' });

    await savesStore.editMetadata(RKEY, { title: 'Mine', author: null });

    expect(api.updateSaved).toHaveBeenCalledWith(RKEY, { title: 'Mine', author: null });
    const live = savesStore.getByRkey(RKEY)!;
    expect(live.title).toBe('Mine');
    expect(live.author).toBeNull();
    expect(live.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(savedRows.get(RKEY)).toMatchObject({ title: 'Mine', content: 'body' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues the edit when offline', async () => {
    sync.isOnline = false;

    await savesStore.editMetadata(RKEY, { title: 'Mine' });

    expect(api.updateSaved).not.toHaveBeenCalled();
    expect(savesStore.getByRkey(RKEY)!.title).toBe('Mine');
    expect(enqueue).toHaveBeenCalledWith('update', 'saved', RKEY, {
      rkey: RKEY,
      url: 'https://example.com/a',
      metadata: { title: 'Mine' },
    });
  });

  it('queues the edit when the server is unreachable', async () => {
    api.updateSaved.mockRejectedValue(new TypeError('Failed to fetch'));

    await savesStore.editMetadata(RKEY, { title: 'Mine' });

    expect(savesStore.getByRkey(RKEY)!.title).toBe('Mine');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('puts a rejected edit back and rethrows', async () => {
    api.updateSaved.mockRejectedValue(new ApiError('Title cannot be empty', 400));

    await expect(savesStore.editMetadata(RKEY, { title: '', author: 'Me' })).rejects.toThrow(
      'Title cannot be empty'
    );

    expect(savesStore.getByRkey(RKEY)).toMatchObject({ title: 'Extracted', author: 'Site' });
    expect(savedRows.get(RKEY)).toMatchObject({ title: 'Extracted', author: 'Site' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
