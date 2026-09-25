import { api } from '$lib/services/api';
import { auth } from './auth.svelte';
import { toastStore } from './toast.svelte';
import type { BskyAccess, BskyFeedSource, BskyPost } from '$lib/types';

// Bluesky feeds as sources (docs/plans/BLUESKY_FEEDS_PLAN.md): the feeds a
// reader added (the Following timeline, or a custom feed saved in Bluesky), the
// pages of each read so far, and the like / repost / reply actions on a post.
//
// Posts are read live and kept only in memory: a feed is Bluesky's, ordered by
// Bluesky, and pages by cursor. Nothing here is read state; a post has none.

/** How long a loaded first page is reused before a visit asks again. */
const STALE_MS = 2 * 60 * 1000;

interface FeedPage {
  posts: BskyPost[];
  cursor: string | null;
  loading: boolean;
  loaded: boolean;
  scopeRequired: boolean;
  error: string | null;
  loadedAt: number;
}

/** A post's row key: a repost is its own row, so the reposter is part of it. */
export function bskyPostKey(post: BskyPost): string {
  return `bsky:${post.uri}#${post.repostedBy?.did ?? ''}`;
}

function emptyPage(): FeedPage {
  return {
    posts: [],
    cursor: null,
    loading: false,
    loaded: false,
    scopeRequired: false,
    error: null,
    loadedAt: 0,
  };
}

function createBskyFeedsStore() {
  let access = $state<BskyAccess | null>(null);
  let feeds = $state<BskyFeedSource[]>([]);
  let loaded = $state(false);
  let pages = $state<Record<string, FeedPage>>({});
  let loadedDid: string | null = null;
  let listLoad: Promise<void> | null = null;
  /** Bumped per page load of a feed; an answer from an older one is dropped. */
  const seq: Record<string, number> = {};
  /** Posts with an action in flight, so a double tap can't send two. */
  let pending = $state<Record<string, true>>({});

  function reset(did: string | null) {
    access = null;
    feeds = [];
    loaded = false;
    pages = {};
    pending = {};
    loadedDid = did;
    listLoad = null;
  }

  /** Load the reader's Bluesky sources and permissions, once per account. */
  async function load(force = false): Promise<void> {
    const user = auth.user;
    if (!user || auth.isGuest) return;
    if (loadedDid !== user.did) reset(user.did);
    if (listLoad && !force) return listLoad;
    const did = user.did;
    listLoad = (async () => {
      try {
        const res = await api.getBskyFeeds();
        if (auth.user?.did !== did) return;
        access = res.access;
        feeds = res.feeds;
        loaded = true;
      } catch (err) {
        listLoad = null;
        throw err;
      }
    })();
    return listLoad;
  }

  function page(uri: string): FeedPage {
    return pages[uri] ?? emptyPage();
  }

  async function fetchPage(uri: string, more: boolean): Promise<void> {
    const did = auth.user?.did;
    if (!did || auth.isGuest) return;
    if (!pages[uri]) pages[uri] = emptyPage();
    const current = pages[uri];
    if (more && (!current.cursor || current.loading)) return;
    const token = (seq[uri] = (seq[uri] ?? 0) + 1);
    current.loading = true;
    current.error = null;
    try {
      const res = await api.getBskyFeed(uri, more ? current.cursor : null);
      if (token !== seq[uri] || auth.user?.did !== did) return;
      const target = pages[uri];
      target.scopeRequired = !!res.scopeRequired;
      if (more) {
        const seen = new Set(target.posts.map(bskyPostKey));
        target.posts = [...target.posts, ...res.posts.filter((p) => !seen.has(bskyPostKey(p)))];
      } else {
        target.posts = res.posts;
        target.loadedAt = Date.now();
      }
      target.cursor = res.posts.length ? res.cursor : null;
      target.loaded = true;
    } catch (err) {
      if (token !== seq[uri]) return;
      pages[uri].error = err instanceof Error ? err.message : 'Could not load';
      pages[uri].loaded = true;
    } finally {
      if (token === seq[uri] && pages[uri]) pages[uri].loading = false;
    }
  }

  /** The feed's first page, unless one loaded recently (or `force`). */
  async function loadFeed(uri: string, force = false): Promise<void> {
    const p = pages[uri];
    if (!force && p?.loaded && !p.error && Date.now() - p.loadedAt < STALE_MS) return;
    if (!force && p?.loading) return;
    await fetchPage(uri, false);
  }

  /** The next page of a feed. */
  async function loadMore(uri: string): Promise<void> {
    await fetchPage(uri, true);
  }

  /** Apply a change to every copy of a post across loaded feeds. */
  function patchPost(uri: string, fn: (p: BskyPost) => void) {
    for (const p of Object.values(pages)) {
      for (const post of p.posts) {
        if (post.uri === uri) fn(post);
      }
    }
  }

  async function withPending(uri: string, run: () => Promise<void>): Promise<void> {
    if (pending[uri]) return;
    pending[uri] = true;
    try {
      await run();
    } finally {
      delete pending[uri];
    }
  }

  function failed(what: string, err: unknown) {
    // A missing permission raises the app's own "allow access" banner.
    if ((err as { name?: string })?.name === 'ScopeUpgradeError') return;
    console.error(`Bluesky ${what} failed:`, err);
    toastStore.update(toastStore.add(''), 'error', `Couldn't ${what} on Bluesky. Try again.`);
  }

  /** Like the post, or take the like back. Applied at once, undone on failure. */
  async function toggleLike(post: BskyPost): Promise<void> {
    await withPending(`like:${post.uri}`, async () => {
      const prior = post.viewer.like;
      if (prior) {
        patchPost(post.uri, (p) => {
          p.viewer.like = undefined;
          p.likeCount = Math.max(0, p.likeCount - 1);
        });
        try {
          await api.bskyUnlike(prior);
        } catch (err) {
          patchPost(post.uri, (p) => {
            p.viewer.like = prior;
            p.likeCount++;
          });
          failed('remove the like', err);
        }
        return;
      }
      patchPost(post.uri, (p) => {
        p.viewer.like = 'pending';
        p.likeCount++;
      });
      try {
        const { uri } = await api.bskyLike({ uri: post.uri, cid: post.cid });
        patchPost(post.uri, (p) => (p.viewer.like = uri));
      } catch (err) {
        patchPost(post.uri, (p) => {
          p.viewer.like = undefined;
          p.likeCount = Math.max(0, p.likeCount - 1);
        });
        failed('like it', err);
      }
    });
  }

  /** Repost, or undo the repost. */
  async function toggleRepost(post: BskyPost): Promise<void> {
    await withPending(`repost:${post.uri}`, async () => {
      const prior = post.viewer.repost;
      if (prior) {
        patchPost(post.uri, (p) => {
          p.viewer.repost = undefined;
          p.repostCount = Math.max(0, p.repostCount - 1);
        });
        try {
          await api.bskyUnrepost(prior);
        } catch (err) {
          patchPost(post.uri, (p) => {
            p.viewer.repost = prior;
            p.repostCount++;
          });
          failed('undo the repost', err);
        }
        return;
      }
      patchPost(post.uri, (p) => {
        p.viewer.repost = 'pending';
        p.repostCount++;
      });
      try {
        const { uri } = await api.bskyRepost({ uri: post.uri, cid: post.cid });
        patchPost(post.uri, (p) => (p.viewer.repost = uri));
      } catch (err) {
        patchPost(post.uri, (p) => {
          p.viewer.repost = undefined;
          p.repostCount = Math.max(0, p.repostCount - 1);
        });
        failed('repost it', err);
      }
    });
  }

  /** Reply to the post. Resolves with the reply's bsky.app link; throws on failure. */
  async function reply(post: BskyPost, text: string): Promise<string> {
    const ref = post.replyRef ?? {
      root: { uri: post.uri, cid: post.cid },
      parent: { uri: post.uri, cid: post.cid },
    };
    const res = await api.bskyPost(text, ref);
    patchPost(post.uri, (p) => p.replyCount++);
    return res.url;
  }

  /** Add a feed as a source. Resolves with the source (its name from Bluesky). */
  async function add(uri: string): Promise<BskyFeedSource> {
    await load();
    const existing = feeds.find((f) => f.uri === uri);
    if (existing) return existing;
    const { feed } = await api.addBskyFeed(uri);
    if (!feeds.some((f) => f.uri === feed.uri)) feeds = [...feeds, feed];
    return feed;
  }

  async function remove(uri: string): Promise<void> {
    const prior = feeds;
    feeds = feeds.filter((f) => f.uri !== uri);
    try {
      await api.removeBskyFeed(uri);
    } catch (err) {
      feeds = prior;
      throw err;
    }
  }

  function feed(uri: string): BskyFeedSource | undefined {
    return feeds.find((f) => f.uri === uri);
  }

  /** Ask for the like / repost / reply permission, coming back to this page. */
  function requestWrite(): void {
    void auth.grantPermissions(['blueskyWrite']);
  }

  /** A toast offering the write permission, for an action taken without it
   *  (a keyboard shortcut; the card asks inline). */
  function askWrite(): void {
    const id = toastStore.add('');
    toastStore.update(id, 'error', 'Liking and replying on Bluesky needs your permission', {
      label: 'Allow',
      run: requestWrite,
    });
  }

  /** Ask for reading custom feeds (and the saved-feed list). */
  function requestRead(returnUrl?: string): void {
    void auth.grantPermissions(['bluesky'], returnUrl);
  }

  return {
    get access() {
      return access;
    },
    get feeds() {
      return feeds;
    },
    get loaded() {
      return loaded;
    },
    get canWrite() {
      return access?.write === true;
    },
    /** Whether the session may read this feed. Unknown (null) until loaded. */
    canRead(uri: string): boolean | null {
      if (!access) return null;
      return uri === 'following' ? access.timeline : access.feeds;
    },
    isPending(action: 'like' | 'repost', uri: string): boolean {
      return !!pending[`${action}:${uri}`];
    },
    page,
    feed,
    load,
    loadFeed,
    loadMore,
    toggleLike,
    toggleRepost,
    reply,
    add,
    remove,
    requestWrite,
    askWrite,
    requestRead,
  };
}

export const bskyFeedsStore = createBskyFeedsStore();
