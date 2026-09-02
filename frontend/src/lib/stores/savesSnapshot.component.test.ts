// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// An external-backed Saved list (Semble/Margin) is served as a full snapshot
// that REPLACES the cache, because membership can be removed in the other app
// and a merge could never notice. The snapshot is not authoritative about saves
// that were never sent, though: anything still in the queue is invisible to the
// collection by definition. Dropping those rows made a guest's saves vanish on
// the first authenticated boot, since load() runs before the queue drains.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedItem } from '$lib/types';

const savedRows = new Map<string, SavedItem>();

vi.mock('$lib/services/db', () => ({
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

function save(rkey: string, savedAt: string): SavedItem {
  return {
    rkey,
    uri: `at://x/${rkey}`,
    url: `https://example.com/${rkey}`,
    title: rkey,
    author: null,
    description: null,
    content: 'body',
    savedAt,
  } as unknown as SavedItem;
}

describe('external-backed snapshot replace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    pendingSavedRkeys.mockResolvedValue(new Set<string>());
  });

  it('keeps a save whose create has not been sent yet', async () => {
    // Carried over from guest mode: in the cache, still in the queue.
    savedRows.set('unsent', save('unsent', '2026-02-02T00:00:00Z'));
    pendingSavedRkeys.mockResolvedValue(new Set(['unsent']));
    api.getSaved.mockResolvedValue({
      full: true,
      articles: [save('remote', '2026-01-01T00:00:00Z')],
    });

    await savesStore.load();

    expect(savesStore.articles.map((a) => a.rkey).sort()).toEqual(['remote', 'unsent']);
    // And it survives in Dexie, not just in the list.
    expect([...savedRows.keys()].sort()).toEqual(['remote', 'unsent']);
  });

  it('still drops a synced row the collection no longer holds', async () => {
    // The whole point of the snapshot path: removal elsewhere must land here.
    savedRows.set('removed-elsewhere', save('removed-elsewhere', '2026-02-02T00:00:00Z'));
    api.getSaved.mockResolvedValue({
      full: true,
      articles: [save('remote', '2026-01-01T00:00:00Z')],
    });

    await savesStore.load();

    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['remote']);
    expect([...savedRows.keys()]).toEqual(['remote']);
  });

  it('does not duplicate a pending save the snapshot already carries', async () => {
    savedRows.set('both', save('both', '2026-02-02T00:00:00Z'));
    pendingSavedRkeys.mockResolvedValue(new Set(['both']));
    api.getSaved.mockResolvedValue({
      full: true,
      articles: [save('both', '2026-02-02T00:00:00Z')],
    });

    await savesStore.load();

    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['both']);
  });

  it('keeps the merged list in savedAt order', async () => {
    savedRows.set('unsent', save('unsent', '2026-03-03T00:00:00Z'));
    pendingSavedRkeys.mockResolvedValue(new Set(['unsent']));
    api.getSaved.mockResolvedValue({
      full: true,
      articles: [save('older', '2026-01-01T00:00:00Z'), save('newer', '2026-04-04T00:00:00Z')],
    });

    await savesStore.load();

    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['newer', 'unsent', 'older']);
  });
});
