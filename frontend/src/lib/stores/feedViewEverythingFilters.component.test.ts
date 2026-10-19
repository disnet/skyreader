// Named `.component.test.ts` so it runs in the project that compiles runes —
// feedView is a `.svelte.ts` module and its derivations need the Svelte plugin.
//
// The plain Everything river has no channel to save its toolbar into, so its
// sources and unread/all toggle are remembered per device instead: restored on
// load and on coming back to it, written only by the reader's own gestures.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./filteredViews.svelte', () => ({
  filteredViewsStore: {
    views: [],
    getById: () => undefined,
    getByUuid: () => undefined,
    update: () => {},
  },
}));
vi.mock('./auth.svelte', () => ({
  auth: { user: { did: 'did:plc:reader' }, isGuest: false },
}));
vi.mock('./articles.svelte', () => ({ articlesStore: { allArticles: [] } }));
vi.mock('./social.svelte', () => ({ socialStore: { documents: [], isLoading: false } }));
vi.mock('./myLinkblog.svelte', () => ({ myLinkblogStore: { documents: [] } }));
vi.mock('./shelf.svelte', () => ({ shelfStore: { isOnShelf: () => false } }));
vi.mock('./saves.svelte', () => ({
  savesStore: {
    articles: [],
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

const EVERYTHING = { feed: null, saved: null, sharer: null, following: null, feeds: null };
const A_FEED = { ...EVERYTHING, feed: '12' };

async function freshStore() {
  vi.resetModules();
  const { feedViewStore } = await import('./feedView.svelte');
  return feedViewStore;
}

describe('Everything remembers its filters on this device', () => {
  beforeEach(() => localStorage.clear());

  it('restores sources and the unread toggle after a reload', async () => {
    let store = await freshStore();
    store.setFilters(EVERYTHING);
    store.setToolbarSourceFilter('exclude', ['rss~3knoisyfeedaaa']);
    store.setShowOnlyUnread(false);

    store = await freshStore();
    expect(store.effectiveFilters.sourceMode).toBe('all');
    store.setFilters(EVERYTHING);
    expect(store.effectiveFilters.sourceMode).toBe('exclude');
    expect(store.effectiveFilters.sourceKeys).toEqual(['rss~3knoisyfeedaaa']);
    expect(store.showOnlyUnread).toBe(false);
  });

  it('restores them on coming back from another view', async () => {
    const store = await freshStore();
    store.setFilters(EVERYTHING);
    store.setToolbarSourceFilter('include', ['rss~3kchosenfeedaa']);

    store.setFilters(A_FEED);
    expect(store.effectiveFilters.sourceMode).toBe('all');
    // Toggling unread on a single feed is not an Everything choice.
    store.setShowOnlyUnread(false);

    store.setFilters(EVERYTHING);
    expect(store.effectiveFilters.sourceMode).toBe('include');
    expect(store.effectiveFilters.sourceKeys).toEqual(['rss~3kchosenfeedaa']);
    expect(store.showOnlyUnread).toBe(true);
  });

  it('remembers clearing the filters too', async () => {
    let store = await freshStore();
    store.setFilters(EVERYTHING);
    store.setToolbarSourceFilter('exclude', ['rss~3knoisyfeedaaa']);
    store.resetToolbarFilters();

    store = await freshStore();
    store.setFilters(EVERYTHING);
    expect(store.effectiveFilters.sourceMode).toBe('all');
  });
});
