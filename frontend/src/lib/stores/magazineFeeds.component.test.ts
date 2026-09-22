// Named `.component.test.ts` so it runs in the project that compiles runes —
// the magazine store is a `.svelte.ts` module.
//
// A feed-sourced issue has to key every entry by article guid (the key the feed
// reader labels it under) and carry no save rkey, or magazine reading and the
// inbox's unread state silently fork. These tests pin the candidate rules too:
// read, archived, truncated and too-short items stay out.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '$lib/types';
import { MIN_FEED_ARTICLE_WORDS } from '$lib/utils/dailyMagazine';

const state = vi.hoisted(() => ({
  articles: [] as Article[],
  read: new Set<string>(),
  archived: new Set<string>(),
  opened: new Set<string>(),
  source: 'feeds' as 'saved' | 'feeds',
  order: 'recent' as 'shuffle' | 'recent' | 'oldest',
  minutes: 60,
}));

vi.mock('./articles.svelte', () => ({
  articlesStore: {
    get unreadArticles() {
      return state.articles.filter((a) => !state.read.has(a.guid));
    },
  },
}));

vi.mock('./saves.svelte', () => ({
  savesStore: { articles: [] },
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
vi.mock('./auth.svelte', () => ({ auth: { isGuest: true } }));
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue: vi.fn(async () => {}) } }));
vi.mock('$lib/services/api', () => ({ api: {} }));
vi.mock('$lib/services/db', () => ({
  db: { magazines: { put: vi.fn(async () => {}), toArray: vi.fn(async () => []) } },
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
});

describe('feed-sourced magazines', () => {
  it('builds from unread, unarchived, full-body feed items keyed by guid', async () => {
    state.articles = [
      article('keep-old', 400, '2026-09-01T00:00:00Z'),
      article('keep-new', 600, '2026-09-10T00:00:00Z'),
      article('read', 400, '2026-09-11T00:00:00Z'),
      article('archived', 400, '2026-09-12T00:00:00Z'),
      article('truncated', 400, '2026-09-13T00:00:00Z', { contentTruncated: true }),
      article('short', MIN_FEED_ARTICLE_WORDS - 1, '2026-09-14T00:00:00Z'),
    ];
    state.read.add('read');
    state.archived.add('archived');

    const mag = await magazineStore.generate();

    expect(mag?.params).toMatchObject({ source: 'feeds', order: 'recent', totalMinutes: 5 });
    expect(mag?.items.map((i) => i.key)).toEqual(['keep-new', 'keep-old']);
    expect(mag?.items[0]).toMatchObject({
      key: 'keep-new',
      displayKey: 'keep-new',
      guid: 'keep-new',
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
