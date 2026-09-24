// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// The follows-links store caches per account + window. These tests pin what a
// reader sees around that cache: a long-open app asks again once the answer is
// stale, switching windows never shows the old window's links or loses the
// loading state to a slower earlier request, and a new account never inherits
// the last one's permission ask.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowLink, FollowLinksResponse } from '$lib/types';

const auth = vi.hoisted(() => ({
  user: { did: 'did:plc:me' } as { did: string } | null,
  isGuest: false,
}));
const getFollowLinks = vi.fn();
vi.mock('$lib/services/api', () => ({
  api: {
    getFollowLinks: (...a: unknown[]) => getFollowLinks(...a),
    setFollowLinkState: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('./auth.svelte', () => ({ auth }));

function link(url: string): FollowLink {
  return {
    url,
    urlNormalized: url,
    site: 'a.example',
    title: url,
    description: null,
    thumb: null,
    sharers: [],
    sharerCount: 0,
    firstSharedAt: 0,
    lastSharedAt: 0,
    opened: false,
  };
}

function answer(urls: string[], over: Partial<FollowLinksResponse> = {}): FollowLinksResponse {
  return {
    scopeRequired: false,
    links: urls.map(link),
    sync: { complete: true, refreshing: false, lastPollAt: 0, error: null },
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function freshStores() {
  vi.resetModules();
  return await import('./followLinks.svelte');
}

async function freshStore() {
  return (await freshStores()).followLinksStore;
}

beforeEach(() => {
  getFollowLinks.mockReset();
  auth.user = { did: 'did:plc:me' };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('followLinksStore', () => {
  it('reuses a fresh answer, and asks again once it goes stale', async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValue(answer(['https://a.example/1']));

    await store.load();
    await store.load();
    expect(getFollowLinks).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6 * 60 * 1000);
    await store.load();
    expect(getFollowLinks).toHaveBeenCalledTimes(2);
  });

  it("keeps loading until the current window answers, and never shows the old window's links", async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValueOnce(answer(['https://a.example/day']));
    await store.load('24h');
    expect(store.links.map((l) => l.url)).toEqual(['https://a.example/day']);

    const week = deferred<FollowLinksResponse>();
    const day = deferred<FollowLinksResponse>();
    getFollowLinks.mockReturnValueOnce(week.promise).mockReturnValueOnce(day.promise);

    const weekLoad = store.load('7d');
    expect(store.links).toEqual([]);
    const dayLoad = store.load('24h', true);

    // The Week request lands after it was superseded: dropped, and it doesn't
    // clear the loading flag the Day request still owns.
    week.resolve(answer(['https://a.example/week']));
    await weekLoad;
    expect(store.loading).toBe(true);
    expect(store.links).toEqual([]);

    day.resolve(answer(['https://a.example/day2']));
    await dayLoad;
    expect(store.loading).toBe(false);
    expect(store.window).toBe('24h');
    expect(store.links.map((l) => l.url)).toEqual(['https://a.example/day2']);
  });

  it("doesn't carry one account's permission ask or error into another's", async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValueOnce(answer([], { scopeRequired: true, sync: null }));
    await store.load();
    expect(store.scopeRequired).toBe(true);

    auth.user = { did: 'did:plc:other' };
    const other = deferred<FollowLinksResponse>();
    getFollowLinks.mockReturnValueOnce(other.promise);
    const load = store.load();
    expect(store.scopeRequired).toBe(false);
    expect(store.error).toBeNull();

    other.resolve(answer(['https://a.example/x']));
    await load;
    expect(store.links.map((l) => l.url)).toEqual(['https://a.example/x']);
  });

  it("keeps Home's lane on the week, and applies a hide to both lists", async () => {
    const { followLinksStore: page, followLinksLaneStore: lane } = await freshStores();
    getFollowLinks.mockImplementation(async (w: string) =>
      answer(
        w === '7d' ? ['https://a.example/1', 'https://a.example/old'] : ['https://a.example/1']
      )
    );

    await page.load('24h');
    await lane.load();
    expect(getFollowLinks).toHaveBeenLastCalledWith('7d');
    expect(lane.window).toBe('7d');
    expect(lane.links.map((l) => l.url)).toEqual(['https://a.example/1', 'https://a.example/old']);

    page.dismiss('https://a.example/1', 'https://a.example/1');
    expect(page.links).toEqual([]);
    expect(lane.links.map((l) => l.url)).toEqual(['https://a.example/old']);
  });
});
