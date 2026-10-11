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
const setFollowLinksSettings = vi.fn();
const getAllFollowLinks = vi.fn();
vi.mock('$lib/services/api', () => ({
  api: {
    getFollowLinks: (...a: unknown[]) => getFollowLinks(...a),
    setFollowLinksSettings: (...a: unknown[]) => setFollowLinksSettings(...a),
    getAllFollowLinks: (...a: unknown[]) => getAllFollowLinks(...a),
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
  setFollowLinksSettings.mockReset();
  getAllFollowLinks.mockReset();
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

  it('pages every link for the river once switched on, leaving the ranked list alone', async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValue(answer(['https://a.example/top']));
    await store.load();
    expect(store.allLinks).toBe(false);
    expect(store.riverLinks.map((l) => l.url)).toEqual(['https://a.example/top']);

    setFollowLinksSettings.mockResolvedValueOnce({ ok: true });
    getFollowLinks.mockResolvedValue(answer(['https://a.example/top'], { allLinks: true }));
    getAllFollowLinks.mockResolvedValueOnce({
      scopeRequired: false,
      links: [link('https://a.example/new'), link('https://a.example/top')],
      nextCursor: 'c1',
    });
    await store.setAllLinks(true);
    expect(setFollowLinksSettings).toHaveBeenCalledWith({ allLinks: true });
    expect(store.allLinks).toBe(true);
    // Home's list stays the ranked one; the river gets every link.
    expect(store.links.map((l) => l.url)).toEqual(['https://a.example/top']);
    expect(store.riverLinks.map((l) => l.url)).toEqual([
      'https://a.example/new',
      'https://a.example/top',
    ]);
    expect(store.moreRiverLinks).toBe(true);
    // A link only in the paged list still marks its article's river card.
    expect(store.forUrl('https://a.example/new')?.url).toBe('https://a.example/new');

    getAllFollowLinks.mockResolvedValueOnce({
      scopeRequired: false,
      links: [link('https://a.example/top'), link('https://a.example/old')],
      nextCursor: null,
    });
    await store.loadMoreLinks();
    expect(getAllFollowLinks).toHaveBeenLastCalledWith('c1', undefined);
    expect(store.riverLinks.map((l) => l.url)).toEqual([
      'https://a.example/new',
      'https://a.example/top',
      'https://a.example/old',
    ]);
    expect(store.moreRiverLinks).toBe(false);

    setFollowLinksSettings.mockRejectedValueOnce(new Error('offline'));
    await expect(store.setAllLinks(false)).rejects.toThrow('offline');
    expect(store.allLinks).toBe(true);
    expect(store.riverLinks).toHaveLength(3);
  });

  it('re-reads a river scrolled deep down to its depth when a refresh brings a new first page', async () => {
    const store = await freshStore();
    const at = (url: string, t: number) => ({ ...link(url), firstSharedAt: t });
    const page = (links: FollowLink[], nextCursor: string | null) => ({
      scopeRequired: false,
      links,
      nextCursor,
    });
    getFollowLinks.mockResolvedValue(answer([], { allLinks: true }));
    getAllFollowLinks.mockResolvedValueOnce(page([at('https://a.example/3', 3)], 'c1'));
    await store.load();
    // First page, unknown to want every link: asked for after the ranked answer.
    expect(store.riverLinks.map((l) => l.url)).toEqual(['https://a.example/3']);
    getAllFollowLinks.mockResolvedValueOnce(
      page([at('https://a.example/2', 2), at('https://a.example/1', 1)], 'c2')
    );
    await store.loadMoreLinks();

    // The refresh found a link shared at 2.5 (a backdated post), between the
    // first page and the depth already loaded: it isn't skipped.
    getAllFollowLinks
      .mockResolvedValueOnce(page([at('https://a.example/4', 4)], 'fresh'))
      .mockResolvedValueOnce(
        page([at('https://a.example/3', 3), at('https://a.example/2.5', 2.5)], 'fresh2')
      )
      .mockResolvedValueOnce(
        page([at('https://a.example/2', 2), at('https://a.example/1', 1)], 'fresh3')
      );
    await store.load(true);
    expect(getAllFollowLinks).toHaveBeenNthCalledWith(4, 'fresh', 100);
    expect(getAllFollowLinks).toHaveBeenNthCalledWith(5, 'fresh2', 100);
    expect(store.riverLinks.map((l) => l.url)).toEqual([
      'https://a.example/4',
      'https://a.example/3',
      'https://a.example/2.5',
      'https://a.example/2',
      'https://a.example/1',
    ]);
    // Continues from where the re-read left off.
    getAllFollowLinks.mockResolvedValueOnce(page([], null));
    expect(await store.loadEveryLink()).toBe(true);
    expect(getAllFollowLinks).toHaveBeenLastCalledWith('fresh3', 100);
    expect(store.moreRiverLinks).toBe(false);
  });

  it('keeps what a refresh re-read when a page of it fails, and pages on from there', async () => {
    const store = await freshStore();
    const at = (url: string, t: number) => ({ ...link(url), firstSharedAt: t });
    getFollowLinks.mockResolvedValue(answer([], { allLinks: true }));
    getAllFollowLinks
      .mockResolvedValueOnce({
        scopeRequired: false,
        links: [at('https://a.example/3', 3)],
        nextCursor: 'c1',
      })
      .mockResolvedValueOnce({
        scopeRequired: false,
        links: [at('https://a.example/2', 2), at('https://a.example/1', 1)],
        nextCursor: 'c2',
      });
    await store.load();
    await store.loadMoreLinks();

    getAllFollowLinks
      .mockResolvedValueOnce({
        scopeRequired: false,
        links: [at('https://a.example/4', 4)],
        nextCursor: 'fresh',
      })
      .mockRejectedValueOnce(new Error('offline'));
    await store.load(true);
    expect(store.riverLinks.map((l) => l.url)).toEqual(['https://a.example/4']);
    expect(store.moreRiverLinks).toBe(true);
    getAllFollowLinks.mockResolvedValueOnce({ scopeRequired: false, links: [], nextCursor: null });
    await store.loadMoreLinks();
    expect(getAllFollowLinks).toHaveBeenLastCalledWith('fresh', undefined);
  });

  it('backs off after a page fails, reading as still loading, then asks again', async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValue(answer([], { allLinks: true }));
    getAllFollowLinks.mockResolvedValueOnce({
      scopeRequired: false,
      links: [link('https://a.example/1')],
      nextCursor: 'c1',
    });
    await store.load();

    getAllFollowLinks.mockRejectedValueOnce(new Error('offline'));
    await store.loadMoreLinks();
    expect(getAllFollowLinks).toHaveBeenCalledTimes(2);
    // The sentinel would ask again at once; it's held off, and stays "loading".
    expect(store.loadingMore).toBe(true);
    await store.loadMoreLinks();
    expect(getAllFollowLinks).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(store.loadingMore).toBe(false);
    getAllFollowLinks.mockRejectedValueOnce(new Error('offline'));
    await store.loadMoreLinks();
    expect(getAllFollowLinks).toHaveBeenCalledTimes(3);
    // Doubled.
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.loadingMore).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.loadingMore).toBe(false);
  });

  it('retries a failed page while loading every link, and says when it gave up', async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValue(answer([], { allLinks: true }));
    getAllFollowLinks.mockResolvedValueOnce({
      scopeRequired: false,
      links: [link('https://a.example/1')],
      nextCursor: 'c1',
    });
    await store.load();

    getAllFollowLinks.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      scopeRequired: false,
      links: [link('https://a.example/2')],
      nextCursor: null,
    });
    const every = store.loadEveryLink();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await every).toBe(true);
    expect(store.riverLinks.map((l) => l.url)).toEqual([
      'https://a.example/1',
      'https://a.example/2',
    ]);

    // Out of patience: resolves false, the cursor kept for later.
    getAllFollowLinks.mockResolvedValueOnce({
      scopeRequired: false,
      links: [link('https://a.example/0')],
      nextCursor: 'c9',
    });
    await store.load(true);
    getAllFollowLinks.mockRejectedValue(new Error('offline'));
    const gaveUp = store.loadEveryLink(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await gaveUp).toBe(false);
    expect(store.moreRiverLinks).toBe(true);
  });

  it('ignores the setting in an answer asked for before it changed', async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValueOnce(answer([]));
    await store.load();

    // A refresh in flight when the reader checks the box answers the old value.
    const stale = deferred<FollowLinksResponse>();
    getFollowLinks.mockReturnValueOnce(stale.promise);
    const inFlight = store.load(true);
    const saved = deferred<{ ok: boolean }>();
    setFollowLinksSettings.mockReturnValueOnce(saved.promise);
    const toggled = store.setAllLinks(true);
    stale.resolve(answer([], { allLinks: false }));
    await inFlight;
    expect(store.allLinks).toBe(true);

    getFollowLinks.mockResolvedValue(answer([], { allLinks: true }));
    getAllFollowLinks.mockResolvedValue({ scopeRequired: false, links: [], nextCursor: null });
    saved.resolve({ ok: true });
    await toggled;
    expect(store.allLinks).toBe(true);
  });

  it('keeps a setting through an answer asked for while it was saving', async () => {
    const store = await freshStore();
    getFollowLinks.mockResolvedValueOnce(answer([], { inEverything: false }));
    await store.load();

    const saved = deferred<{ ok: boolean }>();
    setFollowLinksSettings.mockReturnValueOnce(saved.promise);
    const toggled = store.setInEverything(true);
    // A load that starts (and answers) while the save is in flight reads the old value.
    getFollowLinks.mockResolvedValueOnce(answer([], { inEverything: false }));
    await store.load(true);
    expect(store.inEverything).toBe(true);

    // One asked for during the save, answered after it.
    const late = deferred<FollowLinksResponse>();
    getFollowLinks.mockReturnValueOnce(late.promise);
    const inFlight = store.load(true);
    saved.resolve({ ok: true });
    await toggled;
    late.resolve(answer([], { inEverything: false }));
    await inFlight;
    expect(store.inEverything).toBe(true);
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
