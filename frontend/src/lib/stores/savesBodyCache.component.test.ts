// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// A large library's first login: the list shows page by page and before its
// text, and the text is a capped cache (newest or most recently opened first)
// rather than a mirror of every body.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedItem } from '$lib/types';

const savedRows = new Map<string, SavedItem>();
const metadataRows = new Map<string, unknown>();

vi.mock('$lib/services/db', () => ({
  getMetadata: async (key: string) => metadataRows.get(key) ?? null,
  setMetadata: async (key: string, value: unknown) => void metadataRows.set(key, value),
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
      bulkDelete: async (rkeys: string[]) => rkeys.forEach((r) => savedRows.delete(r)),
      clear: async () => savedRows.clear(),
      where: () => ({
        equals: () => ({ first: async () => undefined, delete: async () => {} }),
      }),
    },
    articles: {
      where: () => ({ equals: () => ({ first: async () => undefined }) }),
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

const api = {
  getSaved: vi.fn(),
  getSavedBodies: vi.fn(async () => ({ bodies: {} })),
  getSavedUpdates: vi.fn(),
  deleteSaved: vi.fn(async () => ({})),
  updateSaved: vi.fn(async () => ({ success: true })),
};
vi.mock('$lib/services/api', () => ({ api }));

const pendingSavedRkeys = vi.fn(async () => new Set<string>());
vi.mock('$lib/services/sync-queue', () => ({
  syncQueue: { enqueue: vi.fn(async () => {}), pendingSavedRkeys },
}));

vi.mock('$lib/services/extract', () => ({ extractArticle: vi.fn() }));
vi.mock('./savedSearch.svelte', () => ({
  savedSearchStore: { invalidate: vi.fn(), upsert: vi.fn(), remove: vi.fn() },
}));
vi.mock('./auth.svelte', () => ({ auth: { isGuest: false } }));
vi.mock('./sync.svelte', () => ({ syncStore: { isOnline: true } }));

const { savesStore } = await import('./saves.svelte');

// The cache budget in saves.svelte.ts (BODY_CACHE_BUDGET), in string length.
const BUDGET = 50_000_000;

function save(rkey: string, savedAt: string, extra: Partial<SavedItem> = {}): SavedItem {
  return {
    rkey,
    uri: `at://x/${rkey}`,
    url: `https://example.com/${rkey}`,
    title: rkey,
    author: null,
    description: null,
    content: null,
    savedAt,
    ...extra,
  } as unknown as SavedItem;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const noUpdates = { articles: [], next: 1, more: false };

beforeEach(() => {
  vi.clearAllMocks();
  savedRows.clear();
  metadataRows.clear();
  pendingSavedRkeys.mockResolvedValue(new Set<string>());
  api.getSavedUpdates.mockResolvedValue(noUpdates);
  api.getSavedBodies.mockResolvedValue({ bodies: {} });
});

describe('first load of a large library', () => {
  it('shows each page of the list as it lands', async () => {
    const second = deferred<unknown>();
    api.getSaved
      .mockResolvedValueOnce({
        full: false,
        cursor: 'c1',
        articles: [save('a', '2026-03-01T00:00:00Z')],
      })
      .mockReturnValueOnce(second.promise);

    const loading = savesStore.load();
    await vi.waitFor(() => expect(api.getSaved).toHaveBeenCalledTimes(2));
    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['a']);
    expect(api.getSaved).toHaveBeenNthCalledWith(2, { limit: 200, cursor: 'c1' });

    second.resolve({ full: false, cursor: null, articles: [save('b', '2026-02-01T00:00:00Z')] });
    await loading;
    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['a', 'b']);
  });

  // A distinct rkey: the store remembers "no body" answers across loads.
  it('lists and stores the saves before their text arrives', async () => {
    const bodies = deferred<{ bodies: Record<string, string> }>();
    api.getSaved.mockResolvedValue({
      full: false,
      cursor: null,
      articles: [save('fresh', '2026-03-01T00:00:00Z')],
    });
    api.getSavedBodies.mockReturnValue(bodies.promise);

    const loading = savesStore.load();
    await vi.waitFor(() => expect(api.getSavedBodies).toHaveBeenCalled());
    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['fresh']);
    expect(savesStore.loading).toBe(false);
    expect(savedRows.get('fresh')?.content).toBeNull();

    bodies.resolve({ bodies: { fresh: 'one two three' } });
    await loading;
    expect(savedRows.get('fresh')?.content).toBe('one two three');
    expect(savesStore.articles[0].wordCount).toBe(3);
  });
});

describe('capped text cache', () => {
  it('fetches no more text once the cache is at its budget', async () => {
    savedRows.set('big', save('big', '2026-01-01T00:00:00Z', { content: 'x'.repeat(BUDGET) }));
    api.getSaved.mockResolvedValue({
      full: false,
      cursor: null,
      articles: [save('new', '2026-03-01T00:00:00Z'), save('big', '2026-01-01T00:00:00Z')],
    });

    await savesStore.load();

    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['new', 'big']);
    expect(api.getSavedBodies).not.toHaveBeenCalled();
  });

  it('drops the text of the least recent saves past the budget, keeping their rows', async () => {
    const half = 'x'.repeat(BUDGET * 0.6);
    savedRows.set('old', save('old', '2026-01-01T00:00:00Z', { content: half }));
    savedRows.set('new', save('new', '2026-02-01T00:00:00Z', { content: half }));
    api.getSaved.mockResolvedValue({
      full: false,
      cursor: null,
      articles: [save('new', '2026-02-01T00:00:00Z')],
    });

    await savesStore.load();

    expect(savedRows.get('new')?.content).toBe(half);
    expect(savedRows.get('old')?.content).toBeNull();
    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['new', 'old']);
  });

  it('keeps a recently opened save over a newer unopened one', async () => {
    const half = 'x'.repeat(BUDGET * 0.6);
    savedRows.set(
      'old',
      save('old', '2026-01-01T00:00:00Z', { content: half, openedAt: Date.parse('2026-04-01') })
    );
    savedRows.set('new', save('new', '2026-02-01T00:00:00Z', { content: half }));
    api.getSaved.mockResolvedValue({
      full: false,
      cursor: null,
      articles: [save('new', '2026-02-01T00:00:00Z')],
    });

    await savesStore.load();

    expect(savedRows.get('old')?.content).toBe(half);
    expect(savedRows.get('new')?.content).toBeNull();
  });

  it('never drops the text of a save the server has yet to receive', async () => {
    const half = 'x'.repeat(BUDGET * 0.6);
    savedRows.set('unsent', save('unsent', '2026-01-01T00:00:00Z', { content: half }));
    savedRows.set('new', save('new', '2026-02-01T00:00:00Z', { content: half }));
    pendingSavedRkeys.mockImplementation(async (op?: string) =>
      op ? new Set<string>() : new Set(['unsent'])
    );
    api.getSaved.mockResolvedValue({
      full: false,
      cursor: null,
      articles: [save('new', '2026-02-01T00:00:00Z')],
    });

    await savesStore.load();

    expect(savedRows.get('unsent')?.content).toBe(half);
  });

  it('takes an edit of a save whose text it dropped as metadata alone', async () => {
    savedRows.set('older', save('older', '2026-01-01T00:00:00Z'));
    api.getSaved.mockResolvedValue({
      full: false,
      cursor: null,
      articles: [save('older', '2026-01-01T00:00:00Z')],
    });
    api.getSavedUpdates.mockResolvedValue({
      articles: [
        save('older', '2026-01-01T00:00:00Z', {
          title: 'Edited',
          updatedAt: '2026-03-01T00:00:00.000Z',
        }),
      ],
      next: 99,
      more: false,
    });

    await savesStore.load();

    expect(api.getSavedBodies).not.toHaveBeenCalled();
    expect(savedRows.get('older')?.title).toBe('Edited');
    expect(metadataRows.get('savedUpdatesSinceV2')).toBe(99);
  });

  it('remembers when a save was opened', async () => {
    savedRows.set('a', save('a', '2026-01-01T00:00:00Z', { content: 'text' }));
    await savesStore.getContent('a', { opening: true });
    await vi.waitFor(() => expect(savedRows.get('a')?.openedAt).toBeTypeOf('number'));
  });
});
