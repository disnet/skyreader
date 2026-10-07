// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Guest saves are local-only: every mutation must take the offline branch
// (Dexie write + sync-queue entry, no API call, no extraction), because the
// queue that accumulates IS the migration on sign-in. A save that reached for
// the network would 401; a save that skipped the queue would silently not
// migrate. These tests pin both halves down.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedItem } from '$lib/types';

// ── Stand-ins ────────────────────────────────────────────────────────────────
// The real dependencies drag in Dexie, the HTTP client and the extractor. What
// is under test is the routing on top of them: which side of canReachBackend()
// each call lands on.

const savedRows = new Map<string, SavedItem>();
const articleRows: Array<{
  id?: number;
  guid: string;
  subscriptionId: number;
  url?: string;
  content: string | null;
  contentTruncated?: boolean;
}> = [];

function whereEquals(rows: () => Record<string, unknown>[], field: string, val: unknown) {
  return {
    first: async () => rows().find((r) => r[field] === val),
    filter: (fn: (r: unknown) => boolean) => ({
      first: async () =>
        rows()
          .filter((r) => r[field] === val)
          .find(fn),
      toArray: async () =>
        rows()
          .filter((r) => r[field] === val)
          .filter(fn),
    }),
    delete: async () => {
      for (const [key, row] of [...savedRows]) {
        if ((row as unknown as Record<string, unknown>)[field] === val) savedRows.delete(key);
      }
    },
  };
}

vi.mock('$lib/services/db', () => ({
  db: {
    saved: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [...savedRows.values()] }) }),
      get: async (rkey: string) => savedRows.get(rkey),
      put: async (item: SavedItem) => void savedRows.set(item.rkey, item),
      delete: async (rkey: string) => void savedRows.delete(rkey),
      clear: async () => savedRows.clear(),
      where: (field: string) => ({
        equals: (val: unknown) =>
          whereEquals(
            () => [...savedRows.values()] as unknown as Record<string, unknown>[],
            field,
            val
          ),
      }),
    },
    articles: {
      where: (field: string) => ({
        equals: (val: unknown) =>
          whereEquals(() => articleRows as unknown as Record<string, unknown>[], field, val),
      }),
    },
  },
}));

vi.mock('$lib/services/safeDb.svelte', () => ({
  safePut: async (table: { put: (v: unknown) => Promise<void> }, value: unknown) =>
    table.put(value),
  safeBulkPut: async (table: { put: (v: unknown) => Promise<void> }, values: unknown[]) => {
    for (const v of values) await table.put(v);
  },
}));

const api = {
  getSaved: vi.fn(),
  getSavedBodies: vi.fn(),
  saveFromUrl: vi.fn(),
  updateSaved: vi.fn(),
  deleteSaved: vi.fn(),
  deleteSavedByGuid: vi.fn(),
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
class ExtractionBlockedError extends Error {}
vi.mock('$lib/services/api', () => ({ api, ApiError, ExtractionBlockedError }));

const extractArticle = vi.fn();
vi.mock('$lib/services/extract', () => ({ extractArticle }));

const loadStoredBody = vi.fn();
vi.mock('$lib/services/itemBody', () => ({ loadStoredBody }));

vi.mock('./subscriptions.svelte', () => ({
  subscriptionsStore: {
    getById: (id: number) => (id === 7 ? { id, feedUrl: 'https://news.example/feed' } : undefined),
    // Subscription 8 is a newsletter: it has no web URL.
    resolveWebUrl: async (a: { url: string; subscriptionId?: number }) =>
      a.subscriptionId === 8 ? '' : a.url,
  },
}));

const enqueue = vi.fn(async () => {});
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue } }));

vi.mock('./savedSearch.svelte', () => ({
  savedSearchStore: { invalidate: vi.fn(), upsert: vi.fn(), remove: vi.fn() },
}));

const authState = { isGuest: true };
vi.mock('./auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
  },
}));

const syncState = { isOnline: true };
vi.mock('./sync.svelte', () => ({
  syncStore: {
    get isOnline() {
      return syncState.isOnline;
    },
  },
}));

const { savesStore } = await import('./saves.svelte');

describe('savesStore in guest mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    articleRows.length = 0;
    authState.isGuest = true;
    syncState.isOnline = true;
    // Drain the store's list between tests (its module state persists).
    for (const a of [...savesStore.articles]) void savesStore.remove(a.rkey);
    vi.clearAllMocks();
  });

  it('load() stops at the Dexie cache and never asks the backend', async () => {
    savedRows.set('3kaaaaaaaaaaa', {
      rkey: '3kaaaaaaaaaaa',
      uri: '',
      url: 'https://example.com/piece',
      title: 'A Piece',
      author: null,
      description: null,
      content: '<p>body</p>',
      contentType: 'article',
      domain: null,
      image: null,
      wordCount: 1,
      publishedAt: null,
      savedAt: '2026-08-01T00:00:00.000Z',
      itemGuid: 'guid-1',
    } as SavedItem);

    await savesStore.load();

    expect(savesStore.articles).toHaveLength(1);
    expect(api.getSaved).not.toHaveBeenCalled();
    expect(api.getSavedBodies).not.toHaveBeenCalled();
  });

  it('load() leaves the cache in savedAt order, not the rkey order it reads in', async () => {
    // The list is Home's "Recently saved" lane and the Saved list's default
    // sort, and this path returns early (a guest, or an unchanged backed
    // snapshot) — so it has to sort like the other two. rkey order only
    // proxies save time: the extension, another device and a backed collection
    // all mint rkeys that don't line up.
    const row = (rkey: string, savedAt: string): SavedItem =>
      ({
        rkey,
        uri: '',
        url: `https://example.com/${rkey}`,
        title: rkey,
        author: null,
        description: null,
        content: null,
        contentType: 'article',
        domain: null,
        image: null,
        wordCount: 1,
        publishedAt: null,
        savedAt,
      }) as SavedItem;

    savedRows.set('3kzzzzzzzzzzz', row('3kzzzzzzzzzzz', '2026-08-01T00:00:00.000Z'));
    savedRows.set('3kaaaaaaaaaaa', row('3kaaaaaaaaaaa', '2026-08-09T00:00:00.000Z'));
    savedRows.set('3kmmmmmmmmmmm', row('3kmmmmmmmmmmm', '2026-08-05T00:00:00.000Z'));

    await savesStore.load();

    expect(savesStore.articles.map((a) => a.rkey)).toEqual([
      '3kaaaaaaaaaaa',
      '3kmmmmmmmmmmm',
      '3kzzzzzzzzzzz',
    ]);
  });

  it('saveArticle writes locally with the RSS body and queues the create for sign-in', async () => {
    articleRows.push({ guid: 'guid-1', subscriptionId: 7, content: '<p>the rss body text</p>' });

    const saved = await savesStore.saveArticle({
      url: 'https://example.com/piece',
      guid: 'guid-1',
      subscriptionId: 7,
      title: 'A Piece',
    });

    // Online, but a guest: the network half must not run.
    expect(api.saveFromUrl).not.toHaveBeenCalled();
    expect(extractArticle).not.toHaveBeenCalled();

    // The local half did: full row in Dexie, visible in the store, queued.
    expect(savedRows.get(saved.rkey)?.content).toBe('<p>the rss body text</p>');
    expect(saved.wordCount).toBeGreaterThan(0);
    expect(savesStore.isSaved('guid-1')).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(
      'create',
      'saved',
      'guid-1',
      expect.objectContaining({ rkey: saved.rkey, url: 'https://example.com/piece' })
    );
  });

  it('unsaveByGuid removes locally and queues the delete', async () => {
    await savesStore.saveArticle({ url: 'https://example.com/piece', guid: 'guid-1' });
    enqueue.mockClear();

    await savesStore.unsaveByGuid('guid-1');

    expect(savesStore.isSaved('guid-1')).toBe(false);
    expect(savedRows.size).toBe(0);
    expect(api.deleteSavedByGuid).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'delete',
      'saved',
      'guid-1',
      expect.objectContaining({ itemGuid: 'guid-1' })
    );
  });

  it('getContent never falls back to the network for a guest', async () => {
    const saved = await savesStore.saveArticle({
      url: 'https://example.com/bodyless',
      guid: 'guid-2',
    });

    // No RSS body was available, so there is nothing locally — and for a guest
    // there is no server copy either. The answer is null, not a 401.
    expect(await savesStore.getContent(saved.rkey)).toBeNull();
    expect(api.getSavedBodies).not.toHaveBeenCalled();
  });
});

describe('savesStore.saveFromUrl when the article cannot be fetched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    authState.isGuest = false;
    syncState.isOnline = true;
    api.saveFromUrl.mockImplementation(async (_url: string, rkey: string) => ({
      uri: `at://did:plc:me/app.skyreader.feed.saved/${rkey}`,
      savedAt: '2026-09-28T00:00:00.000Z',
    }));
  });

  it('saves the link, the hinted title and a note instead of failing on a blocked site', async () => {
    extractArticle.mockRejectedValueOnce(new ExtractionBlockedError());

    const saved = await savesStore.saveFromUrl('https://www.example.com/story', {
      title: 'A Story',
    });

    expect(saved.fetchFailed).toBe('blocked');
    const [url, , meta] = api.saveFromUrl.mock.calls[0];
    expect(url).toBe('https://www.example.com/story');
    expect(meta.title).toBe('A Story');
    expect(meta.domain).toBe('example.com');
    expect(meta.wordCount).toBeUndefined();
    expect(meta.content).toContain('blocks automated readers');
    expect(meta.content).toContain('Chrome extension');
    expect(meta.content).toContain('href="https://www.example.com/story"');
    // The note is the body the reader opens on, so it's stored like any other.
    expect(savedRows.get(saved.rkey)?.content).toBe(meta.content);
    expect(savedRows.get(saved.rkey)).not.toHaveProperty('fetchFailed');
  });

  it('falls back the same way when extraction fails server-side', async () => {
    extractArticle.mockRejectedValueOnce(new ApiError('Failed to extract article', 502));

    const saved = await savesStore.saveFromUrl('https://example.com/broken');

    expect(saved.fetchFailed).toBe('failed');
    expect(saved.title).toBeNull();
    expect(api.saveFromUrl.mock.calls[0][2].content).not.toContain('blocks automated readers');
  });

  it('replaces its own note in place once the article can be fetched', async () => {
    extractArticle.mockRejectedValueOnce(new ExtractionBlockedError());
    const note = await savesStore.saveFromUrl('https://example.com/later', { title: 'Later' });
    const count = savesStore.articles.length;
    api.saveFromUrl.mockClear();

    extractArticle.mockResolvedValueOnce({
      title: null,
      author: 'A. Writer',
      description: null,
      content: '<p>the real article text at last</p>',
      domain: 'example.com',
      image: null,
      published: null,
      wordCount: 6,
    });
    const upgraded = await savesStore.saveFromUrl('https://example.com/later');

    expect(upgraded.fetchFailed).toBeUndefined();
    const [url, , meta] = api.saveFromUrl.mock.calls[0];
    expect(url).toBe('https://example.com/later');
    expect(meta.updateContent).toBe(true);
    // Same save: same rkey, same place in the list, the note's title kept.
    expect(upgraded.rkey).toBe(note.rkey);
    expect(upgraded.savedAt).toBe(note.savedAt);
    expect(upgraded.title).toBe('Later');
    expect(upgraded.wordCount).toBe(6);
    expect(savesStore.articles).toHaveLength(count);
    expect(savedRows.get(note.rkey)?.content).toBe('<p>the real article text at last</p>');
  });

  it('leaves the note alone when the article still cannot be fetched', async () => {
    extractArticle.mockRejectedValueOnce(new ExtractionBlockedError());
    const note = await savesStore.saveFromUrl('https://example.com/still');
    api.saveFromUrl.mockClear();

    extractArticle.mockRejectedValueOnce(new ExtractionBlockedError());
    const again = await savesStore.saveFromUrl('https://example.com/still');

    expect(again.fetchFailed).toBe('blocked');
    expect(again.rkey).toBe(note.rkey);
    expect(api.saveFromUrl).not.toHaveBeenCalled();
  });

  it('never asks to replace a save that holds real text', async () => {
    extractArticle.mockResolvedValue({
      title: 'Real',
      author: null,
      description: null,
      content: '<p>real text</p>',
      domain: 'example.com',
      image: null,
      published: null,
      wordCount: 2,
    });
    await savesStore.saveFromUrl('https://example.com/real');
    api.saveFromUrl.mockClear();
    api.saveFromUrl.mockRejectedValueOnce(new Error('Article already saved'));

    await expect(savesStore.saveFromUrl('https://example.com/real')).rejects.toThrow(
      'Article already saved'
    );
    expect(api.saveFromUrl.mock.calls[0][2].updateContent).toBeUndefined();
    extractArticle.mockReset();
  });

  it('still fails when the problem is not the page (e.g. a 4xx or offline)', async () => {
    extractArticle.mockRejectedValueOnce(new ApiError('Unauthorized', 401));

    await expect(savesStore.saveFromUrl('https://example.com/x')).rejects.toThrow('Unauthorized');
    expect(api.saveFromUrl).not.toHaveBeenCalled();
  });
});

describe('savesStore.saveArticle body choice', () => {
  const words = (n: number) => `<p>${Array.from({ length: n }, (_, i) => `w${i}`).join(' ')}</p>`;

  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    articleRows.length = 0;
    authState.isGuest = false;
    syncState.isOnline = true;
    api.saveFromUrl.mockImplementation(async (_url: string, rkey: string) => ({
      uri: `at://did:plc:me/app.skyreader.feed.saved/${rkey}`,
      rkey,
    }));
  });

  it('keeps a full feed body when the web page is a paywall teaser', async () => {
    const full = words(1200);
    articleRows.push({ guid: 'nl-1', subscriptionId: 7, content: full });
    extractArticle.mockResolvedValueOnce({ content: words(80), wordCount: 80, domain: 'x.com' });

    const saved = await savesStore.saveArticle({
      url: 'https://news.example/p/issue',
      guid: 'nl-1',
      subscriptionId: 7,
    });

    expect(saved.content).toBe(full);
    expect(api.saveFromUrl).toHaveBeenCalledWith(
      'https://news.example/p/issue',
      expect.any(String),
      expect.objectContaining({ content: full })
    );
  });

  it('still upgrades an excerpt to the extracted full text', async () => {
    articleRows.push({ guid: 'post-1', subscriptionId: 7, content: words(30) });
    const extracted = words(900);
    extractArticle.mockResolvedValueOnce({ content: extracted, wordCount: 900, domain: 'x.com' });

    const saved = await savesStore.saveArticle({
      url: 'https://news.example/p/post',
      guid: 'post-1',
      subscriptionId: 7,
    });

    expect(saved.content).toBe(extracted);
  });

  it('recovers an out-of-row body before choosing', async () => {
    const full = words(3000);
    articleRows.push({
      id: 5,
      guid: 'nl-2',
      subscriptionId: 7,
      content: null,
      contentTruncated: true,
    });
    loadStoredBody.mockResolvedValueOnce({ status: 'found', content: full });
    extractArticle.mockResolvedValueOnce({ content: words(100), wordCount: 100, domain: 'x.com' });

    const saved = await savesStore.saveArticle({
      url: 'https://news.example/p/long',
      guid: 'nl-2',
      subscriptionId: 7,
    });

    expect(loadStoredBody).toHaveBeenCalledWith(
      { id: 5, guid: 'nl-2', subscriptionId: 7 },
      'https://news.example/feed',
      { guest: false }
    );
    expect(saved.content).toBe(full);
  });

  it('shows the save before the out-of-row body arrives', async () => {
    const full = words(3000);
    articleRows.push({
      id: 6,
      guid: 'nl-3',
      subscriptionId: 7,
      content: null,
      contentTruncated: true,
    });
    let release!: (v: unknown) => void;
    loadStoredBody.mockReturnValueOnce(new Promise((r) => (release = r)));
    extractArticle.mockResolvedValueOnce({ content: words(100), wordCount: 100, domain: 'x.com' });

    const pending = savesStore.saveArticle({
      url: 'https://news.example/p/slow',
      guid: 'nl-3',
      subscriptionId: 7,
    });

    await vi.waitFor(() => expect(savesStore.isSaved('nl-3')).toBe(true));
    expect(api.saveFromUrl).not.toHaveBeenCalled();

    release({ status: 'found', content: full });
    expect((await pending).content).toBe(full);
  });

  it('never extracts a newsletter: the email is the article', async () => {
    const body = words(40);
    articleRows.push({ guid: 'nl-5', subscriptionId: 8, content: body });

    const saved = await savesStore.saveArticle({
      url: 'https://news.example/p/web-copy',
      guid: 'nl-5',
      subscriptionId: 8,
    });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(saved.content).toBe(body);
    // Nor is its guessed web copy sent: with Semble/Margin backing on it would
    // become a public card for a (often subscriber-tracking) link.
    expect(saved.url).toBe('');
    expect(api.saveFromUrl).toHaveBeenCalledWith(
      '',
      expect.any(String),
      expect.objectContaining({ fromFeed: true, itemGuid: 'nl-5' })
    );
  });

  it('saves a newsletter with no web URL by its guid', async () => {
    const body = words(40);
    articleRows.push({ guid: 'nl-6', subscriptionId: 8, content: body });

    const saved = await savesStore.saveArticle({ url: '', guid: 'nl-6', subscriptionId: 8 });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(api.saveFromUrl).toHaveBeenCalledWith(
      '',
      expect.any(String),
      expect.objectContaining({ fromFeed: true, itemGuid: 'nl-6', content: body })
    );
    expect(saved.uri).toMatch(/^at:\/\//);
  });

  it('knows a newsletter by its feed row when re-saved without a subscription', async () => {
    // Undoing an unsave re-saves from the save row, which has no subscriptionId.
    // An older newsletter save still carries its guessed web copy.
    const body = words(40);
    articleRows.push({ guid: 'nl-7', subscriptionId: 8, content: body });

    const saved = await savesStore.saveArticle({
      url: 'https://news.example/p/web-copy',
      guid: 'nl-7',
    });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(saved.url).toBe('');
    expect(saved.content).toBe(body);
  });

  it('does not guess between two feeds that share a guid', async () => {
    // Re-saving without a subscription: the guid alone can't say which feed's
    // row (and stored body) this is, so the URL settles it — or nothing does.
    articleRows.push(
      { guid: 'https://a.example/1', subscriptionId: 7, url: 'https://a.example/1', content: 'A' },
      { guid: 'https://a.example/1', subscriptionId: 9, url: 'https://b.example/1', content: 'B' }
    );
    const matched = await savesStore.saveArticle({
      url: 'https://b.example/1',
      guid: 'https://a.example/1',
    });
    expect(matched.content).toBe('B');

    articleRows.length = 0;
    articleRows.push(
      { guid: 'g', subscriptionId: 7, url: 'https://a.example/1', content: 'A' },
      { guid: 'g', subscriptionId: 9, url: 'https://a.example/1', content: 'B' }
    );
    const ambiguous = await savesStore.saveArticle({ url: 'https://a.example/1', guid: 'g' });
    expect(ambiguous.content).toBeNull();
  });

  it('keeps a body handed in when there is no feed row to read', async () => {
    const body = words(40);

    const saved = await savesStore.saveArticle({ url: '', guid: 'nl-8', content: body });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(saved.content).toBe(body);
  });

  it('does not reach for the stored body when saving offline', async () => {
    syncState.isOnline = false;
    articleRows.push({
      id: 7,
      guid: 'nl-4',
      subscriptionId: 7,
      content: null,
      contentTruncated: true,
    });

    await savesStore.saveArticle({
      url: 'https://news.example/p/off',
      guid: 'nl-4',
      subscriptionId: 7,
    });

    expect(loadStoredBody).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
  });
});
