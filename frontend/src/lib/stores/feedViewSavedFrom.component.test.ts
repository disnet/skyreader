// Named `.component.test.ts` so it runs in the project that compiles runes.
//
// `/saved?from=<url>`: the Library filtered to one reading session, the saves
// made out of one article, archived or not.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedItem } from '$lib/types';

const saves = vi.hoisted(() => ({ list: [] as SavedItem[] }));
const archived = vi.hoisted(() => new Set<string>());

vi.mock('./filteredViews.svelte', () => ({
  filteredViewsStore: { views: [], getById: () => undefined, getByUuid: () => undefined },
}));

vi.mock('./articles.svelte', () => ({ articlesStore: { allArticles: [] } }));
vi.mock('./social.svelte', () => ({ socialStore: { documents: [], isLoading: false } }));
vi.mock('./myLinkblog.svelte', () => ({ myLinkblogStore: { documents: [] } }));
vi.mock('./shelf.svelte', () => ({ shelfStore: { isOnShelf: () => false } }));
vi.mock('./saves.svelte', () => ({
  savesStore: {
    get articles() {
      return saves.list;
    },
    find: () => undefined,
    getByGuid: () => undefined,
    getByUrl: () => undefined,
  },
}));
vi.mock('./subscriptions.svelte', () => ({
  subscriptionsStore: { subscriptions: [], getById: () => undefined, getByRkey: () => undefined },
}));
vi.mock('./itemLabels.svelte', () => ({
  itemLabelsStore: {
    isSaved: () => false,
    isArchived: (key: string) => archived.has(key),
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
  savedSearchStore: {
    terms: [],
    bodyMatchTerms: [],
    active: false,
    reset: () => {},
    setSurfaceActive: () => {},
  },
}));
vi.mock('./preferences.svelte', () => ({
  preferences: { sortOrder: 'newest', toggleSortOrder: () => {} },
}));
vi.mock('$lib/services/liveDb.svelte', () => ({
  liveDb: { articlesVersion: 0, getArticleBodies: async () => new Map() },
}));

const { feedViewStore } = await import('./feedView.svelte');

const SOURCE = 'https://essays.example/how-cities-remember';

function save(rkey: string, from?: string): SavedItem {
  return {
    rkey,
    uri: `at://did:plc:x/app.skyreader.feed.saved/${rkey}`,
    url: `https://cited.example/${rkey}`,
    title: rkey,
    author: null,
    description: null,
    content: null,
    contentType: 'webpage',
    domain: null,
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: `2026-11-01T10:0${rkey.charCodeAt(0) - 97}:00Z`,
    source: 'url',
    savedFromUrl: from ?? null,
    savedFromTitle: from ? 'How Cities Remember' : null,
  };
}

function filters(from: string | null) {
  return {
    feed: null,
    saved: 'true',
    sharer: null,
    following: null,
    feeds: null,
    view: null,
    category: null,
    from,
  };
}

const keys = () => feedViewStore.currentItems.map((i) => i.key.split('/').pop());

describe('the Library, filtered to one article', () => {
  beforeEach(() => {
    saves.list = [
      save('a', SOURCE),
      save('b', `${SOURCE}/`),
      save('c'),
      save('d', 'https://x.example/'),
    ];
    archived.clear();
    feedViewStore.setFilters(filters(null));
  });

  it('shows only the saves made out of that article', () => {
    feedViewStore.setFilters(filters(SOURCE));
    expect(feedViewStore.savedFromFilter).toBe(SOURCE);
    expect(new Set(keys())).toEqual(new Set(['a', 'b']));
  });

  it('keeps an archived one in the trail', () => {
    archived.add(save('a').uri);
    feedViewStore.setSavedView('inbox');
    expect(keys()).not.toContain('a');
    feedViewStore.setFilters(filters(SOURCE));
    expect(new Set(keys())).toEqual(new Set(['a', 'b']));
  });

  it('lets go when the param does', () => {
    feedViewStore.setFilters(filters(SOURCE));
    feedViewStore.setFilters(filters(null));
    expect(feedViewStore.savedFromFilter).toBeNull();
    expect(new Set(keys())).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});
