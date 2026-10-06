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
  contentLead?: string;
  contentTruncated?: boolean;
  url?: string;
}> = [];
// Subscriptions only IndexedDB has — the store hasn't hydrated them yet.
const dbOnlySubscriptions = new Map<number, Record<string, unknown>>();

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
    subscriptions: {
      get: async (id: number) => dbOnlySubscriptions.get(id),
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
    getById: (id: number) =>
      id === 7
        ? { id, feedUrl: 'https://news.example/feed' }
        : id === 8
          ? {
              id,
              feedUrl: 'newsletter:inbox1/editor@letter.example',
              sourceType: 'email.newsletter',
            }
          : undefined,
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

  it('never extracts an emailed newsletter, even when the web copy is longer', async () => {
    // A free/paid split: the web page is a different (longer) cut, so a length
    // test would pick it. The mail is the article.
    const mail = words(400);
    articleRows.push({ guid: 'mail-1', subscriptionId: 8, content: mail });
    extractArticle.mockResolvedValueOnce({ content: words(900), wordCount: 900, domain: 'x.com' });

    const saved = await savesStore.saveArticle({
      url: 'https://letter.example/p/issue',
      guid: 'mail-1',
      subscriptionId: 8,
    });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(saved.content).toBe(`<div class="sr-email-body">${mail}</div>`);
    expect(api.saveFromUrl).toHaveBeenCalledWith(
      'https://letter.example/p/issue',
      expect.any(String),
      expect.objectContaining({ content: `<div class="sr-email-body">${mail}</div>` })
    );
  });

  it("saves a newsletter's out-of-row body without extracting", async () => {
    const mail = words(3000);
    articleRows.push({
      id: 9,
      guid: 'mail-2',
      subscriptionId: 8,
      content: null,
      contentTruncated: true,
    });
    loadStoredBody.mockResolvedValueOnce({ status: 'found', content: mail });

    const saved = await savesStore.saveArticle({
      url: 'https://letter.example/p/long',
      guid: 'mail-2',
      subscriptionId: 8,
    });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(saved.content).toBe(`<div class="sr-email-body">${mail}</div>`);
  });

  it('treats a newsletter as one before the subscriptions store has hydrated', async () => {
    // A save from a cold `?read=` deep link: only IndexedDB knows the source.
    dbOnlySubscriptions.set(9, {
      id: 9,
      feedUrl: 'newsletter:inbox1/late@letter.example',
      sourceType: 'email.newsletter',
    });
    const mail = words(300);
    articleRows.push({ guid: 'mail-3', subscriptionId: 9, content: mail });

    const saved = await savesStore.saveArticle({
      url: 'https://letter.example/p/cold',
      guid: 'mail-3',
      subscriptionId: 9,
    });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(saved.content).toBe(`<div class="sr-email-body">${mail}</div>`);
    dbOnlySubscriptions.clear();
  });

  it('escapes a plain-text summary standing in for a newsletter body', async () => {
    articleRows.push({
      id: 12,
      guid: 'mail-7',
      subscriptionId: 8,
      content: null,
      contentTruncated: false,
    });

    const saved = await savesStore.saveArticle({
      url: 'https://letter.example/p/rates',
      guid: 'mail-7',
      subscriptionId: 8,
      summary: 'Rates < 5% & rising',
    });

    expect(saved.content).toBe(
      '<div class="sr-email-body sr-email-lead"><p>Rates &lt; 5% &amp; rising</p></div>'
    );
  });

  it('wraps a newsletter save from before saves carried the scope, once', async () => {
    articleRows.push({
      guid: 'mail-8',
      subscriptionId: 8,
      url: 'https://letter.example/p/old',
      content: '<p>Old issue.</p>',
    } as (typeof articleRows)[number]);
    // Another feed's item under the same guid: not this save's source.
    articleRows.push({
      guid: 'shared-guid',
      subscriptionId: 8,
      url: 'https://letter.example/p/other',
      content: '<p>x</p>',
    } as (typeof articleRows)[number]);
    const base = {
      uri: '',
      title: null,
      author: null,
      description: null,
      contentType: 'article',
      domain: null,
      image: null,
      wordCount: null,
      publishedAt: null,
      savedAt: '2026-08-01T00:00:00.000Z',
      source: 'feed',
    } as const;
    savedRows.set('3kolddddddddd', {
      ...base,
      rkey: '3kolddddddddd',
      url: 'https://letter.example/p/old',
      content: '<p>Old issue.</p>',
      itemGuid: 'mail-8',
    });
    savedRows.set('3kblogggggggg', {
      ...base,
      rkey: '3kblogggggggg',
      url: 'https://blog.example/post',
      content: '<p>A post.</p>',
      itemGuid: 'shared-guid',
    });

    const wrapped = '<div class="sr-email-body"><p>Old issue.</p></div>';
    expect(await savesStore.getContent('3kolddddddddd')).toBe(wrapped);
    // Written back, so the lookup isn't repeated.
    expect(savedRows.get('3kolddddddddd')?.content).toBe(wrapped);
    // A guid match on a different link isn't this save's source.
    expect(await savesStore.getContent('3kblogggggggg')).toBe('<p>A post.</p>');
  });

  it("saves a newsletter's lead, never no body, when its mail is unavailable", async () => {
    // A save with no body is one a backed (Semble/Margin) account's backend
    // fills by extracting the web copy.
    articleRows.push({
      id: 10,
      guid: 'mail-4',
      subscriptionId: 8,
      content: null,
      contentLead: '<p>The opening.</p>',
      contentTruncated: true,
    });
    loadStoredBody.mockResolvedValueOnce({ status: 'unavailable' });

    const saved = await savesStore.saveArticle({
      url: 'https://letter.example/p/gone',
      guid: 'mail-4',
      subscriptionId: 8,
    });

    expect(extractArticle).not.toHaveBeenCalled();
    const lead = '<div class="sr-email-body sr-email-lead"><p>The opening.</p></div>';
    expect(saved.content).toBe(lead);
    expect(api.saveFromUrl).toHaveBeenCalledWith(
      'https://letter.example/p/gone',
      expect.any(String),
      expect.objectContaining({ content: lead })
    );
  });

  it("recovers a lead-only newsletter save's mail when the reader opens it", async () => {
    const mail = words(3000);
    articleRows.push({
      id: 11,
      guid: 'mail-6',
      subscriptionId: 8,
      content: null,
      contentLead: '<p>The opening.</p>',
      contentTruncated: true,
    });
    loadStoredBody.mockResolvedValueOnce({ status: 'unavailable' });
    const saved = await savesStore.saveArticle({
      url: 'https://letter.example/p/later',
      guid: 'mail-6',
      subscriptionId: 8,
    });
    api.saveFromUrl.mockClear();

    // Still unreachable: the lead stays, and isn't cached against a retry.
    // Callers asking at once (reader + daily page) share the one attempt.
    loadStoredBody.mockClear();
    loadStoredBody.mockResolvedValueOnce({ status: 'unavailable' });
    const [a, b] = await Promise.all([
      savesStore.getContent(saved.rkey),
      savesStore.getContent(saved.rkey),
    ]);
    expect(a).toBe(saved.content);
    expect(b).toBe(saved.content);
    expect(loadStoredBody).toHaveBeenCalledTimes(1);

    // Renders in the meantime don't each go back to the archive.
    expect(await savesStore.getContent(saved.rkey)).toBe(saved.content);
    expect(loadStoredBody).toHaveBeenCalledTimes(1);

    // After the cooldown it asks again.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    loadStoredBody.mockResolvedValueOnce({ status: 'found', content: mail });
    const body = `<div class="sr-email-body">${mail}</div>`;
    expect(await savesStore.getContent(saved.rkey)).toBe(body);
    clock.mockRestore();
    expect(savedRows.get(saved.rkey)?.content).toBe(body);
    expect(savedRows.get(saved.rkey)?.wordCount).toBeGreaterThan(2900);
    expect(api.saveFromUrl).toHaveBeenCalledWith(
      'https://letter.example/p/later',
      saved.rkey,
      expect.objectContaining({ content: body, itemGuid: 'mail-6', updateContent: true })
    );
    expect(extractArticle).not.toHaveBeenCalled();
  });

  it('re-saves a held newsletter body without extracting (undo of an Unsave)', async () => {
    // The feed row is gone; the body the reader held is all there is.
    const held = `<div class="sr-email-body">${words(500)}</div>`;

    const saved = await savesStore.saveArticle({
      url: 'https://letter.example/p/undo',
      guid: 'mail-5',
      content: held,
    });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(saved.content).toBe(held);
  });

  it('restores a held body as it was, even one from before newsletters were marked', async () => {
    // An older newsletter save carries no wrapper and its feed row is gone, so
    // nothing says it's a newsletter; the undo still mustn't swap in the web copy.
    const held = words(500);
    extractArticle.mockResolvedValueOnce({ content: words(900), wordCount: 900, domain: 'x.com' });

    const saved = await savesStore.saveArticle({
      url: 'https://letter.example/p/old',
      guid: 'mail-7',
      content: held,
    });

    expect(extractArticle).not.toHaveBeenCalled();
    expect(loadStoredBody).not.toHaveBeenCalled();
    expect(saved.content).toBe(held);
  });
});
