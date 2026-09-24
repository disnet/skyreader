// Named `.component.test.ts` so it runs in the project that compiles runes:
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Bluesky feeds (docs/plans/BLUESKY_FEEDS_PLAN.md): the store pages feeds live
// and carries the like / repost / reply actions. These pin what a reader sees:
// a tap shows at once and is undone when Bluesky refuses it, every copy of a
// post (two feeds, a repost row) changes together, a double tap sends one
// request, and a next page never repeats a post.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BskyFeedPageResponse, BskyPost } from '$lib/types';

const auth = vi.hoisted(() => ({
  user: { did: 'did:plc:me' } as { did: string } | null,
  isGuest: false,
  grantPermissions: vi.fn(),
}));
const api = vi.hoisted(() => ({
  getBskyFeeds: vi.fn(),
  getBskyFeed: vi.fn(),
  bskyLike: vi.fn(),
  bskyUnlike: vi.fn(),
  bskyRepost: vi.fn(),
  bskyUnrepost: vi.fn(),
  bskyPost: vi.fn(),
}));
const toast = vi.hoisted(() => ({ add: vi.fn(() => 1), update: vi.fn() }));
vi.mock('$lib/services/api', () => ({ api }));
vi.mock('./auth.svelte', () => ({ auth }));
vi.mock('./toast.svelte', () => ({ toastStore: toast }));

function post(name: string, over: Partial<BskyPost> = {}): BskyPost {
  return {
    uri: `at://did:plc:a/app.bsky.feed.post/${name}`,
    cid: 'bafyreiaaaaaaaa',
    url: '',
    author: { did: 'did:plc:a', handle: 'a.test' },
    text: name,
    segments: [],
    createdAt: '',
    indexedAt: '',
    replyCount: 0,
    repostCount: 0,
    likeCount: 2,
    quoteCount: 0,
    viewer: {},
    sortAt: '',
    ...over,
  };
}

function page(posts: BskyPost[], cursor: string | null = null): BskyFeedPageResponse {
  return { posts, cursor };
}

async function freshStore() {
  vi.resetModules();
  return (await import('./bskyFeeds.svelte')).bskyFeedsStore;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.add.mockClear();
  toast.update.mockClear();
});

describe('bskyFeedsStore', () => {
  it('appends a next page without repeating a post', async () => {
    const store = await freshStore();
    api.getBskyFeed.mockResolvedValueOnce(page([post('a'), post('b')], 'c1'));
    await store.loadFeed('following');
    api.getBskyFeed.mockResolvedValueOnce(page([post('b'), post('c')], 'c2'));
    await store.loadMore('following');
    expect(api.getBskyFeed).toHaveBeenLastCalledWith('following', 'c1');
    expect(store.page('following').posts.map((p) => p.text)).toEqual(['a', 'b', 'c']);
    expect(store.page('following').cursor).toBe('c2');

    // An empty page ends the feed, whatever cursor came with it.
    api.getBskyFeed.mockResolvedValueOnce(page([], 'c3'));
    await store.loadMore('following');
    expect(store.page('following').cursor).toBeNull();
  });

  it('likes every copy of a post at once, and keeps the record uri', async () => {
    const store = await freshStore();
    api.getBskyFeed.mockResolvedValueOnce(page([post('a')]));
    await store.loadFeed('following');
    api.getBskyFeed.mockResolvedValueOnce(page([post('a')]));
    await store.loadFeed('at://did:plc:c/app.bsky.feed.generator/cats');

    let resolve!: (v: { uri: string }) => void;
    api.bskyLike.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const target = store.page('following').posts[0];
    const done = store.toggleLike(target);
    for (const uri of ['following', 'at://did:plc:c/app.bsky.feed.generator/cats']) {
      expect(store.page(uri).posts[0].likeCount).toBe(3);
    }
    // A second tap while the first is in flight sends nothing.
    await store.toggleLike(target);
    expect(api.bskyLike).toHaveBeenCalledTimes(1);

    resolve({ uri: 'at://did:plc:me/app.bsky.feed.like/1' });
    await done;
    expect(store.page('following').posts[0].viewer.like).toBe(
      'at://did:plc:me/app.bsky.feed.like/1'
    );

    api.bskyUnlike.mockResolvedValueOnce({ ok: true });
    await store.toggleLike(store.page('following').posts[0]);
    expect(api.bskyUnlike).toHaveBeenCalledWith('at://did:plc:me/app.bsky.feed.like/1');
    expect(store.page('following').posts[0].likeCount).toBe(2);
    expect(store.page('following').posts[0].viewer.like).toBeUndefined();
  });

  it('puts a like back when Bluesky refuses it, and says so', async () => {
    const store = await freshStore();
    api.getBskyFeed.mockResolvedValueOnce(page([post('a')]));
    await store.loadFeed('following');
    api.bskyLike.mockRejectedValueOnce(new Error('nope'));
    await store.toggleLike(store.page('following').posts[0]);
    expect(store.page('following').posts[0].likeCount).toBe(2);
    expect(store.page('following').posts[0].viewer.like).toBeUndefined();
    expect(toast.update).toHaveBeenCalledWith(1, 'error', expect.stringContaining('like'));
  });

  it('undoes a repost, and restores it on failure', async () => {
    const store = await freshStore();
    const reposted = post('a', {
      repostCount: 1,
      viewer: { repost: 'at://did:plc:me/app.bsky.feed.repost/1' },
    });
    api.getBskyFeed.mockResolvedValueOnce(page([reposted]));
    await store.loadFeed('following');
    api.bskyUnrepost.mockRejectedValueOnce(new Error('nope'));
    await store.toggleRepost(store.page('following').posts[0]);
    expect(store.page('following').posts[0].viewer.repost).toBe(
      'at://did:plc:me/app.bsky.feed.repost/1'
    );
    expect(store.page('following').posts[0].repostCount).toBe(1);
  });

  it('replies under the thread root and counts the reply', async () => {
    const store = await freshStore();
    const root = { uri: 'at://did:plc:r/app.bsky.feed.post/r', cid: 'bafyreiroot0000' };
    const reply = post('a', {
      replyRef: { root, parent: { uri: 'at://did:plc:a/app.bsky.feed.post/a', cid: 'x' } },
    });
    api.getBskyFeed.mockResolvedValueOnce(page([reply]));
    await store.loadFeed('following');
    api.bskyPost.mockResolvedValueOnce({ uri: 'u', cid: 'c', url: 'https://bsky.app/x' });
    const url = await store.reply(store.page('following').posts[0], 'hi');
    expect(url).toBe('https://bsky.app/x');
    expect(api.bskyPost).toHaveBeenCalledWith('hi', reply.replyRef);
    expect(store.page('following').posts[0].replyCount).toBe(1);
  });

  it('holds a "no permission" answer as the page’s state', async () => {
    const store = await freshStore();
    api.getBskyFeed.mockResolvedValueOnce({ scopeRequired: true, posts: [], cursor: null });
    await store.loadFeed('at://did:plc:c/app.bsky.feed.generator/cats');
    const p = store.page('at://did:plc:c/app.bsky.feed.generator/cats');
    expect(p.scopeRequired).toBe(true);
    expect(p.loaded).toBe(true);
  });
});
