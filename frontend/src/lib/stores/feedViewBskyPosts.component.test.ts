// Named `.component.test.ts` so it runs in the project that compiles runes:
// feedView is a `.svelte.ts` module and its derivations need the Svelte plugin.
//
// Bluesky feeds as sources (docs/plans/BLUESKY_FEEDS_PLAN.md): a channel that
// names a feed gets its posts as river rows. These pin the rules that keep
// that calm: a feed is never part of "All sources", a feed on its own keeps
// Bluesky's order (a custom feed is ranked, not chronological) and pages by
// cursor, and mixed with anything its posts sort by time.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, BskyPost, FilteredView } from '$lib/types';
import {
  bskyRiver,
  emptyPage,
  resetBskyRiver,
} from '../../../test/stubs/bsky-river-fixtures.svelte';

vi.mock('./filteredViews.svelte', () => ({
  filteredViewsStore: {
    get views() {
      return bskyRiver.channels;
    },
    getById: (id: number) => bskyRiver.channels.find((v) => v.id === id),
    getByUuid: (uuid: string) => bskyRiver.channels.find((v) => v.uuid === uuid),
    update: () => {},
  },
}));
vi.mock('./bskyFeeds.svelte', () => ({
  bskyPostKey: (p: BskyPost) => `bsky:${p.uri}#${p.repostedBy?.did ?? ''}`,
  bskyFeedsStore: {
    page: (uri: string) => bskyRiver.pages[uri] ?? emptyPage(),
    loadMore: async (uri: string) => {
      bskyRiver.loadMoreCalls = [...bskyRiver.loadMoreCalls, uri];
    },
  },
}));
vi.mock('./followLinks.svelte', () => ({
  followLinksStore: { links: [], inEverything: null },
}));
vi.mock('./articles.svelte', () => ({
  articlesStore: {
    get allArticles() {
      return bskyRiver.articles;
    },
  },
}));
vi.mock('./social.svelte', () => ({ socialStore: { documents: [], isLoading: false } }));
vi.mock('./myLinkblog.svelte', () => ({ myLinkblogStore: { documents: [] } }));
vi.mock('./saves.svelte', () => ({
  savesStore: { articles: [], find: () => undefined, getByUrl: () => undefined },
}));
vi.mock('./subscriptions.svelte', () => ({
  subscriptionsStore: {
    subscriptions: [{ id: 1, rkey: 'feedaaaaaaaaa', title: 'A feed' }],
    getById: () => undefined,
    getByRkey: (rkey: string) => (rkey === 'feedaaaaaaaaa' ? { id: 1, rkey } : undefined),
  },
}));
vi.mock('./itemLabels.svelte', () => ({
  itemLabelsStore: {
    isSaved: () => false,
    isArchived: () => false,
    isRead: () => false,
    isSocialRead: () => false,
    itemHasAnyTag: () => true,
    get tagsByItem() {
      return {};
    },
    markAsRead: () => {},
    markSocialAsRead: () => {},
  },
}));
vi.mock('./savedSearch.svelte', () => ({
  savedSearchStore: { terms: [], bodyMatchTerms: [], active: false, reset: () => {} },
}));
vi.mock('./preferences.svelte', () => ({
  preferences: { sortOrder: 'newest', toggleSortOrder: () => {} },
}));
vi.mock('$lib/services/liveDb.svelte', () => ({
  liveDb: { articlesVersion: 0, getArticleBodies: async () => new Map() },
}));
vi.mock('$lib/utils/roomArticle', () => ({ extractArticle: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: {} }));

const { feedViewStore } = await import('./feedView.svelte');
const { bskyFeedSourceKey } = await import('$lib/utils/sourceKeys');

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const FOLLOWING = 'following';
const CATS = 'at://did:plc:creator/app.bsky.feed.generator/cats';

function post(name: string, hoursAgo: number, over: Partial<BskyPost> = {}): BskyPost {
  const at = new Date(NOW - hoursAgo * HOUR).toISOString();
  return {
    uri: `at://did:plc:a/app.bsky.feed.post/${name}`,
    cid: 'bafyreiaaaaaaaa',
    url: `https://bsky.app/profile/a.test/post/${name}`,
    author: { did: 'did:plc:a', handle: 'a.test' },
    text: name,
    segments: [{ text: name }],
    createdAt: at,
    indexedAt: at,
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    quoteCount: 0,
    viewer: {},
    sortAt: at,
    ...over,
  };
}

function feedPage(uri: string, posts: BskyPost[], cursor: string | null = null) {
  bskyRiver.pages = { ...bskyRiver.pages, [uri]: { ...emptyPage(), posts, cursor, loaded: true } };
}

function article(path: string, hoursAgo: number): Article {
  return {
    subscriptionId: 1,
    guid: `guid-${path}`,
    url: `https://site.example/${path}/`,
    title: path,
    publishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    fetchedAt: NOW,
  };
}

let nextId = 1;
function channel(sourceKeys: string[], over: Partial<FilteredView> = {}): FilteredView {
  const id = nextId++;
  const view = {
    id,
    uuid: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    name: 'Channel',
    position: id,
    createdAt: 1,
    updatedAt: 1,
    mode: 'feed',
    sourceMode: 'include',
    sourceKeys,
    readFilter: 'unread',
    sortOrder: 'newest',
    ...over,
  } as FilteredView;
  bskyRiver.channels = [...bskyRiver.channels, view];
  return view;
}

function show(view: FilteredView | null) {
  feedViewStore.setFilters({
    feed: null,
    saved: null,
    sharer: null,
    following: null,
    feeds: null,
    view: view?.uuid ?? null,
  });
}

function rows() {
  return feedViewStore.currentItems.map((i) =>
    i.type === 'post' ? `post:${i.item.text}` : `${i.type}:${'title' in i.item ? i.item.title : ''}`
  );
}

describe('Bluesky posts in the river', () => {
  beforeEach(() => {
    resetBskyRiver();
    feedViewStore.resetSelection();
    feedViewStore.setFilters({
      feed: null,
      saved: 'true',
      sharer: null,
      following: null,
      feeds: null,
    });
  });

  it('leaves them out of Everything', () => {
    feedPage(FOLLOWING, [post('p', 1)]);
    bskyRiver.articles = [article('x', 2)];
    show(null);
    expect(rows()).toEqual(['article:x']);
    expect(feedViewStore.shownBskyFeedUris).toEqual([]);
  });

  it('keeps a feed on its own in the feed’s order, unread filter or not', () => {
    // A ranked feed: the second post is newer but Bluesky put it second.
    feedPage(CATS, [post('first', 5), post('second', 1)]);
    show(channel([bskyFeedSourceKey(CATS)]));
    expect(feedViewStore.bskyFeedOnly).toBe(true);
    expect(feedViewStore.shownBskyFeedUris).toEqual([CATS]);
    expect(rows()).toEqual(['post:first', 'post:second']);
  });

  it('gives a repost its own row, keyed by the reposter', () => {
    const original = post('p', 3);
    const repost = post('p', 3, {
      repostedBy: { did: 'did:plc:b', handle: 'b.test' },
      sortAt: new Date(NOW - HOUR).toISOString(),
    });
    feedPage(FOLLOWING, [repost, original]);
    show(channel([bskyFeedSourceKey(FOLLOWING)]));
    expect(feedViewStore.currentItems.map((i) => i.key)).toEqual([
      'bsky:at://did:plc:a/app.bsky.feed.post/p#did:plc:b',
      'bsky:at://did:plc:a/app.bsky.feed.post/p#',
    ]);
  });

  it('sorts posts among articles by when the feed placed them', () => {
    feedPage(FOLLOWING, [post('a', 1), post('c', 5)]);
    bskyRiver.articles = [article('b', 3)];
    show(channel([bskyFeedSourceKey(FOLLOWING), 'rss~feedaaaaaaaaa']));
    expect(feedViewStore.bskyFeedOnly).toBe(false);
    expect(rows()).toEqual(['post:a', 'article:b', 'post:c']);
  });

  it('shows a post two feeds share once', () => {
    feedPage(FOLLOWING, [post('shared', 1)]);
    feedPage(CATS, [post('shared', 1), post('cat', 2)]);
    show(channel([bskyFeedSourceKey(FOLLOWING), bskyFeedSourceKey(CATS)]));
    expect(rows()).toEqual(['post:shared', 'post:cat']);
  });

  it('leaves them out under a type filter', () => {
    feedPage(FOLLOWING, [post('p', 1)]);
    bskyRiver.articles = [article('x', 2)];
    show(channel([bskyFeedSourceKey(FOLLOWING), 'rss~feedaaaaaaaaa'], { typeFilter: ['rss'] }));
    expect(rows()).toEqual(['article:x']);
  });

  it('pages a feed on its own by cursor', async () => {
    feedPage(CATS, [post('p', 1)], 'next');
    show(channel([bskyFeedSourceKey(CATS)]));
    expect(feedViewStore.hasMore).toBe(true);
    await feedViewStore.loadMore();
    expect(bskyRiver.loadMoreCalls).toEqual([CATS]);

    feedPage(CATS, [post('p', 1)], null);
    expect(feedViewStore.hasMore).toBe(false);
  });

  it('in a mixed view, pages a feed only once the list reaches its oldest post', async () => {
    // 200 articles an hour apart; the timeline's oldest loaded post is 150h old.
    // The list shown after one more page ends around 100h, above that post, so
    // the timeline has nothing to add there yet.
    bskyRiver.articles = Array.from({ length: 200 }, (_, i) => article(`a${i}`, i + 0.5));
    feedPage(FOLLOWING, [post('p1', 1), post('p150', 150)], 'next');
    show(channel([bskyFeedSourceKey(FOLLOWING), 'rss~feedaaaaaaaaa']));
    await feedViewStore.loadMore();
    expect(bskyRiver.loadMoreCalls).toEqual([]);

    // A feed whose loaded posts all sit above the shown rows pages now.
    feedPage(FOLLOWING, [post('p1', 1)], 'next');
    await feedViewStore.loadMore();
    expect(bskyRiver.loadMoreCalls).toEqual([FOLLOWING]);
  });
});
