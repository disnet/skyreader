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
    }),
    delete: async () => {
      for (const [key, row] of [...savedRows]) {
        if ((row as unknown as Record<string, unknown>)[field] === val) savedRows.delete(key);
      }
    },
  };
}

vi.mock('$lib/services/db', () => ({
  getMetadata: async () => null,
  setMetadata: async () => {},
  db: {
    saved: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [...savedRows.values()] }) }),
      get: async (rkey: string) => savedRows.get(rkey),
      put: async (item: SavedItem) => void savedRows.set(item.rkey, item),
      delete: async (rkey: string) => void savedRows.delete(rkey),
      bulkDelete: async (rkeys: string[]) => rkeys.forEach((r) => savedRows.delete(r)),
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
  safeUpdate: async (
    table: { get: (k: string) => Promise<unknown>; put: (v: unknown) => Promise<void> },
    key: string,
    fields: Record<string, unknown>
  ) => {
    const row = await table.get(key);
    if (row) await table.put({ ...(row as object), ...fields });
  },
}));

const api = {
  getSaved: vi.fn(),
  getSavedBodies: vi.fn(),
  saveFromUrl: vi.fn(),
  uploadPdf: vi.fn(),
  uploadEpub: vi.fn(),
  updateSaved: vi.fn(),
  deleteSaved: vi.fn(),
  deleteSavedMany: vi.fn(),
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
class PdfExtractionError extends Error {
  constructor(
    message: string,
    readonly upgradeRequired = false,
    readonly format: 'pdf' | 'epub' = 'pdf'
  ) {
    super(message);
  }
}
class FileUploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly rkey?: string
  ) {
    super(message);
  }
}
vi.mock('$lib/services/api', () => ({
  api,
  ApiError,
  ExtractionBlockedError,
  PdfExtractionError,
  FileUploadError,
}));

const extractArticle = vi.fn();
vi.mock('$lib/services/extract', () => ({ extractArticle }));

const loadStoredBody = vi.fn();
vi.mock('$lib/services/itemBody', () => ({ loadStoredBody }));

const documentBody = vi.fn(async (): Promise<string | null> => null);
vi.mock('$lib/utils/documentBody', () => ({ documentBody }));

vi.mock('./subscriptions.svelte', () => ({
  subscriptionsStore: {
    getById: (id: number) => (id === 7 ? { id, feedUrl: 'https://news.example/feed' } : undefined),
  },
}));

const enqueue = vi.fn(async () => {});
const enqueueSavedDeletes = vi.fn(async (saves: { rkey: string }[]) => saves.map((s) => s.rkey));
const clearSavedDeletes = vi.fn(async () => {});
const pendingSavedRkeys = vi.fn(async () => new Set<string>());
vi.mock('$lib/services/sync-queue', () => ({
  syncQueue: { enqueue, enqueueSavedDeletes, clearSavedDeletes, pendingSavedRkeys },
  SAVED_DELETE_BATCH: 2,
}));

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
const { db } = await import('$lib/services/db');

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

  it('removeMany queues every delete, then sends them in bulk and clears each batch', async () => {
    const saved = [];
    for (const n of [1, 2, 3, 4, 5]) {
      saved.push(
        await savesStore.saveArticle({ url: `https://example.com/bulk-${n}`, guid: `bulk-${n}` })
      );
    }
    const rkeys = saved.map((s) => s.rkey);
    // A guest can't reach the backend; this one is signed in.
    authState.isGuest = false;
    api.deleteSavedMany.mockImplementation(async (chunk: string[]) => {
      // The queue already holds all five before the first request.
      expect(enqueueSavedDeletes).toHaveBeenCalledTimes(1);
      return { deleted: chunk.length };
    });
    const progress: number[] = [];

    await savesStore.removeMany([...rkeys, rkeys[0]], (done) => progress.push(done));

    expect(savesStore.articles).toHaveLength(0);
    expect(savedRows.size).toBe(0);
    expect(enqueueSavedDeletes.mock.calls[0][0].map((s: { rkey: string }) => s.rkey)).toEqual(
      rkeys
    );
    // Two a request in this test (500 in the app).
    expect(api.deleteSavedMany.mock.calls.map((c) => c[0])).toEqual([
      rkeys.slice(0, 2),
      rkeys.slice(2, 4),
      rkeys.slice(4),
    ]);
    expect(clearSavedDeletes.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      rkeys.slice(0, 2),
      rkeys.slice(2, 4),
      rkeys.slice(4),
    ]);
    expect(progress).toEqual([2, 4, 5]);
  });

  it('removeMany leaves what the server never confirmed in the queue', async () => {
    const saved = [];
    for (const n of [1, 2, 3]) {
      saved.push(
        await savesStore.saveArticle({ url: `https://example.com/drop-${n}`, guid: `drop-${n}` })
      );
    }
    authState.isGuest = false;
    api.deleteSavedMany
      .mockResolvedValueOnce({ deleted: 2 })
      .mockRejectedValueOnce(new Error('Failed to fetch'));

    await savesStore.removeMany(saved.map((s) => s.rkey));

    expect(clearSavedDeletes).toHaveBeenCalledTimes(1);
    expect(clearSavedDeletes).toHaveBeenCalledWith([saved[0].rkey, saved[1].rkey]);
  });

  it('removeMany sends nothing for a save whose create never left the queue', async () => {
    authState.isGuest = false;
    const saved = await savesStore.saveArticle({ url: 'https://example.com/unsent', guid: 'u' });
    enqueueSavedDeletes.mockResolvedValueOnce([]);

    await savesStore.removeMany([saved.rkey]);

    expect(api.deleteSavedMany).not.toHaveBeenCalled();
  });

  it('load keeps a save whose delete is still queued out of the list', async () => {
    authState.isGuest = false;
    const row = (rkey: string, n: number) =>
      ({ rkey, url: `https://example.com/queued-${n}`, title: `Q ${n}`, savedAt: n }) as never;
    pendingSavedRkeys.mockImplementation(async (op?: string) =>
      op === 'delete' ? new Set(['3kqueuedaaaa1']) : new Set()
    );
    api.getSaved.mockResolvedValueOnce({
      articles: [row('3kqueuedaaaa2', 2), row('3kqueuedaaaa1', 1)],
      full: true,
      cursor: null,
    });
    api.getSavedBodies.mockResolvedValue({ bodies: {} });

    await savesStore.load();

    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['3kqueuedaaaa2']);
    pendingSavedRkeys.mockImplementation(async () => new Set());
  });

  it('a save bulk-deleted while a load is in flight stays deleted', async () => {
    authState.isGuest = false;
    const row = (rkey: string, n: number) =>
      ({ rkey, url: `https://example.com/race-${n}`, title: `Race ${n}`, savedAt: n }) as never;
    savedRows.set('3kraceraceaa1', row('3kraceraceaa1', 1));
    savedRows.set('3kraceraceaa2', row('3kraceraceaa2', 2));
    let answer!: (v: unknown) => void;
    api.getSaved.mockReturnValueOnce(new Promise((r) => (answer = r)));
    api.getSavedBodies.mockResolvedValue({ bodies: {} });
    api.deleteSavedMany.mockResolvedValue({ deleted: 1 });

    const loading = savesStore.load();
    await vi.waitFor(() => expect(api.getSaved).toHaveBeenCalled());
    await savesStore.removeMany(['3kraceraceaa1']);
    // The server's page was read before the delete reached it.
    answer({
      articles: [row('3kraceraceaa3', 3), row('3kraceraceaa2', 2), row('3kraceraceaa1', 1)],
      cursor: null,
    });
    await loading;

    expect(savesStore.articles.map((a) => a.rkey)).toEqual(['3kraceraceaa3', '3kraceraceaa2']);
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
    // No title to go on: the trimmed URL stands in rather than a blank.
    expect(saved.title).toBe('example.com/broken');
    expect(api.saveFromUrl.mock.calls[0][2].title).toBe('example.com/broken');
    expect(api.saveFromUrl.mock.calls[0][2].content).not.toContain('blocks automated readers');
  });

  it('saves a PDF it could not read without pointing at the extension', async () => {
    extractArticle.mockRejectedValueOnce(
      new PdfExtractionError('This PDF is larger than 10 MB, the most Skyreader can save')
    );

    const saved = await savesStore.saveFromUrl('https://example.com/huge.pdf');

    expect(saved.fetchFailed).toBe('pdf');
    const content = api.saveFromUrl.mock.calls[0][2].content;
    expect(content).toContain('this PDF');
    expect(content).not.toContain('extension');
  });

  it('saves the link with a Supporter note when the plan has no PDFs', async () => {
    extractArticle.mockRejectedValueOnce(
      new PdfExtractionError('Reading PDFs in Skyreader is a Supporter feature.', true)
    );

    const saved = await savesStore.saveFromUrl('https://example.com/paper.pdf');

    expect(saved.fetchFailed).toBe('pdfUpgrade');
    const content = api.saveFromUrl.mock.calls[0][2].content;
    expect(content).toContain('Supporter');
    expect(content).toContain('href="/supporter"');
    expect(content).not.toContain('extension');
  });

  it('names an EPUB it could not read, or one the plan has no room for', async () => {
    extractArticle.mockRejectedValueOnce(
      new PdfExtractionError('This EPUB is DRM-protected.', false, 'epub')
    );
    const unread = await savesStore.saveFromUrl('https://example.com/locked.epub');
    expect(unread.fetchFailed).toBe('epub');
    expect(api.saveFromUrl.mock.calls[0][2].content).toContain('this EPUB');

    extractArticle.mockRejectedValueOnce(
      new PdfExtractionError('Reading EPUBs in Skyreader is a Supporter feature.', true, 'epub')
    );
    const upsell = await savesStore.saveFromUrl('https://example.com/book.epub');
    expect(upsell.fetchFailed).toBe('epubUpgrade');
    const content = api.saveFromUrl.mock.calls[1][2].content;
    expect(content).toContain('Reading EPUBs');
    expect(content).toContain('href="/supporter"');
    expect(content).not.toContain('extension');
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

  it("sends the page's declared DOI with the save", async () => {
    extractArticle.mockResolvedValueOnce({
      title: 'A paper',
      author: null,
      description: null,
      content: '<p>paper text</p>',
      domain: 'example.org',
      image: null,
      published: null,
      wordCount: 2,
      doi: '10.1145/3290605.3300233',
    });
    api.saveFromUrl.mockClear();
    await savesStore.saveFromUrl('https://example.org/paper');
    expect(api.saveFromUrl.mock.calls[0][2].doi).toBe('10.1145/3290605.3300233');
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

  // A page that builds its text with scripts extracts fine, but to nothing.
  it('saves a note, not a blank page, when the page had no article text', async () => {
    extractArticle.mockResolvedValueOnce({
      title: 'The Dark Mode Toggle Discourse',
      author: null,
      description: 'How the discourse unfolded',
      content: '<body></body>',
      domain: 'attie.ai',
      image: null,
      published: null,
      wordCount: 0,
    });

    const saved = await savesStore.saveFromUrl('https://attie.ai/@a/pages/x');

    expect(saved.fetchFailed).toBe('empty');
    const meta = api.saveFromUrl.mock.calls[0][2];
    // What the page said about itself is kept; the note stands in for the text.
    expect(meta.title).toBe('The Dark Mode Toggle Discourse');
    expect(meta.description).toBe('How the discourse unfolded');
    expect(meta.wordCount).toBeUndefined();
    expect(meta.content).toContain("couldn't find the article text");
    expect(meta.content).toContain('Save this page');
  });

  it('replaces a save stored with nothing to read once the text can be found', async () => {
    savedRows.set('emptyemptyemp', {
      rkey: 'emptyemptyemp',
      uri: 'at://did:plc:me/app.skyreader.feed.saved/emptyemptyemp',
      url: 'https://example.com/blank',
      title: 'Blank',
      content: '<body></body>',
      savedAt: '2026-09-01T00:00:00.000Z',
      source: 'url',
    } as never);
    await savesStore.load();
    extractArticle.mockResolvedValueOnce({
      title: 'Blank',
      author: null,
      description: null,
      content: '<p>found the words this time</p>',
      domain: 'example.com',
      image: null,
      published: null,
      wordCount: 5,
    });

    const upgraded = await savesStore.saveFromUrl('https://example.com/blank');

    expect(upgraded.rkey).toBe('emptyemptyemp');
    expect(api.saveFromUrl.mock.calls[0][2].updateContent).toBe(true);
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

  // Saving from the open reader re-reads the body as the save appears, while
  // extraction is still running — that read must not pin the excerpt.
  it('serves the extracted body to a reader that opened before extraction landed', async () => {
    const excerpt = words(30);
    articleRows.push({ guid: 'post-2', subscriptionId: 7, content: excerpt });
    const extracted = words(900);
    let release!: (v: unknown) => void;
    extractArticle.mockReturnValueOnce(new Promise((r) => (release = r)));

    const pending = savesStore.saveArticle({
      url: 'https://news.example/p/open',
      guid: 'post-2',
      subscriptionId: 7,
    });
    await vi.waitFor(() => expect(savesStore.isSaved('post-2')).toBe(true));
    const rkey = savesStore.getByGuid('post-2')!.rkey;
    expect(await savesStore.getContent(rkey)).toBe(excerpt);

    release({ content: extracted, wordCount: 900, domain: 'x.com' });
    await pending;
    expect(await savesStore.getContent(rkey)).toBe(extracted);
  });

  it("doesn't cache an excerpt read that was in flight when extraction landed", async () => {
    const excerpt = words(30);
    articleRows.push({ guid: 'post-3', subscriptionId: 7, content: excerpt });
    let release!: (v: unknown) => void;
    extractArticle.mockReturnValueOnce(new Promise((r) => (release = r)));

    const pending = savesStore.saveArticle({
      url: 'https://news.example/p/race',
      guid: 'post-3',
      subscriptionId: 7,
    });
    await vi.waitFor(() => expect(savesStore.isSaved('post-3')).toBe(true));
    const rkey = savesStore.getByGuid('post-3')!.rkey;

    // A read that sees the optimistic row and only finishes after the save.
    const optimistic = savedRows.get(rkey);
    let finishRead!: () => void;
    const get = db.saved.get;
    db.saved.get = (() =>
      new Promise((r) => (finishRead = () => r(optimistic)))) as unknown as typeof db.saved.get;
    const inFlight = savesStore.getContent(rkey);
    db.saved.get = get;

    release({ content: words(900), wordCount: 900, domain: 'x.com' });
    await pending;
    finishRead();
    expect(await inFlight).toBe(excerpt);
    expect(await savesStore.getContent(rkey)).toBe(words(900));
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

  it('saves a newsletter with no web URL by its guid, without extracting', async () => {
    const body = words(40);
    articleRows.push({ guid: 'nl-6', subscriptionId: 7, content: body });

    const saved = await savesStore.saveArticle({ url: '', guid: 'nl-6', subscriptionId: 7 });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(api.saveFromUrl).toHaveBeenCalledWith(
      '',
      expect.any(String),
      expect.objectContaining({ fromFeed: true, itemGuid: 'nl-6', content: body })
    );
    expect(saved.uri).toMatch(/^at:\/\//);
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

describe('savesStore.saveFromUrl for a PDF', () => {
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

  it("carries the extractor's 'pdf' type to the server and the local copy", async () => {
    extractArticle.mockResolvedValueOnce({
      title: 'A Paper',
      author: null,
      description: null,
      content: '<section data-pdf-page="1"><p>Its text.</p></section>',
      domain: 'arxiv.org',
      image: null,
      published: null,
      wordCount: 2,
      contentType: 'pdf',
    });

    const saved = await savesStore.saveFromUrl('https://arxiv.org/pdf/1706.03762');

    expect(api.saveFromUrl.mock.calls[0][2].contentType).toBe('pdf');
    expect(saved.contentType).toBe('pdf');
  });

  it("keeps a web page typed 'webpage'", async () => {
    extractArticle.mockResolvedValueOnce({
      title: 'A Page',
      author: null,
      description: null,
      content: '<p>Text.</p>',
      domain: 'example.com',
      image: null,
      published: null,
      wordCount: 1,
    });

    const saved = await savesStore.saveFromUrl('https://example.com/page');

    expect(api.saveFromUrl.mock.calls[0][2].contentType).toBeUndefined();
    expect(saved.contentType).toBe('webpage');
  });
});

describe('savesStore.uploadFile', () => {
  const file = () => new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' });

  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    authState.isGuest = false;
    syncState.isOnline = true;
  });

  it('adds the upload, body and all, as a URL-less PDF save', async () => {
    api.uploadPdf.mockImplementationOnce(async (_file: File, rkey: string) => ({
      rkey,
      uri: `at://did:plc:me/app.skyreader.feed.saved/${rkey}`,
      url: '',
      title: 'A Paper',
      author: null,
      description: null,
      content: '<section data-pdf-page="1"><p>Its text.</p></section>',
      contentType: 'pdf',
      domain: null,
      image: null,
      wordCount: 2,
      publishedAt: null,
      savedAt: '2026-10-14T00:00:00.000Z',
      source: 'upload',
    }));

    const saved = await savesStore.uploadFile(file(), 'pdf');

    expect(api.uploadPdf.mock.calls[0][2]).toBe('paper.pdf');
    expect(saved).toMatchObject({ url: '', source: 'upload', contentType: 'pdf' });
    // The body is kept for the reader (and offline), the list copy stays light.
    expect(savedRows.get(saved.rkey)?.content).toContain('Its text.');
    expect(savesStore.articles.find((a) => a.rkey === saved.rkey)?.content).toBeNull();
  });

  it('answers the existing save when the same file is uploaded again', async () => {
    api.uploadPdf.mockImplementationOnce(async (_file: File, rkey: string) => ({
      rkey,
      uri: `at://did:plc:me/app.skyreader.feed.saved/${rkey}`,
      url: '',
      title: 'First',
      author: null,
      description: null,
      content: '<p>x</p>',
      contentType: 'pdf',
      domain: null,
      image: null,
      wordCount: 1,
      publishedAt: null,
      savedAt: '2026-10-14T00:00:00.000Z',
      source: 'upload',
    }));
    const first = await savesStore.uploadFile(file(), 'pdf');
    api.uploadPdf.mockRejectedValueOnce(
      new FileUploadError('This PDF is already saved.', 'already_saved', first.rkey)
    );

    const again = await savesStore.uploadFile(file(), 'pdf');

    expect(again.rkey).toBe(first.rkey);
  });

  it('needs a connection', async () => {
    syncState.isOnline = false;
    await expect(savesStore.uploadFile(file(), 'pdf')).rejects.toThrow('offline');
    expect(api.uploadPdf).not.toHaveBeenCalled();
  });

  it('sends an EPUB to its own route and types the save as one', async () => {
    api.uploadEpub.mockImplementationOnce(async (_file: File, rkey: string) => ({
      rkey,
      uri: `at://did:plc:me/app.skyreader.feed.saved/${rkey}`,
      url: '',
      title: 'A Book',
      author: 'Someone',
      description: null,
      content: '<section data-epub-chapter="1"><p>Chapter one.</p></section>',
      contentType: 'epub',
      domain: null,
      image: null,
      wordCount: 2,
      publishedAt: null,
      savedAt: '2026-10-14T00:00:00.000Z',
      source: 'upload',
    }));
    const book = new File(['PK'], 'book.epub', { type: 'application/epub+zip' });

    const saved = await savesStore.uploadFile(book, 'epub');

    expect(api.uploadPdf).not.toHaveBeenCalled();
    expect(api.uploadEpub.mock.calls[0][2]).toBe('book.epub');
    expect(saved).toMatchObject({ source: 'upload', contentType: 'epub' });
  });
});

// A feed save with no body of its own (saved offline, or the stored-body read
// failed at save time) opened as a `'saved'` row — from Home, say — used to
// show only its description, while the Saved list, which renders it as its
// feed article, fell back to the feed's body. getContent now falls back too.
describe('savesStore.getContent for a feed save with no body', () => {
  const baseSave: SavedItem = {
    rkey: 'nobody1',
    uri: 'at://did:plc:me/app.skyreader.feed.saved/nobody1',
    url: '',
    title: 'Weekly letter',
    author: null,
    description: 'Preview text',
    content: null,
    contentType: 'article',
    domain: null,
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: new Date().toISOString(),
    source: 'feed',
    itemGuid: 'nl-guid',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    articleRows.length = 0;
    authState.isGuest = false;
    syncState.isOnline = true;
    api.getSavedBodies.mockResolvedValue({ bodies: { [baseSave.rkey]: null } });
  });

  it("reads the feed item's archived body when the save has none", async () => {
    savedRows.set(baseSave.rkey, { ...baseSave });
    articleRows.push({
      id: 9,
      guid: 'nl-guid',
      subscriptionId: 7,
      content: null,
      contentTruncated: true,
    });
    loadStoredBody.mockResolvedValueOnce({ status: 'found', content: '<p>Full letter</p>' });

    expect(await savesStore.getContent(baseSave.rkey)).toBe('<p>Full letter</p>');
    expect(loadStoredBody).toHaveBeenCalledWith(
      { id: 9, guid: 'nl-guid', subscriptionId: 7 },
      'https://news.example/feed',
      { guest: false }
    );
  });

  it("uses the feed item's local body offline", async () => {
    syncState.isOnline = false;
    savedRows.set('nobody2', { ...baseSave, rkey: 'nobody2' });
    articleRows.push({ guid: 'nl-guid', subscriptionId: 7, content: '<p>Local body</p>' });

    expect(await savesStore.getContent('nobody2')).toBe('<p>Local body</p>');
    expect(api.getSavedBodies).not.toHaveBeenCalled();
  });

  it('keeps an empty body when the feed item is gone', async () => {
    savedRows.set('nobody3', { ...baseSave, rkey: 'nobody3', content: '' });
    api.getSavedBodies.mockResolvedValue({ bodies: {} });

    expect(await savesStore.getContent('nobody3')).toBe('');
  });
});

describe('savesStore for a standard.site document save', () => {
  const docUri = 'at://did:plc:author/site.standard.document/3abc';
  const baseSave: SavedItem = {
    rkey: 'doc1',
    uri: '',
    url: 'https://author.example/collections',
    title: 'A proposal',
    author: null,
    description: 'The working explainer.',
    content: null,
    contentType: 'document',
    domain: null,
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: new Date().toISOString(),
    source: 'document',
    itemGuid: docUri,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    savedRows.clear();
    authState.isGuest = false;
    syncState.isOnline = true;
    api.getSavedBodies.mockResolvedValue({ bodies: { [baseSave.rkey]: null } });
  });

  it('renders a body-less save from its record when the reader opens it, and keeps it', async () => {
    savedRows.set(baseSave.rkey, { ...baseSave });
    documentBody.mockResolvedValueOnce('<p>The whole proposal</p>');

    expect(await savesStore.getContent(baseSave.rkey, { opening: true })).toBe(
      '<p>The whole proposal</p>'
    );
    expect(documentBody).toHaveBeenCalledWith(docUri);
    expect(savedRows.get(baseSave.rkey)?.content).toBe('<p>The whole proposal</p>');
    expect(savedRows.get(baseSave.rkey)?.wordCount).toBe(3);
  });

  it("doesn't fetch the record for a card that only reads the body", async () => {
    savedRows.set('doc2', { ...baseSave, rkey: 'doc2' });

    await savesStore.getContent('doc2');
    expect(documentBody).not.toHaveBeenCalled();
  });

  it('saves a document from a list with the body rendered from its record', async () => {
    documentBody.mockResolvedValueOnce('<p>The whole proposal</p>');
    api.saveFromUrl.mockResolvedValueOnce({ uri: '', rkey: 'server1' });

    const saved = await savesStore.saveDocument({
      recordUri: docUri,
      url: baseSave.url,
      title: baseSave.title!,
      description: baseSave.description!,
    });

    expect(api.saveFromUrl).toHaveBeenCalledWith(
      baseSave.url,
      expect.any(String),
      expect.objectContaining({ content: '<p>The whole proposal</p>' })
    );
    expect(saved.content).toBe('<p>The whole proposal</p>');
    expect(savedRows.get('server1')?.content).toBe('<p>The whole proposal</p>');
  });

  it('leaves a document unsaved while its record was being fetched', async () => {
    let finish: (body: string) => void = () => {};
    documentBody.mockImplementationOnce(() => new Promise((r) => (finish = r)));

    const saving = savesStore.saveDocument({ recordUri: docUri, url: baseSave.url });
    await vi.waitFor(() => expect(documentBody).toHaveBeenCalled());
    const rkey = savesStore.articles.find((a) => a.itemGuid === docUri)!.rkey;
    await savesStore.remove(rkey);
    finish('<p>The whole proposal</p>');
    await saving;

    expect(api.saveFromUrl).not.toHaveBeenCalled();
    expect(savedRows.has(rkey)).toBe(false);
  });
});
