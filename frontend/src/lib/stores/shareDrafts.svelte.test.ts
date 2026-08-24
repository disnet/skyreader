// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteShareDraft, ShareDraft } from '$lib/types';

// The store is where cross-device drafts actually get decided: which side of a
// concurrent edit wins, whether a tombstone from another device is obeyed, and
// whether a write that can't go out now is queued rather than dropped. All of
// that is client-side policy the backend tests can't see, so it's tested here
// against fakes for Dexie, the API, and the sync queue.

const { dbRows, metadata, api, enqueue, online, authed } = vi.hoisted(() => ({
  dbRows: new Map<string, ShareDraft>(),
  metadata: new Map<string, unknown>(),
  api: {
    getAllShareDrafts: vi.fn(),
    upsertShareDraft: vi.fn(),
    deleteShareDraft: vi.fn(),
  },
  enqueue: vi.fn(),
  online: { value: true },
  authed: { value: true },
}));

vi.mock('$app/environment', () => ({ browser: false }));

vi.mock('$lib/services/db', () => ({
  db: {
    shareDrafts: {
      toArray: async () => [...dbRows.values()],
      put: async (row: ShareDraft) => void dbRows.set(row.articleUrl, row),
      delete: async (key: string) => void dbRows.delete(key),
    },
  },
  getMetadata: async (key: string) => metadata.get(key) ?? null,
  setMetadata: async (key: string, value: unknown) => void metadata.set(key, value),
}));

vi.mock('$lib/services/api', () => ({ api }));
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue } }));
vi.mock('./sync.svelte', () => ({
  syncStore: {
    get isOnline() {
      return online.value;
    },
  },
}));
vi.mock('./auth.svelte', () => ({
  auth: {
    get isAuthenticated() {
      return authed.value;
    },
  },
}));

function draft(url: string, text: string, updatedAt: number): ShareDraft {
  return {
    articleUrl: url,
    articleTitle: 'A post',
    blocks: [{ kind: 'text', text }],
    createdAt: 1,
    updatedAt,
  };
}

function remote(d: ShareDraft, serverUpdatedAt = 100): RemoteShareDraft {
  return {
    articleUrl: d.articleUrl,
    draft: d,
    clientUpdatedAt: d.updatedAt,
    createdAt: 1,
    serverUpdatedAt,
    deletedAt: null,
  };
}

function tombstone(url: string, clientUpdatedAt: number, serverUpdatedAt = 100): RemoteShareDraft {
  return {
    articleUrl: url,
    draft: null,
    clientUpdatedAt,
    createdAt: 1,
    serverUpdatedAt,
    deletedAt: serverUpdatedAt,
  };
}

type Store = typeof import('./shareDrafts.svelte').shareDraftsStore;

async function freshStore(): Promise<Store> {
  vi.resetModules();
  const mod = await import('./shareDrafts.svelte');
  return mod.shareDraftsStore;
}

describe('shareDraftsStore', () => {
  beforeEach(() => {
    dbRows.clear();
    metadata.clear();
    vi.clearAllMocks();
    online.value = true;
    authed.value = true;
    api.getAllShareDrafts.mockResolvedValue([]);
    api.upsertShareDraft.mockResolvedValue({ success: true, articleUrl: 'x' });
    api.deleteShareDraft.mockResolvedValue({ success: true });
  });

  it('brings in a draft written on another device', async () => {
    api.getAllShareDrafts.mockResolvedValue([
      remote(draft('https://a.example/', 'elsewhere', 500)),
    ]);
    const store = await freshStore();

    await store.sync();

    expect(store.list.map((d) => d.blocks[0].text)).toEqual(['elsewhere']);
    // Cached, so the next cold start has it before the network answers.
    expect(dbRows.get('https://a.example/')?.blocks[0].text).toBe('elsewhere');
  });

  it('keeps the newer local edit and pushes it on the first full sync', async () => {
    dbRows.set('https://a.example/', draft('https://a.example/', 'mine, newer', 900));
    api.getAllShareDrafts.mockResolvedValue([remote(draft('https://a.example/', 'theirs', 500))]);
    const store = await freshStore();

    await store.sync();

    expect(store.list.map((d) => d.blocks[0].text)).toEqual(['mine, newer']);
    expect(api.upsertShareDraft).toHaveBeenCalledTimes(1);
    expect(api.upsertShareDraft.mock.calls[0][0].blocks[0].text).toBe('mine, newer');
  });

  it('uploads drafts that predate the upgrade and exist nowhere on the server', async () => {
    dbRows.set('https://a.example/', draft('https://a.example/', 'marooned', 400));
    const store = await freshStore();

    await store.sync();

    expect(api.upsertShareDraft).toHaveBeenCalledTimes(1);
    expect(api.upsertShareDraft.mock.calls[0][0].articleUrl).toBe('https://a.example/');
  });

  it('obeys a tombstone from another device', async () => {
    dbRows.set('https://a.example/', draft('https://a.example/', 'posted elsewhere', 400));
    api.getAllShareDrafts.mockResolvedValue([tombstone('https://a.example/', 800)]);
    const store = await freshStore();

    await store.sync();

    expect(store.list).toHaveLength(0);
    expect(dbRows.has('https://a.example/')).toBe(false);
  });

  it('ignores a tombstone the local edit has already outrun', async () => {
    dbRows.set('https://a.example/', draft('https://a.example/', 'still writing', 900));
    api.getAllShareDrafts.mockResolvedValue([tombstone('https://a.example/', 400)]);
    const store = await freshStore();

    await store.sync();

    expect(store.list.map((d) => d.blocks[0].text)).toEqual(['still writing']);
    // And it goes back up, so the other device stops showing it as deleted.
    expect(api.upsertShareDraft).toHaveBeenCalledTimes(1);
  });

  it('asks for a delta on the second sync and persists the cursor', async () => {
    api.getAllShareDrafts.mockResolvedValue([
      remote(draft('https://a.example/', 'one', 500), 1700),
    ]);
    const store = await freshStore();

    await store.sync();
    expect(api.getAllShareDrafts.mock.calls[0][0]).toEqual({});
    expect(metadata.get('shareDraftsCursor')).toBe(1700);

    api.getAllShareDrafts.mockResolvedValue([]);
    await store.sync();
    expect(api.getAllShareDrafts.mock.calls[1][0]).toEqual({ since: 1700 });
  });

  it('throttles the server write and flushes it on demand', async () => {
    vi.useFakeTimers();
    try {
      const store = await freshStore();
      await store.load();

      await store.save(draft('https://a.example/', 'typing', 100));
      await store.save(draft('https://a.example/', 'typing more', 200));
      // Cached immediately; only the network write waits.
      expect(dbRows.get('https://a.example/')?.blocks[0].text).toBe('typing more');
      expect(api.upsertShareDraft).not.toHaveBeenCalled();

      await store.flushServer();
      expect(api.upsertShareDraft).toHaveBeenCalledTimes(1);
      expect(api.upsertShareDraft.mock.calls[0][0].blocks[0].text).toBe('typing more');

      // The timer that was pending must not fire a second, redundant write.
      await vi.runAllTimersAsync();
      expect(api.upsertShareDraft).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues the write when offline instead of losing it', async () => {
    vi.useFakeTimers();
    try {
      online.value = false;
      const store = await freshStore();
      await store.load();

      await store.save(draft('https://a.example/', 'written on a train', 100));
      await store.flushServer();

      expect(api.upsertShareDraft).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledWith(
        'update',
        'shareDraft',
        'https://a.example/',
        expect.objectContaining({ articleUrl: 'https://a.example/' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards the pending write when the draft is removed', async () => {
    vi.useFakeTimers();
    try {
      const store = await freshStore();
      await store.load();

      await store.save(draft('https://a.example/', 'about to post this', 100));
      await store.remove('https://a.example/');

      expect(api.deleteShareDraft).toHaveBeenCalledTimes(1);
      expect(api.deleteShareDraft.mock.calls[0][0]).toBe('https://a.example/');
      await vi.runAllTimersAsync();
      expect(api.upsertShareDraft).not.toHaveBeenCalled();
      expect(store.list).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays off the network entirely when signed out', async () => {
    authed.value = false;
    const store = await freshStore();

    await store.sync();
    await store.save(draft('https://a.example/', 'dev harness', 100));
    await store.flushServer();
    await store.remove('https://a.example/');

    expect(api.getAllShareDrafts).not.toHaveBeenCalled();
    expect(api.upsertShareDraft).not.toHaveBeenCalled();
    expect(api.deleteShareDraft).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
