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
vi.mock('$lib/services/api', () => ({ api, SubscriptionLimitError }));

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
