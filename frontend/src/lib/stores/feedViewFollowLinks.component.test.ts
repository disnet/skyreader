// Named `.component.test.ts` so it runs in the project that compiles runes —
// feedView is a `.svelte.ts` module and its derivations need the Svelte plugin.
//
// "From your follows" is a source, not a page: a channel that names it gets the
// links your Bluesky follows shared, as river rows beside its articles. These
// pin the rules that keep that calm: the source is part of "All sources" only
// when the reader has said yes,
// a page the river already shows as an article isn't shown twice, a link is
// dated by its first share, and it reads like everything else.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, FilteredView, FollowLink } from '$lib/types';
import { river, resetRiver } from '../../../test/stubs/follow-links-river-fixtures.svelte';

vi.mock('./filteredViews.svelte', () => ({
  filteredViewsStore: {
    get views() {
      return river.channels;
    },
    getById: (id: number) => river.channels.find((v) => v.id === id),
    getByUuid: (uuid: string) => river.channels.find((v) => v.uuid === uuid),
    update: () => {},
  },
}));
vi.mock('./followLinks.svelte', () => ({
  followLinksStore: {
    get links() {
      return river.links;
    },
    get inEverything() {
      return river.inEverything;
    },
  },
}));
vi.mock('./articles.svelte', () => ({
  articlesStore: {
    get allArticles() {
      return river.articles;
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
    isRead: (key: string) => river.read.includes(key),
    isSocialRead: () => false,
    itemHasAnyTag: () => true,
    get tagsByItem() {
      return {};
    },
    markAsRead: (_sub: string, key: string) => {
      river.read = [...river.read, key];
    },
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
const { FOLLOWS_SOURCE_KEY } = await import('$lib/utils/sourceKeys');

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

function link(path: string, firstHoursAgo: number, over: Partial<FollowLink> = {}): FollowLink {
  return {
    url: `https://site.example/${path}?utm_source=bsky`,
    urlNormalized: `https://site.example/${path}`,
    site: 'site.example',
    title: path,
    description: null,
    thumb: null,
    sharers: [],
    sharerCount: 1,
    firstSharedAt: NOW - firstHoursAgo * HOUR,
    lastSharedAt: NOW - HOUR,
    ...over,
  };
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
  river.channels = [...river.channels, view];
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
  return feedViewStore.currentItems.map((i) => `${i.type}:${i.item.title}`);
}

describe('follows links in the river', () => {
  beforeEach(() => {
    resetRiver();
    feedViewStore.resetSelection();
    // Leave whatever view the last case was on, so the next setFilters applies.
    feedViewStore.setFilters({
      feed: null,
      saved: 'true',
      sharer: null,
      following: null,
      feeds: null,
    });
  });

  it('leaves them out of Everything until the reader says yes', () => {
    river.links = [link('a', 2)];
    river.articles = [article('x', 1)];
    show(null);
    expect(rows()).toEqual(['article:x']);

    river.inEverything = false;
    expect(rows()).toEqual(['article:x']);

    river.inEverything = true;
    expect(rows()).toEqual(['article:x', 'link:a']);
  });

  it('keeps them out of a category, even with Everything on', () => {
    river.inEverything = true;
    river.links = [link('a', 2)];
    river.articles = [article('x', 1)];
    feedViewStore.setFilters({
      feed: null,
      saved: null,
      sharer: null,
      following: null,
      feeds: null,
      category: 'Tech',
    });
    expect(rows().filter((r) => r.startsWith('link:'))).toEqual([]);
  });

  it('shows them in a channel that names the source, newest first share first', () => {
    // Re-shared an hour ago but first shared long before: it sorts by the first.
    river.links = [link('old', 30, { lastSharedAt: NOW }), link('new', 2)];
    show(channel([FOLLOWS_SOURCE_KEY]));
    expect(rows()).toEqual(['link:new', 'link:old']);
    // Keyed by the normalized URL: the key read state lives under.
    expect(feedViewStore.currentItems[0].key).toBe('https://site.example/new');
  });

  it('merges them with the channel’s articles by date', () => {
    river.links = [link('a', 1), link('c', 5)];
    river.articles = [article('b', 3)];
    show(channel([FOLLOWS_SOURCE_KEY, 'rss~feedaaaaaaaaa']));
    expect(rows()).toEqual(['link:a', 'article:b', 'link:c']);
  });

  it('drops a link the river already shows as an article, whatever form its URL takes', () => {
    river.links = [link('same', 1), link('other', 2)];
    river.articles = [article('same', 3)];
    show(channel([FOLLOWS_SOURCE_KEY, 'rss~feedaaaaaaaaa']));
    expect(rows()).toEqual(['link:other', 'article:same']);
  });

  it('leaves them out under a type filter, which picks subscription types', () => {
    river.links = [link('a', 1)];
    show(channel([FOLLOWS_SOURCE_KEY], { typeFilter: ['rss'] }));
    expect(rows()).toEqual([]);
  });

  it('reads them like articles: gone under Unread, but kept while you are on them', () => {
    river.links = [link('seen', 1), link('fresh', 2)];
    river.read = ['https://site.example/seen'];
    show(channel([FOLLOWS_SOURCE_KEY]));
    expect(rows()).toEqual(['link:fresh']);

    // Selecting marks it read, under its key, and it stays for this visit.
    feedViewStore.select(0);
    expect(river.read).toContain('https://site.example/fresh');
    expect(rows()).toEqual(['link:fresh']);
  });
});
