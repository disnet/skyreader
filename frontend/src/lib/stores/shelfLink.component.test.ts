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
  createShelfCollection: vi.fn(),
  deleteShelfCollection: vi.fn(),
}));
const saves = vi.hoisted(() => ({
  // Two articles, one saved twice (the server pushes it once), an uploaded
  // book, and a save whose URL never came through.
  articles: [
    { rkey: 'a1', url: 'https://example.com/a', source: 'url' },
    { rkey: 'a1dup', url: 'https://example.com/a/?utm_source=x', source: 'feed' },
    { rkey: 'b1', url: '', source: 'upload' },
    { rkey: 'a2', url: 'https://example.com/b', source: 'feed' },
    { rkey: 'n1', url: '', source: 'document' },
  ],
  find: () => undefined,
  load: vi.fn(),
}));

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

  it('links at once, then syncs behind it while members are still being written', async () => {
    await loadWith(collection());
    api.linkShelfCollection.mockResolvedValue({ success: true, link: LINK, sync: null });
    api.syncShelfCollection
      .mockResolvedValueOnce(synced({ pushed: 20, pending: 30 }))
      .mockResolvedValueOnce(synced({ pushed: 20, pending: 10 }))
      .mockResolvedValueOnce(synced({ pushed: 10, pending: 0 }));
    await shelfStore.link(C1, 'margin', URI);
    // The link is saved and shown before any of the syncing is done.
    expect(api.linkShelfCollection).toHaveBeenCalledWith(C1, {
      provider: 'margin',
      collectionUri: URI,
      deferSync: true,
    });
    expect(shelfStore.find(C1)?.link?.uri).toBe(URI);
    await vi.waitFor(() => expect(api.syncShelfCollection).toHaveBeenCalledTimes(3));
    expect(api.syncShelfCollection).toHaveBeenCalledWith(C1, true);
  });

  it('keeps bringing a large collection in, a share per round, showing each', async () => {
    await loadWith(collection(LINK));
    api.syncShelfCollection
      .mockResolvedValueOnce(synced({ imported: 300, complete: false }))
      .mockResolvedValueOnce(synced({ imported: 300, complete: false }))
      .mockResolvedValueOnce(synced({ imported: 50, complete: true }));
    await shelfStore.sync(C1, { force: true });
    expect(api.syncShelfCollection).toHaveBeenCalledTimes(3);
    // Each share shows up before the next is fetched.
    expect(saves.load).toHaveBeenCalledTimes(3);
  });

  it('stops bringing more in when a cut-short round brought nothing', async () => {
    await loadWith(collection(LINK));
    api.syncShelfCollection.mockResolvedValue(synced({ imported: 0, complete: false }));
    await shelfStore.sync(C1, { force: true });
    expect(api.syncShelfCollection).toHaveBeenCalledTimes(1);
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

  it('waits out a sync already running, then reloads to show what it did', async () => {
    vi.useFakeTimers();
    try {
      await loadWith(collection(LINK));
      api.syncShelfCollection
        .mockResolvedValueOnce({ synced: false, reason: 'locked' })
        .mockResolvedValueOnce({ synced: false, reason: 'gated' });
      api.getShelfCollections.mockClear();
      const run = shelfStore.sync(C1);
      await vi.advanceTimersByTimeAsync(2000);
      await run;
      expect(api.syncShelfCollection).toHaveBeenCalledTimes(2);
      expect(saves.load).toHaveBeenCalledTimes(1);
      expect(api.getShelfCollections).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it('counts what a link can carry over and what stays (uploads)', async () => {
    const c = collection();
    c.items = ['a1', 'a1dup', 'b1', 'a2', 'n1', 'gone'].map((rkey) => ({ rkey, addedAt: 1 }));
    await loadWith(c);
    expect(shelfStore.linkSplit(C1)).toEqual({ linkable: 2, uploads: 1, other: 1 });
  });

  it('imports a foreign collection as a new, linked Shelf collection', async () => {
    api.getShelfCollections.mockResolvedValue({ collections: [] });
    await shelfStore.load(true);
    api.createShelfCollection.mockResolvedValue({ success: true });
    api.linkShelfCollection.mockResolvedValue({ success: true, link: LINK, sync: null });
    api.syncShelfCollection.mockResolvedValue(synced());
    const id = await shelfStore.importLinked('margin', URI, 'Reading list', 'For later');
    expect(id).toBeTruthy();
    expect(api.createShelfCollection).toHaveBeenCalledWith(
      expect.objectContaining({ id, name: 'Reading list', description: 'For later' })
    );
    expect(api.linkShelfCollection).toHaveBeenCalledWith(id, {
      provider: 'margin',
      collectionUri: URI,
      deferSync: true,
    });
    expect(shelfStore.find(id!)?.link?.uri).toBe(URI);
    await vi.waitFor(() => expect(api.syncShelfCollection).toHaveBeenCalledWith(id, true));
  });

  it('takes the new collection away again if the link is refused', async () => {
    api.getShelfCollections.mockResolvedValue({ collections: [] });
    await shelfStore.load(true);
    api.createShelfCollection.mockResolvedValue({ success: true });
    api.deleteShelfCollection.mockResolvedValue({ success: true });
    api.linkShelfCollection.mockRejectedValue(new Error('Already linked'));
    await expect(shelfStore.importLinked('margin', URI, 'Reading list')).rejects.toThrow(
      'Already linked'
    );
    const id = api.createShelfCollection.mock.calls[0][0].id;
    expect(api.deleteShelfCollection).toHaveBeenCalledWith(id);
    expect(shelfStore.find(id)).toBeUndefined();
  });

  it('keeps an imported collection when only a later sync round fails', async () => {
    api.getShelfCollections.mockResolvedValue({ collections: [] });
    await shelfStore.load(true);
    api.createShelfCollection.mockResolvedValue({ success: true });
    api.linkShelfCollection.mockResolvedValue({ success: true, link: LINK, sync: null });
    api.syncShelfCollection.mockRejectedValue(new Error('network'));
    const id = await shelfStore.importLinked('margin', URI, '  ' + 'x'.repeat(150));
    expect(id).toBeTruthy();
    expect(api.deleteShelfCollection).not.toHaveBeenCalled();
    expect(shelfStore.find(id!)?.link?.uri).toBe(URI);
    expect(api.createShelfCollection.mock.calls[0][0].name).toHaveLength(100);
    await vi.waitFor(() => expect(api.syncShelfCollection).toHaveBeenCalled());
    expect(shelfStore.find(id!)?.link?.uri).toBe(URI);
  });
});
