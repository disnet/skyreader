// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// The follows-links store caches per account. These tests pin what a reader
// sees around that cache: a long-open app asks again once the answer is stale,
// a "no permission" answer isn't re-asked every navigation, a forced load
// supersedes an older one without losing the loading state to it, a new account
// never inherits the last one's permission ask, and a river card finds its link
// whatever form its URL takes.
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
  },
}));
vi.mock('./auth.svelte', () => ({ auth }));

function link(url: string, urlNormalized = url): FollowLink {
  return {
    url,
    urlNormalized,
    site: 'a.example',
    title: url,
    description: null,
    thumb: null,
    sharers: [],
    sharerCount: 0,
    firstSharedAt: 0,
    lastSharedAt: 0,
  };
}

function answer(
  links: (string | FollowLink)[],
  over: Partial<FollowLinksResponse> = {}
): FollowLinksResponse {
  return {
    scopeRequired: false,
    links: links.map((l) => (typeof l === 'string' ? link(l) : l)),
    sync: { complete: true, refreshing: false, lastPollAt: 0, error: null },
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function freshStore() {
  vi.resetModules();
  return (await import('./followLinks.svelte')).followLinksStore;
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
    // Always the week: the retention window, and what every surface shows.
    expect(getFollowLinks).toHaveBeenLastCalledWith('7d');

    vi.advanceTimersByTime(6 * 60 * 1000);
    await store.load();
    expect(getFollowLinks).toHaveBeenCalledTimes(2);
  });

  it('holds a "no permission" answer for the session, until forced', async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValue(answer([], { scopeRequired: true, sync: null }));

    await store.load();
    vi.advanceTimersByTime(60 * 60 * 1000);
    await store.load();
    expect(getFollowLinks).toHaveBeenCalledTimes(1);
    expect(store.loaded).toBe(true);

    await store.load(true);
    expect(getFollowLinks).toHaveBeenCalledTimes(2);
  });

  it('keeps loading until the latest load answers, and drops an older answer', async () => {
    const store = await freshStore();
    const first = deferred<FollowLinksResponse>();
    const second = deferred<FollowLinksResponse>();
    getFollowLinks.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstLoad = store.load();
    const secondLoad = store.load(true);

    first.resolve(answer(['https://a.example/old']));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.loading).toBe(true);
    expect(store.links).toEqual([]);

    second.resolve(answer(['https://a.example/new']));
    await secondLoad;
    expect(store.loading).toBe(false);
    expect(store.links.map((l) => l.url)).toEqual(['https://a.example/new']);
    await firstLoad;
  });

  it('resolves a superseded load only once the answer that replaced it is in', async () => {
    // Two forced loads at once (back from a grant, the app shell and /following
    // both ask): each caller must read the answer when its load resolves.
    const store = await freshStore();
    const first = deferred<FollowLinksResponse>();
    const second = deferred<FollowLinksResponse>();
    getFollowLinks.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let firstDone = false;
    const firstLoad = store.load(true).then(() => (firstDone = true));
    const secondLoad = store.load(true);

    first.resolve(answer(['https://a.example/old']));
    await vi.advanceTimersByTimeAsync(0);
    expect(firstDone).toBe(false);

    second.resolve(answer(['https://a.example/new']));
    await firstLoad;
    expect(store.loaded).toBe(true);
    expect(store.links.map((l) => l.url)).toEqual(['https://a.example/new']);
    await secondLoad;
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

  it('finds a link by the posted URL, the normalized one, or another form of either', async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValue(
      answer([link('https://a.example/post?utm_source=bsky', 'https://a.example/post')])
    );
    await store.load();

    for (const url of [
      'https://a.example/post?utm_source=bsky',
      'https://a.example/post',
      'https://A.example/post/',
      'https://a.example/post#comments',
    ]) {
      expect(store.forUrl(url)?.urlNormalized).toBe('https://a.example/post');
    }
    expect(store.forUrl('https://a.example/other')).toBeUndefined();
    expect(store.forUrl('at://did:plc:x/app.bsky.feed.post/1')).toBeUndefined();
  });
});
