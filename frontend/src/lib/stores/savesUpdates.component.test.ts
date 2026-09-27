// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// A save edited in place — the browser extension re-saving a URL with a
// better live-DOM extraction — keeps its rkey and saved_at, so the newest-first
// incremental refresh (which stops at the first cached rkey) never re-sends it.
// load() asks GET /api/saved/updates for rows changed since its high-water mark
// and re-hydrates the ones whose local updatedAt is out of date.
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
      delete: async (rkey: string) => void savedRows.delete(rkey),
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
}));

const api = {
  getSaved: vi.fn(),
  getSavedBodies: vi.fn(async () => ({ bodies: {} })),
  getSavedUpdates: vi.fn(),
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

function save(rkey: string, savedAt: string, extra: Partial<SavedItem> = {}): SavedItem {
  return {
    rkey,
    uri: `at://x/${rkey}`,
    url: `https://example.com/${rkey}`,
    title: rkey,
    author: null,
    description: null,
    content: 'old body',
    savedAt,
    ...extra,
  } as unknown as SavedItem;
}

// The list endpoint is metadata-only.
function meta(item: SavedItem): SavedItem {
  return { ...item, content: null };
}

const EDITED_AT = '2026-03-01T00:00:00.000Z';

describe('in-place edits to an already-cached save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    metadataRows.clear();
    pendingSavedRkeys.mockResolvedValue(new Set<string>());
    // Cached before the edit; the refresh's first row is already cached.
    const cached = save('older', '2026-01-01T00:00:00Z');
    savedRows.set('older', cached);
    api.getSaved.mockResolvedValue({ full: false, cursor: null, articles: [meta(cached)] });
    api.getSavedUpdates.mockResolvedValue({
      articles: [
        meta(save('older', '2026-01-01T00:00:00Z', { title: 'Full Title', updatedAt: EDITED_AT })),
      ],
      next: 1234,
      more: false,
    });
    api.getSavedBodies.mockResolvedValue({ bodies: { older: 'new body' } });
  });

  it('re-hydrates the edited body and metadata and advances the mark', async () => {
    // The reader opened it before the edit, so an in-memory copy exists.
    api.getSavedUpdates.mockResolvedValueOnce({ articles: [], next: 1000, more: false });
    await savesStore.load();
    expect(await savesStore.getContent('older')).toBe('old body');

    await savesStore.load();

    expect(api.getSavedUpdates).toHaveBeenLastCalledWith(1000);
    expect(api.getSavedBodies).toHaveBeenCalledWith(['older']);
    expect(savedRows.get('older')?.content).toBe('new body');
    expect(savedRows.get('older')?.updatedAt).toBe(EDITED_AT);
    expect(savesStore.articles.find((a) => a.rkey === 'older')?.title).toBe('Full Title');
    expect(await savesStore.getContent('older')).toBe('new body');
    expect(metadataRows.get('savedUpdatesSince')).toBe(1234);
  });

  it('skips an edit the cache already holds', async () => {
    savedRows.set('older', save('older', '2026-01-01T00:00:00Z', { updatedAt: EDITED_AT }));

    await savesStore.load();

    expect(api.getSavedBodies).not.toHaveBeenCalled();
    expect(savedRows.get('older')?.content).toBe('old body');
    expect(metadataRows.get('savedUpdatesSince')).toBe(1234);
  });

  it('leaves the mark in place when the new body fails to load', async () => {
    metadataRows.set('savedUpdatesSince', 99);
    api.getSavedBodies.mockRejectedValue(new Error('offline'));

    await savesStore.load();

    expect(api.getSavedUpdates).toHaveBeenCalledWith(99);
    expect(savedRows.get('older')?.content).toBe('old body');
    expect(savedRows.get('older')?.updatedAt).toBeUndefined();
    expect(metadataRows.get('savedUpdatesSince')).toBe(99);
  });

  it('refetches a stale body from an external-backed snapshot', async () => {
    api.getSaved.mockResolvedValue({
      full: true,
      cursor: null,
      digest: 'd2',
      articles: [meta(save('older', '2026-01-01T00:00:00Z', { updatedAt: EDITED_AT }))],
    });

    await savesStore.load();

    expect(api.getSavedBodies).toHaveBeenCalledWith(['older']);
    expect(savedRows.get('older')?.content).toBe('new body');
  });
});
