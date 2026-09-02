// A write that outlived its session is PARKED, not replayed: clearAllData marks
// the queue 'held' against the departing DID so an involuntary logout stops
// destroying unsynced highlights, saves and read positions (see db.ts). Held
// entries must then be invisible to the live library — otherwise the previous
// account's writes merge into a guest's, or shield rows from a snapshot
// replace, which is exactly the leak the hold was meant to avoid.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncQueueEntry } from './db';

let rows: SyncQueueEntry[] = [];
let nextId = 1;

function collection(match: (entry: SyncQueueEntry) => boolean) {
  return {
    toArray: async () => rows.filter(match),
    first: async () => rows.find(match),
    count: async () => rows.filter(match).length,
    sortBy: async (field: keyof SyncQueueEntry) =>
      rows.filter(match).sort((a, b) => Number(a[field]) - Number(b[field])),
    delete: async () => {
      rows = rows.filter((entry) => !match(entry));
    },
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

vi.mock('./api', () => ({ api: {} }));

const { syncQueue } = await import('./sync-queue');

function held(overrides: Partial<SyncQueueEntry> = {}): SyncQueueEntry {
  return {
    id: nextId++,
    operation: 'create',
    collection: 'label',
    key: 'article:1 highlights',
    payload: JSON.stringify({ itemKey: 'article:1', label: 'highlights' }),
    timestamp: 1,
    retryCount: 0,
    status: 'held',
    owner: 'did:plc:previous',
    ...overrides,
  };
}

describe('sync queue held entries', () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
  });

  it('queues alongside a held entry instead of merging into it', async () => {
    rows.push(held());

    await syncQueue.enqueue('create', 'label', 'article:1 highlights', {
      itemKey: 'article:1',
      itemType: 'article',
      label: 'highlights',
      props: { highlights: [{ id: 'mine' }] },
    });

    expect(rows).toHaveLength(2);
    // The previous account's write is untouched and still parked.
    expect(rows[0]).toMatchObject({ status: 'held', owner: 'did:plc:previous' });
    expect(rows[1]).toMatchObject({ status: 'pending' });
    expect(rows[1].owner).toBeUndefined();
  });

  it('does not cancel a held entry', async () => {
    rows.push(held());

    await syncQueue.cancelPending('label', 'article:1 highlights');

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('held');
  });

  it('leaves held saves out of the pending set a snapshot replace protects', async () => {
    rows.push(
      held({ collection: 'saved', key: 'r1', payload: JSON.stringify({ rkey: 'r1' }) }),
      held({
        collection: 'saved',
        key: 'r2',
        payload: JSON.stringify({ rkey: 'r2' }),
        status: 'pending',
        owner: undefined,
      })
    );

    expect(await syncQueue.pendingSavedRkeys()).toEqual(new Set(['r2']));
  });
});
