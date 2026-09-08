// The Saved list and Home's "Recently saved" lane render the same pile from
// two different pipelines. Every rule they used to decide independently showed
// up as the same item present on one surface and missing from the other, so
// these are the rules both now import.
import { describe, expect, it } from 'vitest';
import type { SavedItem } from '$lib/types';
import {
  compareSavedNewestFirst,
  isSavedItemArchived,
  savedAtMs,
  savedItemLabelKeys,
  setSavedItemArchived,
} from './savedPile';

function save(overrides: Partial<SavedItem> = {}): SavedItem {
  return {
    rkey: '3kabcdefghijk',
    uri: 'at://did:plc:test/app.skyreader.feed.saved/3kabcdefghijk',
    url: 'https://example.com/a',
    title: 'A',
    author: null,
    description: null,
    content: null,
    contentType: 'article',
    domain: 'example.com',
    image: null,
    wordCount: 400,
    publishedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('savedItemLabelKeys', () => {
  it('covers every key a surface can use as a display key', () => {
    const item = save({ itemGuid: 'guid-1' });
    expect(savedItemLabelKeys(item)).toEqual([
      'guid-1',
      'at://did:plc:test/app.skyreader.feed.saved/3kabcdefghijk',
      'https://example.com/a',
      '3kabcdefghijk',
    ]);
  });

  it('drops empty aliases so an optimistic save (no uri yet) still resolves', () => {
    expect(savedItemLabelKeys(save({ uri: '', itemGuid: undefined }))).toEqual([
      'https://example.com/a',
      '3kabcdefghijk',
    ]);
  });

  it('keeps the guid first — callers take [0] as the primary key', () => {
    expect(savedItemLabelKeys(save({ itemGuid: 'guid-1' }))[0]).toBe('guid-1');
  });
});

describe('isSavedItemArchived', () => {
  it('is true whichever alias the label landed under', () => {
    const item = save({ itemGuid: 'guid-1' });
    for (const key of savedItemLabelKeys(item)) {
      expect(isSavedItemArchived(item, (k) => k === key)).toBe(true);
    }
  });

  it('is false when nothing about the save is archived', () => {
    expect(isSavedItemArchived(save({ itemGuid: 'guid-1' }), () => false)).toBe(false);
  });

  it('sees an archive written against the record uri by the `e` shortcut', () => {
    // The list rows dual-write guid + uri; the keyboard path used to write the
    // display key alone, and the list's guid-only test then kept showing an
    // item Home had already dropped.
    const item = save({ itemGuid: 'guid-1' });
    const archived = new Set([item.uri]);
    expect(isSavedItemArchived(item, (k) => archived.has(k))).toBe(true);
  });
});

describe('setSavedItemArchived', () => {
  it.each([
    ['URL', (item: SavedItem) => item.url],
    ['rkey', (item: SavedItem) => item.rkey],
  ])('clears a sole %s archive label when moving the save to Inbox', async (_name, alias) => {
    const item = save({ itemGuid: 'guid-1' });
    const archived = new Set([alias(item)]);

    await setSavedItemArchived(item, false, (key, desired) => {
      if (desired) archived.add(key);
      else archived.delete(key);
    });

    expect(archived).toEqual(new Set());
    expect(isSavedItemArchived(item, (key) => archived.has(key))).toBe(false);
  });

  it('sets every unique alias to the desired state', async () => {
    const item = save({ itemGuid: 'https://example.com/a' });
    const writes: Array<[string, boolean]> = [];

    await setSavedItemArchived(item, true, (key, archived) => {
      writes.push([key, archived]);
    });

    expect(writes).toEqual([
      ['https://example.com/a', true],
      ['at://did:plc:test/app.skyreader.feed.saved/3kabcdefghijk', true],
      ['3kabcdefghijk', true],
    ]);
  });
});

describe('savedAtMs', () => {
  it('parses savedAt', () => {
    expect(savedAtMs(save({ savedAt: '2026-02-01T00:00:00.000Z' }))).toBe(
      Date.parse('2026-02-01T00:00:00.000Z')
    );
  });

  it('sorts a missing or unparseable savedAt last rather than throwing NaN around', () => {
    expect(savedAtMs(save({ savedAt: '' }))).toBe(0);
    expect(savedAtMs(save({ savedAt: 'not a date' }))).toBe(0);
  });
});

describe('compareSavedNewestFirst', () => {
  it('orders by savedAt, newest first', () => {
    const older = save({ rkey: 'a', savedAt: '2026-01-01T00:00:00.000Z' });
    const newer = save({ rkey: 'b', savedAt: '2026-03-01T00:00:00.000Z' });
    expect([older, newer].sort(compareSavedNewestFirst).map((s) => s.rkey)).toEqual(['b', 'a']);
  });

  it('does not fall back to rkey order, which only proxies save time', () => {
    // An extension save, another device's clock, or a backed collection mints
    // rkeys that do not line up with savedAt — the order the cache path used to
    // hand Home.
    const rows = [
      save({ rkey: '3zzz', savedAt: '2026-01-01T00:00:00.000Z' }),
      save({ rkey: '3aaa', savedAt: '2026-05-01T00:00:00.000Z' }),
    ];
    expect(rows.sort(compareSavedNewestFirst).map((s) => s.rkey)).toEqual(['3aaa', '3zzz']);
  });

  it('breaks savedAt ties on rkey so a bulk import lands in one stable order', () => {
    const rows = [
      save({ rkey: 'b', savedAt: '2026-01-01T00:00:00.000Z' }),
      save({ rkey: 'c', savedAt: '2026-01-01T00:00:00.000Z' }),
      save({ rkey: 'a', savedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(rows.sort(compareSavedNewestFirst).map((s) => s.rkey)).toEqual(['c', 'b', 'a']);
    expect(
      [...rows]
        .reverse()
        .sort(compareSavedNewestFirst)
        .map((s) => s.rkey)
    ).toEqual(['c', 'b', 'a']);
  });
});
