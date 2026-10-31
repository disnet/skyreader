// The Library's bulk delete queues every delete before sending any, so one a
// refresh cuts short finishes from the queue. A delete the server no longer has
// (sent, then cut off before its entry was cleared) is done, not failed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncQueueEntry } from './db';

let rows: SyncQueueEntry[] = [];
let nextId = 1;

function collection(match: (entry: SyncQueueEntry) => boolean) {
  return {
    toArray: async () => rows.filter(match),
    sortBy: async (field: keyof SyncQueueEntry) =>
      rows.filter(match).sort((a, b) => Number(a[field]) - Number(b[field])),
    first: async () => rows.find(match),
    count: async () => rows.filter(match).length,
  };
}

vi.mock('./db', () => ({
  db: {
    transaction: async (_mode: string, _table: unknown, fn: () => Promise<void>) => fn(),
    syncQueue: {
      where: (index: string) => ({
        equals: (value: unknown) =>
          collection((entry) => {
            if (index === '[collection+key]') {
              const [c, k] = value as [string, string];
              return entry.collection === c && entry.key === k;
            }
            return (entry as unknown as Record<string, unknown>)[index] === value;
          }),
      }),
      add: async (entry: SyncQueueEntry) => {
        rows.push({ ...entry, id: nextId });
        return nextId++;
      },
      update: async (id: number, changes: Partial<SyncQueueEntry>) => {
        const row = rows.find((entry) => entry.id === id);
        if (row) Object.assign(row, changes);
        return row ? 1 : 0;
      },
      delete: async (id: number) => {
        rows = rows.filter((entry) => entry.id !== id);
      },
      bulkDelete: async (ids: number[]) => {
        rows = rows.filter((entry) => !ids.includes(entry.id!));
      },
      bulkUpdate: async (changes: { key: number; changes: Partial<SyncQueueEntry> }[]) => {
        for (const { key, changes: c } of changes) {
          const row = rows.find((entry) => entry.id === key);
          if (row) Object.assign(row, c);
        }
      },
    },
  },
}));

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
const api = {
  deleteSaved: vi.fn(),
  deleteSavedByGuid: vi.fn(),
  deleteSavedMany: vi.fn(),
  saveFromUrl: vi.fn(),
};
class RateLimitError extends Error {}
vi.mock('./api', () => ({ api, ApiError, RateLimitError }));

const { syncQueue } = await import('./sync-queue');

const save = (rkey: string) => ({ rkey, url: `https://example.com/${rkey}` });

describe('sync queue: bulk saved deletes', () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
    vi.clearAllMocks();
  });

  it('queues one delete per save and returns the ones to send', async () => {
    const sent = await syncQueue.enqueueSavedDeletes([
      save('aaaaaaaaaaaa1'),
      save('aaaaaaaaaaaa2'),
    ]);

    expect(sent).toEqual(['aaaaaaaaaaaa1', 'aaaaaaaaaaaa2']);
    expect(rows.map((r) => [r.operation, r.key, r.status])).toEqual([
      ['delete', 'aaaaaaaaaaaa1', 'pending'],
      ['delete', 'aaaaaaaaaaaa2', 'pending'],
    ]);
  });

  it('drops a save whose create never left the queue, rather than sending it', async () => {
    await syncQueue.enqueue('create', 'saved', 'aaaaaaaaaaaa1', save('aaaaaaaaaaaa1'));

    const sent = await syncQueue.enqueueSavedDeletes([
      save('aaaaaaaaaaaa1'),
      save('aaaaaaaaaaaa2'),
    ]);

    expect(sent).toEqual(['aaaaaaaaaaaa2']);
    expect(rows.map((r) => r.key)).toEqual(['aaaaaaaaaaaa2']);
  });

  it('clears the deletes the server confirmed, and only those', async () => {
    await syncQueue.enqueueSavedDeletes([save('aaaaaaaaaaaa1'), save('aaaaaaaaaaaa2')]);

    await syncQueue.clearSavedDeletes(['aaaaaaaaaaaa1']);

    expect(rows.map((r) => r.key)).toEqual(['aaaaaaaaaaaa2']);
  });

  it('drops a feed save’s queued create and edits, which are keyed by its guid', async () => {
    await syncQueue.enqueue('create', 'saved', 'feed-guid', save('aaaaaaaaaaaa1'));
    await syncQueue.enqueue('update', 'saved', 'other-guid', {
      ...save('aaaaaaaaaaaa2'),
      metadata: { title: 'Mine' },
    });

    const sent = await syncQueue.enqueueSavedDeletes([
      save('aaaaaaaaaaaa1'),
      save('aaaaaaaaaaaa2'),
    ]);

    // The unsent save needs nothing sent; the edit of the sent one is superseded.
    expect(sent).toEqual(['aaaaaaaaaaaa2']);
    expect(rows.map((r) => [r.operation, r.key])).toEqual([['delete', 'aaaaaaaaaaaa2']]);
  });

  it('sends queued deletes in one bulk request, before a later re-save', async () => {
    const order: string[] = [];
    api.saveFromUrl.mockImplementation(async () => {
      order.push('create');
      return {};
    });
    api.deleteSavedMany.mockImplementation(async (rkeys: string[]) => {
      order.push(`delete ${rkeys.join(',')}`);
      return { deleted: rkeys.length };
    });
    await syncQueue.enqueueSavedDeletes([save('aaaaaaaaaaaa1'), save('aaaaaaaaaaaa2')]);
    // The same article saved again, under a new rkey.
    await syncQueue.enqueue('create', 'saved', 'some-guid', save('aaaaaaaaaaaa3'));

    const result = await syncQueue.processQueue();

    expect(order).toEqual(['delete aaaaaaaaaaaa1,aaaaaaaaaaaa2', 'create']);
    expect(result).toEqual({ processed: 3, failed: 0 });
    expect(rows).toHaveLength(0);
  });

  it('a delete that failed for good no longer hides its save', async () => {
    await syncQueue.enqueueSavedDeletes([save('aaaaaaaaaaaa1'), save('aaaaaaaaaaaa2')]);
    rows[0].status = 'failed';

    expect([...(await syncQueue.pendingSavedRkeys('delete'))]).toEqual(['aaaaaaaaaaaa2']);
  });

  it('a bulk delete that cannot reach the server stays queued', async () => {
    await syncQueue.enqueueSavedDeletes([save('aaaaaaaaaaaa1'), save('aaaaaaaaaaaa2')]);
    api.deleteSavedMany.mockRejectedValueOnce(new Error('Failed to fetch'));

    await syncQueue.processQueue();

    // Pending, not stuck 'processing': the next sync sends them again.
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('a queued delete the server no longer has is done', async () => {
    await syncQueue.enqueue('delete', 'saved', 'a-guid', {
      ...save('aaaaaaaaaaaa1'),
      itemGuid: 'a-guid',
    });
    api.deleteSavedByGuid.mockRejectedValueOnce(new ApiError('Not found', 404));

    const result = await syncQueue.processQueue();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(rows).toHaveLength(0);
  });
});
