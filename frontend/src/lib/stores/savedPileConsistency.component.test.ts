// Named `.component.test.ts` so it runs in the project that compiles runes —
// feedView is a `.svelte.ts` module and its derivations need the Svelte plugin.
//
// Home's "Recently saved" lane and the Saved list render the same pile through
// two different pipelines, and they used to answer three questions
// independently: is this item archived, is it the same page as one already in
// the list, and when was it saved. Each disagreement was visible as the lane
// and the list showing different items in a different order. These tests pin
// the Saved list to the shared rules in `utils/savedPile` — the ones the lane
// now imports — so the two can't drift apart again.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, FilteredView, SavedItem, SocialDocument } from '$lib/types';
import { urlKey } from '$lib/utils/urlKey';
import { compareSavedNewestFirst, isSavedItemArchived } from '$lib/utils/savedPile';
// Reactive, so feedView's `$derived` chain re-runs between cases.
import { fixtures, resetFixtures } from '../../../test/stubs/saved-pile-fixtures.svelte';

function findSave(key: string): SavedItem | undefined {
  if (!key) return undefined;
  const direct = fixtures.saves.find((s) => s.itemGuid === key || s.url === key);
  if (direct) return direct;
  const canonical = urlKey(key);
  return canonical ? fixtures.saves.find((s) => urlKey(s.url) === canonical) : undefined;
}

function isArchivedKey(key: string): boolean {
  return fixtures.archived.includes(key);
}

vi.mock('./saves.svelte', () => ({
  savesStore: {
    get articles() {
      return fixtures.saves;
    },
    find: (key: string) => findSave(key),
    getByGuid: (guid: string) => fixtures.saves.find((s) => s.itemGuid === guid),
    getByUrl: (url: string) => fixtures.saves.find((s) => s.url === url),
  },
}));

vi.mock('./itemLabels.svelte', () => ({
  itemLabelsStore: {
    // The real one delegates to savesStore, url ladder and all — which is how
    // a feed article whose page was saved from a bare link gets into the list.
    isSaved: (key: string) => findSave(key) !== undefined,
    isArchived: (key: string) => isArchivedKey(key),
    archiveItem: async (key: string) => {
      if (!fixtures.archived.includes(key)) fixtures.archived = [...fixtures.archived, key];
    },
    unarchiveItem: async (key: string) => {
      fixtures.archived = fixtures.archived.filter((archivedKey) => archivedKey !== key);
    },
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

vi.mock('./articles.svelte', () => ({
  articlesStore: {
    get allArticles() {
      return fixtures.articles;
    },
  },
}));

vi.mock('./social.svelte', () => ({
  socialStore: {
    get documents() {
      return fixtures.documents;
    },
    isLoading: false,
  },
}));

vi.mock('./myLinkblog.svelte', () => ({ myLinkblogStore: { documents: [] } }));
vi.mock('./subscriptions.svelte', () => ({
  subscriptionsStore: { subscriptions: [], getById: () => undefined, getByRkey: () => undefined },
}));
vi.mock('./filteredViews.svelte', () => ({
  filteredViewsStore: {
    get views() {
      return fixtures.channel ? [fixtures.channel] : [];
    },
    getById: () => undefined,
    getByUuid: (uuid: string) => (fixtures.channel?.uuid === uuid ? fixtures.channel : undefined),
    update: () => {},
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

const { feedViewStore, isSavedRowArchived, setSavedRowArchived } =
  await import('./feedView.svelte');

function save(overrides: Partial<SavedItem> = {}): SavedItem {
  return {
    rkey: '3ksaveaaaaaaa',
    uri: 'at://did:plc:test/app.skyreader.feed.saved/3ksaveaaaaaaa',
    url: 'https://example.com/piece',
    title: 'A Piece',
    author: null,
    description: null,
    content: null,
    contentType: 'article',
    domain: 'example.com',
    image: null,
    wordCount: 400,
    publishedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-08-09T00:00:00.000Z',
    source: 'url',
    ...overrides,
  };
}

function article(overrides: Partial<Article> = {}): Article {
  return {
    guid: 'https://example.com/piece',
    subscriptionId: 1,
    title: 'A Piece',
    url: 'https://example.com/piece',
    content: null,
    summary: null,
    author: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    imageUrl: null,
    wordCount: 400,
    ...overrides,
  } as Article;
}

/** The pile as Home's lanes build it: every unarchived save, newest first. */
function homeLane(): SavedItem[] {
  return fixtures.saves
    .filter((s) => !isSavedItemArchived(s, isArchivedKey))
    .sort(compareSavedNewestFirst);
}

function savedListKeys(): string[] {
  return feedViewStore.currentItems.map((item) => item.key);
}

describe('the Saved list and Home draw the same pile', () => {
  beforeEach(() => {
    resetFixtures();
    feedViewStore.setSavedView('inbox');
    feedViewStore.setFilters({
      feed: null,
      saved: 'true',
      sharer: null,
      following: null,
      feeds: null,
    });
  });

  it('lists a url save once when a feed article covers the same page', () => {
    // The save carries no itemGuid (it was made from a bare link), but the feed
    // article's guid IS that url, so `isSaved()` matches it and the article
    // joins the list. The guid-keyed dedup couldn't see the pair, so the page
    // rendered twice here while Home, drawing the save alone, showed it once.
    fixtures.saves = [save({ itemGuid: undefined })];
    fixtures.articles = [article()];

    expect(savedListKeys()).toEqual(['https://example.com/piece']);
    expect(feedViewStore.currentItems).toHaveLength(homeLane().length);
  });

  it('dedups across a trailing slash or a tracking param', () => {
    fixtures.saves = [
      save({ itemGuid: undefined, url: 'https://example.com/piece/?utm_source=news' }),
    ];
    fixtures.articles = [article()];

    expect(feedViewStore.currentItems).toHaveLength(1);
  });

  it('moves a canonically matched article from Archive to Inbox in one operation', async () => {
    const item = save({ itemGuid: undefined, url: 'https://example.com/piece' });
    const row = article({
      guid: 'https://example.com/piece?utm_source=rss',
      url: 'https://example.com/piece?utm_source=rss',
    });
    fixtures.saves = [item];
    fixtures.articles = [row];
    // This is the key the old row action wrote, but it is not one of the
    // resolved save record's own aliases.
    fixtures.archived = [row.guid];

    const displayRow = { type: 'article' as const, item: row, key: row.guid };
    expect(isSavedRowArchived(displayRow)).toBe(true);

    await setSavedRowArchived(displayRow, false);

    expect(fixtures.archived).toEqual([]);
    expect(isSavedRowArchived(displayRow)).toBe(false);
  });

  it('keeps the bookmark in a url-only channel, which renders no article rows', () => {
    // Dedup has to follow what the channel actually shows: a "url saves only"
    // channel drops every article row, so deduping against one would leave the
    // channel a row short instead of merely un-duplicated.
    fixtures.saves = [save({ itemGuid: undefined, source: 'url' })];
    fixtures.articles = [article()];
    fixtures.channel = {
      id: 1,
      uuid: 'chan-1',
      name: 'Links',
      mode: 'saved',
      savedSourceFilter: ['url'],
    } as FilteredView;

    feedViewStore.setFilters({
      feed: null,
      saved: null,
      sharer: null,
      following: null,
      feeds: null,
      view: 'chan-1',
    });

    expect(savedListKeys()).toEqual(['at://did:plc:test/app.skyreader.feed.saved/3ksaveaaaaaaa']);
  });

  it('sorts a url save by when it was saved, not when it was published', () => {
    // An old article saved today belongs at the top of both surfaces. Resolving
    // the save by guid alone found nothing for this row, so it fell through to
    // the publish date and sank into the middle of the list.
    fixtures.saves = [
      save({ itemGuid: undefined, rkey: '3kold', url: 'https://example.com/older' }),
      save({
        itemGuid: undefined,
        rkey: '3knew',
        url: 'https://example.com/piece',
        savedAt: '2026-08-20T00:00:00.000Z',
        publishedAt: '2011-01-01T00:00:00.000Z',
      }),
    ];
    fixtures.articles = [
      article({ guid: 'https://example.com/older', url: 'https://example.com/older' }),
      article({ publishedAt: '2011-01-01T00:00:00.000Z' }),
    ];

    expect(savedListKeys()).toEqual(['https://example.com/piece', 'https://example.com/older']);
    expect(homeLane().map((s) => s.url)).toEqual([
      'https://example.com/piece',
      'https://example.com/older',
    ]);
  });

  it('hides an item archived under its record uri, the key the `e` shortcut writes', () => {
    const item = save({ itemGuid: 'guid-1' });
    fixtures.saves = [item];
    fixtures.archived = [item.uri];

    expect(savedListKeys()).toEqual([]);
    expect(homeLane()).toEqual([]);
  });

  it('hides a saved feed article archived under any of the save’s aliases', () => {
    const item = save({ itemGuid: 'guid-1', source: 'feed' });
    fixtures.saves = [item];
    fixtures.articles = [article({ guid: 'guid-1' })];
    fixtures.archived = [item.uri];

    expect(savedListKeys()).toEqual([]);
    expect(homeLane()).toEqual([]);
  });

  it('hides a saved document archived under its save’s record uri', () => {
    const item = save({ itemGuid: 'at://did:plc:author/site.standard.document/doc1' });
    fixtures.saves = [item];
    fixtures.documents = [
      {
        recordUri: 'at://did:plc:author/site.standard.document/doc1',
        title: 'A Document',
        publishedAt: '2026-01-01T00:00:00.000Z',
      } as SocialDocument,
    ];
    fixtures.archived = [item.uri];

    expect(savedListKeys()).toEqual([]);
    expect(homeLane()).toEqual([]);
  });

  it('shows the archived item in the Archive tab, keyed the same way', () => {
    const item = save({ itemGuid: 'guid-1' });
    fixtures.saves = [item];
    fixtures.archived = [item.uri];

    feedViewStore.setSavedView('archive');
    expect(savedListKeys()).toEqual([item.uri]);
  });
});
