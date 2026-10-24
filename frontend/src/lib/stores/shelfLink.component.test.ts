// Linked collections in the Shelf store: link / unlink / sync, and the sync
// loop that keeps going while the server says members are still waiting to be
// written to Semble or Margin. Named `.component.test.ts` so the runes compile.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShelfCollection, ShelfLinkSync } from '$lib/types';

const api = vi.hoisted(() => ({
  getShelfCollections: vi.fn(),
  linkShelfCollection: vi.fn(),
  unlinkShelfCollection: vi.fn(),
  syncShelfCollection: vi.fn(),
}));
const saves = vi.hoisted(() => ({ articles: [], find: () => undefined, load: vi.fn() }));

vi.mock('$lib/services/api', () => ({ api }));
vi.mock('$lib/services/db', () => ({
  getMetadata: async () => null,
  setMetadata: async () => {},
}));
vi.mock('./auth.svelte', () => ({ auth: { user: { did: 'did:plc:me' }, isGuest: false } }));
vi.mock('./sync.svelte', () => ({ syncStore: { isOnline: true } }));
vi.mock('./toast.svelte', () => ({ toastStore: { add: vi.fn(() => 1), update: vi.fn() } }));
vi.mock('./itemLabels.svelte', () => ({ itemLabelsStore: { getKeptState: () => null } }));
vi.mock('./saves.svelte', () => ({ savesStore: saves }));

const { shelfStore } = await import('./shelf.svelte');

const C1 = '3kshelfcoll001';
const URI = 'at://did:plc:me/at.margin.collection/m1';
const LINK = { provider: 'margin' as const, uri: URI, syncedAt: 1 };

function collection(link: ShelfCollection['link'] = null): ShelfCollection {
  return {
    id: C1,
    name: 'Papers',
    description: null,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    link,
    items: [],
  };
}

function synced(over: Partial<Extract<ShelfLinkSync, { synced: true }>> = {}): ShelfLinkSync {
  return {
    synced: true,
    imported: 0,
    removed: 0,
    pushed: 0,
    deleted: 0,
    pending: 0,
    complete: true,
    ...over,
  };
}

async function loadWith(c: ShelfCollection) {
  api.getShelfCollections.mockResolvedValue({ collections: [c] });
  await shelfStore.load(true);
}

describe('shelfStore linked collections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links, then keeps syncing while members are still being written', async () => {
    await loadWith(collection());
    api.linkShelfCollection.mockResolvedValue({
      success: true,
      link: LINK,
      sync: synced({ pushed: 20, pending: 30 }),
    });
    api.syncShelfCollection
      .mockResolvedValueOnce(synced({ pushed: 20, pending: 10 }))
      .mockResolvedValueOnce(synced({ pushed: 10, pending: 0 }));
    await shelfStore.link(C1, 'margin', URI);
    expect(api.linkShelfCollection).toHaveBeenCalledWith(C1, {
      provider: 'margin',
      collectionUri: URI,
    });
    expect(api.syncShelfCollection).toHaveBeenCalledTimes(2);
    expect(shelfStore.find(C1)?.link?.uri).toBe(URI);
  });

  it('stops when a round writes nothing, rather than spinning on a failure', async () => {
    await loadWith(collection(LINK));
    api.syncShelfCollection.mockResolvedValue(synced({ pushed: 0, pending: 5 }));
    await shelfStore.sync(C1);
    expect(api.syncShelfCollection).toHaveBeenCalledTimes(1);
  });

  it('reloads saves and collections when something came in', async () => {
    await loadWith(collection(LINK));
    api.syncShelfCollection.mockResolvedValue(synced({ imported: 2 }));
    api.getShelfCollections.mockClear();
    await shelfStore.sync(C1);
    expect(saves.load).toHaveBeenCalledTimes(1);
    expect(api.getShelfCollections).toHaveBeenCalledTimes(1);
  });

  it("doesn't sync an unlinked collection", async () => {
    await loadWith(collection());
    await shelfStore.sync(C1);
    expect(api.syncShelfCollection).not.toHaveBeenCalled();
  });

  it('unlinks optimistically, and rolls back if the server refuses', async () => {
    await loadWith(collection(LINK));
    api.unlinkShelfCollection.mockRejectedValue(new Error('nope'));
    expect(await shelfStore.unlink(C1)).toBe(false);
    expect(shelfStore.find(C1)?.link?.uri).toBe(URI);
    api.unlinkShelfCollection.mockResolvedValue({ success: true });
    expect(await shelfStore.unlink(C1)).toBe(true);
    expect(shelfStore.find(C1)?.link).toBeNull();
  });
});
