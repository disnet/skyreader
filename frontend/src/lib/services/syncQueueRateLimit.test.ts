// A write refused for a rate limit (the reader's PDS behind a Margin note, say)
// waits for the limit to reset instead of spending its retries against it.
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

class ApiError extends Error {}
class RateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super(`Rate limit exceeded. Try again in ${retryAfter} seconds.`);
  }
}
const api = { deleteMarginNote: vi.fn() };
vi.mock('./api', () => ({ api, ApiError, RateLimitError }));
vi.mock('$lib/stores/marginPublishQueue.svelte', () => ({
  marginPublishQueue: { add: vi.fn(), delete: vi.fn(), has: vi.fn() },
}));

const { syncQueue } = await import('./sync-queue');

const note = (rkey: string) => ({
  kind: 'note' as const,
  itemKey: 'item',
  highlightId: rkey,
  source: 'https://example.com/a',
  exact: 'a quote',
  rkey,
});

describe('sync queue: rate limits', () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
    vi.clearAllMocks();
  });

  it("waits out a rate limit without counting it, and holds the collection's other writes", async () => {
    await syncQueue.enqueue('delete', 'integration', 'a', note('3aaa'));
    await syncQueue.enqueue('delete', 'integration', 'b', note('3bbb'));
    api.deleteMarginNote.mockRejectedValueOnce(new RateLimitError(1200));

    const before = Date.now();
    const result = await syncQueue.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0 });
    // Only the first was asked; the second waits for the same reset.
    expect(api.deleteMarginNote).toHaveBeenCalledTimes(1);
    for (const row of rows) {
      expect(row.status).toBe('pending');
      expect(row.retryCount).toBe(0);
      expect(row.retryAt).toBeGreaterThanOrEqual(before + 1_200_000);
    }
    expect(await syncQueue.nextRetryAt()).toBe(rows[0].retryAt);

    // Not before then.
    await syncQueue.processQueue();
    expect(api.deleteMarginNote).toHaveBeenCalledTimes(1);

    // Once it has passed, both go.
    for (const row of rows) row.retryAt = Date.now() - 1;
    api.deleteMarginNote.mockResolvedValue(undefined);
    expect(await syncQueue.processQueue()).toEqual({ processed: 2, failed: 0 });
    expect(rows).toHaveLength(0);
  });
});
