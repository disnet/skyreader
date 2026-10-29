import { describe, expect, it, vi } from 'vitest';
import { importOrder, placeInQueue, runImport, IMPORT_BATCH_SIZE } from './run';
import type { ImportedSave } from './parsers';

const save = (n: number, over: Partial<ImportedSave> = {}): ImportedSave => ({
  source: 'pocket',
  url: `https://example.com/${n}`,
  savedAt: n,
  archived: false,
  tags: [],
  highlights: [],
  ...over,
});

const ok = { added: 1, duplicates: 0, invalid: 0, highlights: 0, rkeys: [] as string[] };

describe('importOrder', () => {
  it('puts unread before archived, newest first within each', () => {
    const order = importOrder([
      save(1),
      save(3, { archived: true }),
      save(2),
      save(4, { archived: true }),
    ]);
    expect(order.map((s) => s.savedAt)).toEqual([2, 1, 4, 3]);
  });
});

describe('placeInQueue', () => {
  const saves = [save(1), save(2, { archived: true })];

  it('keeps the other app’s archive by default', () => {
    expect(placeInQueue(saves, 'as-exported')).toBe(saves);
  });

  it('puts everything in the Inbox or everything in the Archive', () => {
    expect(placeInQueue(saves, 'inbox').map((s) => s.archived)).toEqual([false, false]);
    expect(placeInQueue(saves, 'archive').map((s) => s.archived)).toEqual([true, true]);
    // The parsed saves aren't changed, so the reader can choose again.
    expect(saves.map((s) => s.archived)).toEqual([false, true]);
  });
});

describe('runImport', () => {
  it('sends each app’s saves in batches and adds up the results', async () => {
    const saves = [
      ...Array.from({ length: IMPORT_BATCH_SIZE + 1 }, (_, i) => save(i)),
      save(999, { source: 'matter' }),
    ];
    const batch = vi.fn(async (source: string, items: unknown[]) => ({
      ...ok,
      added: items.length,
      rkeys: [`${source}-${items.length}`],
    }));
    const progress = vi.fn();
    const totals = await runImport(saves, batch, progress);

    expect(batch.mock.calls.map(([source, items]) => [source, items.length])).toEqual([
      // Matter's one save is the newest, so its app goes first.
      ['matter', 1],
      ['pocket', IMPORT_BATCH_SIZE],
      ['pocket', 1],
    ]);
    expect(batch.mock.calls[0][1][0]).not.toHaveProperty('source');
    expect(totals.added).toBe(IMPORT_BATCH_SIZE + 2);
    expect(totals.rkeys).toEqual(['matter-1', `pocket-${IMPORT_BATCH_SIZE}`, 'pocket-1']);
    expect(progress).toHaveBeenLastCalledWith(saves.length, saves.length);
  });

  it('waits out a rate limit and tries the batch again', async () => {
    const batch = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('slow down'), { retryAfter: 7 }))
      .mockResolvedValueOnce(ok);
    const wait = vi.fn(async () => {});
    await runImport([save(1)], batch, () => {}, wait);
    expect(wait).toHaveBeenCalledWith(7000);
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it('stops on any other error, carrying the totals so far', async () => {
    const saves = Array.from({ length: IMPORT_BATCH_SIZE + 1 }, (_, i) => save(i));
    const batch = vi
      .fn()
      .mockResolvedValueOnce({ ...ok, added: IMPORT_BATCH_SIZE })
      .mockRejectedValueOnce(new Error('boom'));
    await expect(runImport(saves, batch, () => {})).rejects.toMatchObject({
      message: 'boom',
      totals: { added: IMPORT_BATCH_SIZE },
    });
  });
});
