// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Adding a source is account-only. A guest's library is exactly the curated
// starter channels, which ride the crawl set; anything else would be a feed no
// account subscribes to and nothing keeps current. The UI routes a guest to
// sign-in before any of this, so these tests pin the store's own backstop: the
// one path that may write for a guest is the starter seed, and it may only
// write locally.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subscription } from '$lib/types';

const rows: Subscription[] = [];
let nextId = 1;

const liveDb = {
  subscriptionsVersion: 0,
  get subscriptions() {
    return rows;
  },
  loadSubscriptions: vi.fn(async () => {}),
  addSubscription: vi.fn(async (sub: Omit<Subscription, 'id'>) => {
    const id = nextId++;
    rows.push({ ...sub, id } as Subscription);
    return id;
  }),
  getSubscriptionById: (id: number) => rows.find((r) => r.id === id),
  getSubscriptionByRkey: (rkey: string) => rows.find((r) => r.rkey === rkey),
  getSubscriptionByUrl: (url: string) => rows.find((r) => r.feedUrl === url),
  updateSubscription: vi.fn(async () => {}),
  updateSubscriptionLocal: vi.fn(async () => {}),
  deleteSubscription: vi.fn(async () => {}),
  clearAllSubscriptions: vi.fn(async () => {}),
};
vi.mock('$lib/services/liveDb.svelte', () => ({ liveDb }));

const api = {
  createSubscription: vi.fn(async ({ rkey }: { rkey: string }) => ({ rkey })),
  bulkCreateSubscriptions: vi.fn(async () => ({ parked: [], skipped: [], dropped: [] })),
  deleteSubscription: vi.fn(async () => {}),
  bulkDeleteSubscriptions: vi.fn(async () => {}),
  updateSubscription: vi.fn(async () => {}),
  bulkUpdateSubscriptions: vi.fn(async () => {}),
};
class SubscriptionLimitError extends Error {}
class RateLimitError extends Error {
  constructor(public retryAfter: number) {
    super('Rate limit exceeded');
  }
}
vi.mock('$lib/services/api', () => ({ api, SubscriptionLimitError, RateLimitError }));

vi.mock('./feedStatus.svelte', () => ({
  feedStatusStore: { clearStatus: vi.fn(), clearAll: vi.fn() },
}));

const authState = { isGuest: true };
vi.mock('./auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
    user: { limits: { maxSubscriptions: 100 } },
  },
}));

const { subscriptionsStore, GuestAddBlockedError } = await import('./subscriptions.svelte');

const FEED = { feedUrl: 'https://example.com/feed.xml', title: 'Example' };

describe('adding a subscription is account-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0;
    nextId = 1;
    authState.isGuest = true;
  });

  it('add() refuses for a guest, before it can reach the backend', async () => {
    await expect(subscriptionsStore.add(FEED.feedUrl, FEED.title, {})).rejects.toBeInstanceOf(
      GuestAddBlockedError
    );
    expect(api.createSubscription).not.toHaveBeenCalled();
    expect(liveDb.addSubscription).not.toHaveBeenCalled();
  });

  it('add() reaches the backend for an account', async () => {
    authState.isGuest = false;
    await subscriptionsStore.add(FEED.feedUrl, FEED.title, {});
    expect(api.createSubscription).toHaveBeenCalledTimes(1);
    expect(liveDb.addSubscription).toHaveBeenCalledTimes(1);
  });

  it('addBulk() refuses a guest OPML import without writing anything', async () => {
    const result = await subscriptionsStore.addBulk([FEED], undefined, { source: 'opml' });
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ url: FEED.feedUrl, error: 'Sign in to add feeds.' }]);
    expect(api.bulkCreateSubscriptions).not.toHaveBeenCalled();
    expect(liveDb.addSubscription).not.toHaveBeenCalled();
  });

  it('addBulk() seeds the starter channels locally and only locally', async () => {
    const result = await subscriptionsStore.addBulk([FEED], undefined, { starterSeed: true });
    expect(result.added).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(result.dropped).toBe(0);
    expect(api.bulkCreateSubscriptions).not.toHaveBeenCalled();
    expect(liveDb.addSubscription).toHaveBeenCalledTimes(1);
  });

  it('addBulk() syncs to the backend for an account', async () => {
    authState.isGuest = false;
    await subscriptionsStore.addBulk([FEED], undefined, { source: 'opml' });
    expect(api.bulkCreateSubscriptions).toHaveBeenCalledTimes(1);
  });
});

describe('a large OPML import', () => {
  const feeds = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      feedUrl: `https://example.com/${i}.xml`,
      title: `${i}`,
    }));

  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0;
    nextId = 1;
    authState.isGuest = false;
  });

  it('goes to the backend 200 feeds at a time', async () => {
    const result = await subscriptionsStore.addBulk(feeds(450), undefined, { source: 'opml' });
    const sizes = api.bulkCreateSubscriptions.mock.calls.map(
      (call) => (call as unknown as [unknown[]])[0].length
    );
    expect(sizes).toEqual([200, 200, 50]);
    expect(result.added).toHaveLength(450);
  });

  it('keeps the batches the backend took when a later one fails', async () => {
    api.bulkCreateSubscriptions
      .mockResolvedValueOnce({ parked: [], skipped: [], dropped: [] })
      .mockRejectedValueOnce(new Error('HTTP 500'));
    const result = await subscriptionsStore.addBulk(feeds(450), undefined, { source: 'opml' });
    expect(api.bulkCreateSubscriptions).toHaveBeenCalledTimes(2);
    expect(result.added).toHaveLength(200);
    expect(result.failed).toHaveLength(250);
    expect(result.failed[0].error).toBe('HTTP 500');
  });

  it('waits out a refused batch and carries on', async () => {
    vi.useFakeTimers();
    try {
      api.bulkCreateSubscriptions.mockRejectedValueOnce(new RateLimitError(10));
      const pending = subscriptionsStore.addBulk(feeds(3), undefined, { source: 'opml' });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(api.bulkCreateSubscriptions).toHaveBeenCalledTimes(2);
      expect(result.added).toHaveLength(3);
      expect(result.failed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a feed kept off the PDS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0;
    nextId = 1;
    authState.isGuest = false;
  });

  it('sends "Sync it publicly" as an explicit false', async () => {
    await subscriptionsStore.add(FEED.feedUrl, FEED.title, { keepPrivate: false });

    expect(api.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ keepPrivate: false })
    );
  });

  it('caches what the server decided, not what was asked', async () => {
    api.createSubscription.mockResolvedValueOnce({ rkey: 'r1', keepPrivate: true } as never);

    const id = await subscriptionsStore.add(FEED.feedUrl, FEED.title, {});

    expect(rows.find((r) => r.id === id)?.keepPrivate).toBe(true);
  });

  it('keeps the choice through the delete-and-recreate update', async () => {
    api.createSubscription.mockResolvedValueOnce({ rkey: 'r1', keepPrivate: true } as never);
    const id = await subscriptionsStore.add(FEED.feedUrl, FEED.title, { keepPrivate: true });

    await subscriptionsStore.update(id, { title: 'Members' });

    expect(api.createSubscription).toHaveBeenLastCalledWith(
      expect.objectContaining({ keepPrivate: true })
    );
  });
});

describe('a re-import filling in folders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0;
    nextId = 1;
    authState.isGuest = false;
  });

  function follow(feedUrl: string, rkey: string, category?: string) {
    rows.push({
      id: nextId++,
      rkey,
      feedUrl,
      title: rkey,
      category,
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      localUpdatedAt: 0,
    } as Subscription);
  }

  it('puts folderless feeds into the file’s folders, one request per folder', async () => {
    follow('https://a.example/feed', 'ra');
    follow('https://b.example/feed', 'rb');
    follow('https://c.example/feed', 'rc');

    const filled = await subscriptionsStore.fillMissingFolders([
      { feedUrl: 'https://A.example/feed', category: ' Tech ' },
      { feedUrl: 'https://b.example/feed', category: 'Tech' },
      { feedUrl: 'https://c.example/feed', category: 'News' },
    ]);

    expect(filled).toBe(3);
    expect(api.bulkUpdateSubscriptions).toHaveBeenCalledTimes(2);
    expect(api.bulkUpdateSubscriptions).toHaveBeenCalledWith(['ra', 'rb'], { category: 'Tech' });
    expect(api.bulkUpdateSubscriptions).toHaveBeenCalledWith(['rc'], { category: 'News' });
  });

  it('never moves a feed out of a folder the reader chose', async () => {
    follow('https://a.example/feed', 'ra', 'Reading');

    const filled = await subscriptionsStore.fillMissingFolders([
      { feedUrl: 'https://a.example/feed', category: 'Tech' },
    ]);

    expect(filled).toBe(0);
    expect(api.bulkUpdateSubscriptions).not.toHaveBeenCalled();
  });

  it('sends a big folder 50 feeds at a time', async () => {
    const feeds = Array.from({ length: 120 }, (_, i) => {
      follow(`https://f${i}.example/feed`, `r${i}`);
      return { feedUrl: `https://f${i}.example/feed`, category: 'Blogs' };
    });

    expect(await subscriptionsStore.fillMissingFolders(feeds)).toBe(120);
    const sizes = api.bulkUpdateSubscriptions.mock.calls.map(
      (call) => (call as unknown as [string[]])[0].length
    );
    expect(sizes).toEqual([50, 50, 20]);
  });

  it('leaves a folder unset, and uncounted, when the server refuses it', async () => {
    follow('https://a.example/feed', 'ra');
    api.bulkUpdateSubscriptions.mockRejectedValueOnce(new Error('HTTP 500'));

    const filled = await subscriptionsStore.fillMissingFolders([
      { feedUrl: 'https://a.example/feed', category: 'Tech' },
    ]);

    expect(filled).toBe(0);
    expect(liveDb.updateSubscriptionLocal).not.toHaveBeenCalled();
  });

  it('reuses the spelling of a folder the reader already has', async () => {
    follow('https://a.example/feed', 'ra', 'tech');
    follow('https://b.example/feed', 'rb');

    expect(
      subscriptionsStore.folderlessMatches([
        { feedUrl: 'https://b.example/feed', category: 'Tech' },
      ])
    ).toEqual([{ id: 2, category: 'tech' }]);
  });

  it('ignores feeds not yet followed, and entries with no folder', async () => {
    follow('https://a.example/feed', 'ra');

    expect(
      subscriptionsStore.folderlessMatches([
        { feedUrl: 'https://a.example/feed' },
        { feedUrl: 'https://a.example/feed', category: '  ' },
        { feedUrl: 'https://new.example/feed', category: 'Tech' },
      ])
    ).toEqual([]);
  });
});
