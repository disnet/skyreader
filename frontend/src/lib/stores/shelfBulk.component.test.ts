// Bulk collection edits from the Library's select mode: shelfStore.addItems /
// removeItems, and the selection they act on. Named `.component.test.ts` so the
// runes in the stores compile.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedItem, ShelfCollection } from '$lib/types';

const api = vi.hoisted(() => ({
  getShelfCollections: vi.fn(),
  addManyToShelfCollection: vi.fn(),
  removeManyFromShelfCollection: vi.fn(),
}));
const toast = vi.hoisted(() => ({ add: vi.fn(() => 1), update: vi.fn() }));

vi.mock('$lib/services/api', () => ({ api }));
vi.mock('$lib/services/db', () => ({
  getMetadata: async () => null,
  setMetadata: async () => {},
}));
vi.mock('./auth.svelte', () => ({ auth: { user: { did: 'did:plc:me' }, isGuest: false } }));
vi.mock('./sync.svelte', () => ({ syncStore: { isOnline: true } }));
vi.mock('./toast.svelte', () => ({ toastStore: toast }));
vi.mock('./itemLabels.svelte', () => ({ itemLabelsStore: { getKeptState: () => null } }));
vi.mock('./saves.svelte', () => ({ savesStore: { articles: [], find: () => undefined } }));

const { shelfStore, MAX_COLLECTION_ITEMS } = await import('./shelf.svelte');
const { librarySelection } = await import('./librarySelection.svelte');

const C1 = '3kshelfcoll001';

function save(rkey: string): SavedItem {
  return { rkey, url: `https://example.com/${rkey}`, title: rkey } as SavedItem;
}

function rkey(i: number): string {
  return `3kbulkrkey${String(i).padStart(4, '0')}`;
}

function collection(members: string[]): ShelfCollection {
  return {
    id: C1,
    name: 'Imported from Pocket',
    description: null,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    items: members.map((r) => ({ rkey: r, addedAt: 1 })),
  };
}

async function loadWith(members: string[]) {
  api.getShelfCollections.mockResolvedValue({ collections: [collection(members)] });
  await shelfStore.load(true);
}

function members(): string[] {
  return shelfStore.find(C1)!.items.map((i) => i.rkey);
}

describe('shelfStore bulk edits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.addManyToShelfCollection.mockResolvedValue({ success: true });
    api.removeManyFromShelfCollection.mockResolvedValue({ success: true });
  });

  it('adds only the saves not already in the collection, in order, in one request', async () => {
    await loadWith([rkey(1)]);
    const ok = await shelfStore.addItems(C1, [save(rkey(3)), save(rkey(1)), save(rkey(2))]);
    expect(ok).toBe(true);
    expect(api.addManyToShelfCollection).toHaveBeenCalledTimes(1);
    expect(api.addManyToShelfCollection).toHaveBeenCalledWith(C1, [rkey(3), rkey(2)]);
    expect(members()).toEqual([rkey(1), rkey(3), rkey(2)]);
  });

  it('refuses a bulk add past the cap without sending it, and says how much room is left', async () => {
    const full = Array.from({ length: MAX_COLLECTION_ITEMS - 1 }, (_, i) => rkey(i));
    await loadWith(full);
    const ok = await shelfStore.addItems(C1, [save('3kextrarkey001'), save('3kextrarkey002')]);
    expect(ok).toBe(false);
    expect(api.addManyToShelfCollection).not.toHaveBeenCalled();
    expect(toast.update).toHaveBeenCalledWith(
      1,
      'error',
      '“Imported from Pocket” has room for 1 more'
    );
    expect(members()).toHaveLength(MAX_COLLECTION_ITEMS - 1);
  });

  it('rolls back an add the server refuses', async () => {
    await loadWith([]);
    api.addManyToShelfCollection.mockRejectedValue(
      new Error('A collection can hold at most 2000 items')
    );
    const ok = await shelfStore.addItems(C1, [save(rkey(1)), save(rkey(2))]);
    expect(ok).toBe(false);
    expect(members()).toEqual([]);
  });

  it('removes only members, in one request', async () => {
    await loadWith([rkey(1), rkey(2), rkey(3)]);
    const ok = await shelfStore.removeItems(C1, [rkey(3), rkey(1), rkey(9)]);
    expect(ok).toBe(true);
    expect(api.removeManyFromShelfCollection).toHaveBeenCalledWith(C1, [rkey(1), rkey(3)]);
    expect(members()).toEqual([rkey(2)]);
  });

  it('sends nothing when none of the selection is a member', async () => {
    await loadWith([rkey(1)]);
    expect(await shelfStore.removeItems(C1, [rkey(2)])).toBe(true);
    expect(api.removeManyFromShelfCollection).not.toHaveBeenCalled();
  });
});

describe('librarySelection', () => {
  beforeEach(() => librarySelection.end());

  it('acts only on what the list in view holds', () => {
    librarySelection.start();
    const all = [save(rkey(1)), save(rkey(2)), save(rkey(3))];
    librarySelection.selectAll(all);
    // A filter narrows the list: the hidden selection is left alone.
    expect(librarySelection.selectedIn([all[2], all[0]]).map((s) => s.rkey)).toEqual([
      rkey(3),
      rkey(1),
    ]);
    librarySelection.toggle(rkey(1));
    expect(librarySelection.selectedIn(all).map((s) => s.rkey)).toEqual([rkey(2), rkey(3)]);
  });

  it('ends with an empty selection', () => {
    librarySelection.start();
    librarySelection.toggle(rkey(1));
    librarySelection.end();
    expect(librarySelection.active).toBe(false);
    expect(librarySelection.has(rkey(1))).toBe(false);
  });
});
