// Named `.component.test.ts` so it runs in the project that compiles runes —
// the magazine store is a `.svelte.ts` module.
//
// A feed-sourced issue keys every entry by feed URL + guid (guids are only unique
// within a feed) while reading state stays under the bare guid the feed reader
// labels it under, and carries no save rkey. These tests pin the candidate rules
// too: read, archived, truncated, too-short and feed-less items stay out.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, MagazineItemSnapshot, SavedItem } from '$lib/types';
import { MIN_FEED_ARTICLE_WORDS, feedMagazineKey, magazineEntries } from '$lib/utils/dailyMagazine';

const state = vi.hoisted(() => ({
  articles: [] as Article[],
  read: new Set<string>(),
  archived: new Set<string>(),
  opened: new Set<string>(),
  source: 'feeds' as 'saved' | 'feeds',
  order: 'recent' as 'shuffle' | 'recent' | 'oldest',
  minutes: 60,
  feeds: new Map<number, string>([
    [7, 'https://a.example/feed.xml'],
    [8, 'https://b.example/feed.xml'],
  ]),
  rows: [] as Article[],
  saves: [] as SavedItem[],
  saveBodies: new Map<string, string>(),
}));

vi.mock('./subscriptions.svelte', () => ({
  subscriptionsStore: {
    getById: (id: number) => {
      const feedUrl = state.feeds.get(id);
      return feedUrl ? { id, feedUrl } : undefined;
    },
  },
}));

vi.mock('./articles.svelte', () => ({
  articlesStore: {
    get unreadArticles() {
      return state.articles.filter((a) => !state.read.has(a.guid));
    },
  },
}));

vi.mock('./saves.svelte', () => ({
  savesStore: {
    articles: [],
    getByGuid: (guid: string) => state.saves.find((s) => s.itemGuid === guid),
    getContent: async (rkey: string) => state.saveBodies.get(rkey) ?? null,
  },
}));

vi.mock('./itemLabels.svelte', () => ({
  itemLabelsStore: {
    isArchived: (key: string) => state.archived.has(key),
    getReadActivity: (keys: string[]) => (keys.some((k) => state.opened.has(k)) ? {} : null),
  },
}));

vi.mock('./preferences.svelte', () => ({
  preferences: {
    get dailyMagazineSource() {
      return state.source;
    },
    get dailyMagazineOrder() {
      return state.order;
    },
    get dailyMagazineMinutes() {
      return state.minutes;
    },
  },
}));

vi.mock('./sync.svelte', () => ({ syncStore: { isOnline: false } }));
vi.mock('./auth.svelte', () => ({ auth: { isGuest: true, user: null } }));
vi.mock('$lib/services/extract', () => ({ extractArticle: vi.fn() }));
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue: vi.fn(async () => {}) } }));
vi.mock('$lib/services/api', () => ({ api: {} }));
vi.mock('$lib/services/db', () => ({
  db: {
    magazines: { put: vi.fn(async () => {}), toArray: vi.fn(async () => []) },
    articles: {
      where: () => ({
        equals: (guid: string) => ({
          toArray: async () => state.rows.filter((r) => r.guid === guid),
        }),
      }),
    },
  },
  getMetadata: vi.fn(async () => undefined),
  setMetadata: vi.fn(async () => {}),
}));

const { magazineStore } = await import('./magazine.svelte');

function article(guid: string, words: number, publishedAt: string, extra: Partial<Article> = {}) {
  return {
    subscriptionId: 7,
    guid,
    url: `https://www.example.com/${guid}`,
    title: `Title ${guid}`,
    author: 'Ada',
    imageUrl: `https://example.com/${guid}.png`,
    publishedAt,
    fetchedAt: 0,
    wordCount: words,
    ...extra,
  } satisfies Article;
}

beforeEach(() => {
  state.articles = [];
  state.read = new Set();
  state.archived = new Set();
  state.opened = new Set();
  state.source = 'feeds';
  state.order = 'recent';
  state.minutes = 60;
  state.rows = [];
  state.saves = [];
  state.saveBodies = new Map();
});

const FEED_A = 'https://a.example/feed.xml';
const FEED_B = 'https://b.example/feed.xml';

describe('feed-sourced magazines', () => {
  it('builds from unread, unarchived, full-body feed items keyed by feed URL + guid', async () => {
    state.articles = [
      article('keep-old', 400, '2026-09-01T00:00:00Z'),
      article('keep-new', 600, '2026-09-10T00:00:00Z'),
      article('read', 400, '2026-09-11T00:00:00Z'),
      article('archived', 400, '2026-09-12T00:00:00Z'),
      article('truncated', 400, '2026-09-13T00:00:00Z', { contentTruncated: true }),
      article('short', MIN_FEED_ARTICLE_WORDS - 1, '2026-09-14T00:00:00Z'),
      article('no-feed', 400, '2026-09-15T00:00:00Z', { subscriptionId: 99 }),
    ];
    state.read.add('read');
    state.archived.add('archived');

    const mag = await magazineStore.generate();

    expect(mag?.params).toMatchObject({ source: 'feeds', order: 'recent', totalMinutes: 5 });
    expect(mag?.items.map((i) => i.guid)).toEqual(['keep-new', 'keep-old']);
    expect(mag?.items[0]).toMatchObject({
      key: feedMagazineKey(FEED_A, 'keep-new'),
      displayKey: feedMagazineKey(FEED_A, 'keep-new'),
      guid: 'keep-new',
      feedUrl: FEED_A,
      rkey: '',
      sourceType: 'article',
      domain: 'example.com',
      image: 'https://example.com/keep-new.png',
      minutes: 3,
      savedAt: null,
    });
    expect(mag?.items[0]).not.toHaveProperty('subscriptionId');
  });

  it('orders oldest-first by publish date', async () => {
    state.order = 'oldest';
    state.articles = [
      article('b', 400, '2026-09-10T00:00:00Z'),
      article('a', 400, '2026-09-01T00:00:00Z'),
    ];
    const mag = await magazineStore.generate();
    expect(mag?.items.map((i) => i.guid)).toEqual(['a', 'b']);
  });

  it('returns null when nothing unread is left', async () => {
    state.articles = [article('done', 400, '2026-09-10T00:00:00Z')];
    state.read.add('done');
    expect(await magazineStore.generate()).toBeNull();
  });

  it('records the saved source for saves-built issues', async () => {
    state.source = 'saved';
    state.articles = [article('ignored', 400, '2026-09-10T00:00:00Z')];
    // No saves, so nothing to build — and the feed pool isn't consulted.
    expect(await magazineStore.generate()).toBeNull();
  });
});

describe('the same guid in two feeds', () => {
  async function generateDuplicatePair() {
    state.articles = [
      article('shared', 400, '2026-09-10T00:00:00Z', { url: 'https://a.example/post' }),
      article('shared', 600, '2026-09-01T00:00:00Z', {
        subscriptionId: 8,
        url: 'https://b.example/post',
      }),
    ];
    const mag = await magazineStore.generate();
    if (!mag) throw new Error('expected an issue');
    return mag.items;
  }

  it('generates two entries with distinct feed-qualified keys', async () => {
    const items = await generateDuplicatePair();
    expect(items.map((i) => [i.key, i.displayKey, i.guid, i.feedUrl])).toEqual([
      [feedMagazineKey(FEED_A, 'shared'), feedMagazineKey(FEED_A, 'shared'), 'shared', FEED_A],
      [feedMagazineKey(FEED_B, 'shared'), feedMagazineKey(FEED_B, 'shared'), 'shared', FEED_B],
    ]);
  });

  it('hydrates distinct entry keys while read state stays under the guid', async () => {
    const entries = magazineEntries(await generateDuplicatePair(), new Map());
    expect(new Set(entries.map((e) => e.entryKey)).size).toBe(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        itemKey: 'shared',
        itemType: 'article',
        labelKeys: ['shared'],
      });
    }
    expect(entries.map((e) => e.item.url)).toEqual([
      'https://a.example/post',
      'https://b.example/post',
    ]);
  });

  it('loads each entry’s body from its own feed', async () => {
    const items = await generateDuplicatePair();
    // Same guid, stored under each device-local subscription id. Feed B's row
    // comes first, so a guid-only lookup would hand it to both entries.
    state.rows = [
      article('shared', 600, '2026-09-01T00:00:00Z', { subscriptionId: 8, content: '<p>B</p>' }),
      article('shared', 400, '2026-09-10T00:00:00Z', { content: '<p>A</p>' }),
    ];
    const bodies = await Promise.all(items.map((snap) => magazineStore.findFeedBody(snap)));
    expect(bodies).toEqual(['<p>A</p>', '<p>B</p>']);
  });

  it('only uses a save of the same URL', async () => {
    const items = await generateDuplicatePair();
    state.saves = [{ rkey: 's1', itemGuid: 'shared', url: 'https://b.example/post' } as SavedItem];
    state.saveBodies.set('s1', '<p>saved B</p>');
    state.rows = [article('shared', 400, '2026-09-10T00:00:00Z', { content: '<p>A</p>' })];
    const bodies = await Promise.all(items.map((snap) => magazineStore.findFeedBody(snap)));
    expect(bodies).toEqual(['<p>A</p>', '<p>saved B</p>']);
  });
});

describe('feed snapshots without a feed URL', () => {
  it('fall back to the local row with the same URL', async () => {
    const snap = {
      key: 'shared',
      displayKey: 'shared',
      rkey: '',
      sourceType: 'article',
      guid: 'shared',
      url: 'https://b.example/post',
    } as MagazineItemSnapshot;
    state.rows = [
      article('shared', 400, '2026-09-10T00:00:00Z', {
        url: 'https://a.example/post',
        content: '<p>A</p>',
      }),
      article('shared', 400, '2026-09-10T00:00:00Z', {
        url: 'https://b.example/post',
        content: '<p>B</p>',
      }),
    ];
    expect(await magazineStore.findFeedBody(snap)).toBe('<p>B</p>');
  });
});

describe('empty issue hints', () => {
  it('says caught up when nothing is unread', () => {
    expect(magazineStore.emptyIssueHint()).toMatch(/all caught up/);
  });

  it('says there is no full text when every unread item is an excerpt or truncated', () => {
    state.articles = [
      article('short', MIN_FEED_ARTICLE_WORDS - 1, '2026-09-10T00:00:00Z'),
      article('truncated', 400, '2026-09-10T00:00:00Z', { contentTruncated: true }),
    ];
    expect(magazineStore.emptyIssueHint()).toMatch(/enough full text/);
  });

  it('falls back to the length hint when full-text candidates exist', () => {
    state.articles = [article('long', 400, '2026-09-10T00:00:00Z')];
    expect(magazineStore.emptyIssueHint()).toMatch(/longer issue/);
  });

  it('asks for a save when the saved pile is empty', () => {
    state.source = 'saved';
    expect(magazineStore.emptyIssueHint()).toMatch(/Save an article first/);
  });
});
