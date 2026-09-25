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

const { loadStoredBody } = await import('./itemBody');
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

    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: false })).toBe(
      '<p>full</p>'
    );
    expect(fetchItemBody).toHaveBeenCalledWith('https://feed.example/rss', a.guid, {
      guest: false,
    });
    expect(rows.get(a.id!)?.content).toBe('<p>full</p>');
  });

  it('remembers a 404 for the session', async () => {
    const a = article();
    fetchItemBody.mockRejectedValueOnce(new ApiError('Not found', 404));

    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: true })).toBeNull();
    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: true })).toBeNull();
    expect(fetchItemBody).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('retries after a transient failure', async () => {
    const a = article();
    fetchItemBody.mockRejectedValueOnce(new Error('offline'));
    fetchItemBody.mockResolvedValueOnce({ content: '<p>later</p>' });

    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: false })).toBeNull();
    expect(await loadStoredBody(a, 'https://feed.example/rss', { guest: false })).toBe(
      '<p>later</p>'
    );
  });

  it('shares one request between concurrent callers', async () => {
    const a = article();
    fetchItemBody.mockResolvedValueOnce({ content: '<p>once</p>' });

    const [first, second] = await Promise.all([
      loadStoredBody(a, 'https://feed.example/rss', { guest: false }),
      loadStoredBody(a, 'https://feed.example/rss', { guest: false }),
    ]);
    expect(first).toBe('<p>once</p>');
    expect(second).toBe('<p>once</p>');
    expect(fetchItemBody).toHaveBeenCalledTimes(1);
  });
});
