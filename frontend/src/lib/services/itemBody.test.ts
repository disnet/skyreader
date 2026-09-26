// A long archive item's body is fetched from out-of-row storage when it's opened,
// ahead of extraction. The contract the reader relies on: a hit is written into
// the IndexedDB row (so the next open and offline reading need no network), a
// 404 is remembered for the session, and a transient failure is not.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '$lib/types';

const rows = new Map<number, Partial<Article>>();
const update = vi.fn(async (id: number, changes: Partial<Article>) => {
  rows.set(id, { ...rows.get(id), ...changes });
});

vi.mock('./db', () => ({
  db: {
    articles: {
      get: async (id: number) => rows.get(id),
      update: (id: number, changes: Partial<Article>) => update(id, changes),
      where: () => ({ equals: () => ({ filter: () => ({ first: async () => undefined }) }) }),
    },
  },
}));

const fetchItemBody = vi.fn();
vi.mock('./api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
    }
  }
  return { api: { fetchItemBody: (...args: unknown[]) => fetchItemBody(...args) }, ApiError };
});

const { loadStoredBody, prefetchStoredBody, resetPrefetchForTests } = await import('./itemBody');
const { ApiError } = await import('./api');

let n = 0;
function article(): Pick<Article, 'id' | 'guid' | 'subscriptionId'> {
  n++;
  rows.set(n, { id: n, guid: `g${n}`, subscriptionId: 1 });
  return { id: n, guid: `g${n}`, subscriptionId: 1 };
}

describe('loadStoredBody', () => {
  beforeEach(() => {
    fetchItemBody.mockReset();
    update.mockClear();
  });

  it('returns the stored body and caches it into the article row', async () => {
    const a = article();
    fetchItemBody.mockResolvedValueOnce({ content: '<p>full</p>' });

    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: false })).toEqual({
      status: 'found',
      content: '<p>full</p>',
    });
    expect(fetchItemBody).toHaveBeenCalledWith('https://feed.example/rss', a.guid, {
      guest: false,
    });
    expect(rows.get(a.id!)?.content).toBe('<p>full</p>');
  });

  it('remembers a 404 for the session', async () => {
    const a = article();
    fetchItemBody.mockRejectedValueOnce(new ApiError('Not found', 404));

    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: true })).toEqual({
      status: 'missing',
    });
    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: true })).toEqual({
      status: 'missing',
    });
    expect(fetchItemBody).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('retries after a transient failure', async () => {
    const a = article();
    fetchItemBody.mockRejectedValueOnce(new Error('offline'));
    fetchItemBody.mockResolvedValueOnce({ content: '<p>later</p>' });

    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: false })).toEqual({
      status: 'unavailable',
    });
    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: false })).toEqual({
      status: 'found',
      content: '<p>later</p>',
    });
  });

  it('reports a server error as unavailable, not missing', async () => {
    const a = article();
    fetchItemBody.mockRejectedValueOnce(new ApiError('Too many requests', 429));
    fetchItemBody.mockResolvedValueOnce({ content: '<p>after</p>' });

    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: true })).toEqual({
      status: 'unavailable',
    });
    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: true })).toEqual({
      status: 'found',
      content: '<p>after</p>',
    });
  });

  it('shares one request between concurrent callers', async () => {
    const a = article();
    fetchItemBody.mockResolvedValueOnce({ content: '<p>once</p>' });

    const [first, second] = await Promise.all([
      loadStoredBody(a, 'https://feed.example/rss', { guest: false }),
      loadStoredBody(a, 'https://feed.example/rss', { guest: false }),
    ]);
    expect(first).toEqual({ status: 'found', content: '<p>once</p>' });
    expect(second).toEqual(first);
    expect(fetchItemBody).toHaveBeenCalledTimes(1);
  });
});

describe('prefetchStoredBody', () => {
  beforeEach(() => {
    fetchItemBody.mockReset();
    update.mockClear();
    resetPrefetchForTests();
  });

  it('warms the row so the open that follows needs no request', async () => {
    const a = article();
    fetchItemBody.mockResolvedValueOnce({ content: '<p>ahead</p>' });

    expect(await prefetchStoredBody(a, 'https://feed.example/rss', { guest: false })).toBe('found');
    expect(rows.get(a.id!)?.content).toBe('<p>ahead</p>');
    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: false })).toEqual({
      status: 'found',
      content: '<p>ahead</p>',
    });
    expect(fetchItemBody).toHaveBeenCalledTimes(1);
  });

  it('holds a body with no row to live in until the open', async () => {
    const orphan = { id: undefined, guid: 'no-row', subscriptionId: 9 };
    fetchItemBody.mockResolvedValueOnce({ content: '<p>guest</p>' });

    expect(await prefetchStoredBody(orphan, 'https://feed.example/rss', { guest: true })).toBe(
      'found'
    );
    expect(await loadStoredBody(orphan, 'https://feed.example/rss', { guest: true })).toEqual({
      status: 'found',
      content: '<p>guest</p>',
    });
    expect(fetchItemBody).toHaveBeenCalledTimes(1);
  });

  it('runs at most two at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchItemBody.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { content: '<p>x</p>' };
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        prefetchStoredBody(article(), 'https://feed.example/rss', { guest: false })
      )
    );
    expect(results).toEqual(Array(6).fill('found'));
    expect(peak).toBe(2);
  });

  it('pauses after a failure instead of hammering the endpoint', async () => {
    fetchItemBody.mockRejectedValueOnce(new ApiError('Too many requests', 429));

    expect(await prefetchStoredBody(article(), 'https://feed.example/rss', { guest: true })).toBe(
      'unavailable'
    );
    expect(await prefetchStoredBody(article(), 'https://feed.example/rss', { guest: true })).toBe(
      'skipped'
    );
    expect(fetchItemBody).toHaveBeenCalledTimes(1);
  });
});
