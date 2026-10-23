// A save's metadata edits made offline accumulate in the queue: a second edit
// (of another field) must not drop the first, and an edit of a save that hasn't
// synced yet rides on its create rather than replacing the create's payload.
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
    },
  },
}));

const api = { saveFromUrl: vi.fn(), updateSaved: vi.fn() };
vi.mock('./api', () => ({ api }));

const { syncQueue } = await import('./sync-queue');

const RKEY = 'aaaaaaaaaaaaa';
const payloadOf = (entry: SyncQueueEntry) => JSON.parse(entry.payload);

describe('sync queue: saved metadata edits', () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
  });

  it('merges a second edit into the first', async () => {
    await syncQueue.enqueue('update', 'saved', RKEY, {
      rkey: RKEY,
      url: 'https://example.com/a',
      metadata: { title: 'Mine' },
    });
    await syncQueue.enqueue('update', 'saved', RKEY, {
      rkey: RKEY,
      url: 'https://example.com/a',
      metadata: { author: 'Me', title: 'Mine, again' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('update');
    expect(payloadOf(rows[0]).metadata).toEqual({ title: 'Mine, again', author: 'Me' });
  });

  it('keeps a pending create, with the edit riding on it', async () => {
    await syncQueue.enqueue('create', 'saved', RKEY, {
      rkey: RKEY,
      url: 'https://example.com/a',
      title: 'Extracted',
      content: '<p>Body</p>',
    });
    await syncQueue.enqueue('update', 'saved', RKEY, {
      rkey: RKEY,
      url: 'https://example.com/a',
      metadata: { title: 'Mine' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('create');
    expect(payloadOf(rows[0])).toMatchObject({
      url: 'https://example.com/a',
      content: '<p>Body</p>',
      metadata: { title: 'Mine' },
    });
  });

  it('keeps an edit whose PATCH fails after its create landed, as an update', async () => {
    api.saveFromUrl.mockResolvedValue({ rkey: 'bbbbbbbbbbbbb' });
    api.updateSaved.mockRejectedValue(new TypeError('Failed to fetch'));
    await syncQueue.enqueue('create', 'saved', 'guid-1', {
      rkey: RKEY,
      url: 'https://example.com/a',
      metadata: { title: 'Mine' },
    });

    await syncQueue.processQueue();

    expect(api.updateSaved).toHaveBeenCalledWith('bbbbbbbbbbbbb', { title: 'Mine' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'update', key: 'bbbbbbbbbbbbb' });
    expect(payloadOf(rows[0]).metadata).toEqual({ title: 'Mine' });
  });
});
