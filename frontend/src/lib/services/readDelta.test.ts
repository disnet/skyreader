import { describe, it, expect } from 'vitest';
import {
  planReadDelta,
  planAnnotatedReads,
  advanceCursor,
  type ReadDeltaPosition,
} from './readDelta';

const NOW = 1_700_000_000_000;

function pos(overrides: Partial<ReadDeltaPosition> & { item_guid: string }): ReadDeltaPosition {
  return {
    item_type: 'article',
    read_at: null,
    rkey: null,
    deleted: false,
    ...overrides,
  };
}

describe('planReadDelta', () => {
  const never = () => false;

  it('turns live rows into read-label puts and tombstones into removals', () => {
    const { puts, deletes } = planReadDelta(
      [pos({ item_guid: 'live-a', read_at: 123 }), pos({ item_guid: 'gone-b', deleted: true })],
      { isInFlight: never, now: NOW }
    );

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ itemKey: 'live-a', label: 'read', itemType: 'article' });
    expect(deletes).toEqual([['gone-b', 'read']]);
  });

  it('preserves item_type so documents and articles round-trip distinctly', () => {
    const { puts } = planReadDelta(
      [
        pos({ item_guid: 'at://doc', item_type: 'document', read_at: 1 }),
        pos({ item_guid: 'article', item_type: 'article', read_at: 1 }),
      ],
      { isInFlight: never, now: NOW }
    );
    expect(puts.map((p) => [p.itemKey, p.itemType])).toEqual([
      ['at://doc', 'document'],
      ['article', 'article'],
    ]);
  });

  // The core correctness case: a stale tombstone from another device must not
  // clear a read that was just marked locally and whose push is still in flight.
  it('does NOT remove a tombstoned item whose local mark-read is in flight', () => {
    const inFlight = new Set(['in-flight-guid']);
    const { puts, deletes } = planReadDelta(
      [
        pos({ item_guid: 'in-flight-guid', deleted: true }),
        pos({ item_guid: 'settled-guid', deleted: true }),
      ],
      { isInFlight: (k) => inFlight.has(k), now: NOW }
    );

    expect(puts).toHaveLength(0);
    // Only the settled item is removed; the in-flight read is protected.
    expect(deletes).toEqual([['settled-guid', 'read']]);
  });

  it('still adds a LIVE row for an in-flight item (the guard only blocks removals)', () => {
    const inFlight = new Set(['in-flight-guid']);
    const { puts, deletes } = planReadDelta(
      [pos({ item_guid: 'in-flight-guid', deleted: false, read_at: 5 })],
      { isInFlight: (k) => inFlight.has(k), now: NOW }
    );
    expect(deletes).toHaveLength(0);
    expect(puts.map((p) => p.itemKey)).toEqual(['in-flight-guid']);
  });

  it('uses numeric read_at as createdAt; falls back to now for null/string', () => {
    const { puts } = planReadDelta(
      [
        pos({ item_guid: 'numeric', read_at: 999 }),
        pos({ item_guid: 'null-at', read_at: null }),
        pos({ item_guid: 'iso-at', read_at: '2026-01-01T00:00:00Z' }),
      ],
      { isInFlight: never, now: NOW }
    );
    const byKey = Object.fromEntries(puts.map((p) => [p.itemKey, p]));
    expect(byKey['numeric'].createdAt).toBe(999);
    expect(byKey['numeric'].props.readAt).toBe(999);
    // Non-numeric read_at: createdAt is `now`, but readAt keeps the raw value.
    expect(byKey['null-at'].createdAt).toBe(NOW);
    expect(byKey['null-at'].props.readAt).toBe(NOW);
    expect(byKey['iso-at'].createdAt).toBe(NOW);
    expect(byKey['iso-at'].props.readAt).toBe('2026-01-01T00:00:00Z');
  });

  it('returns empty plans for an empty delta', () => {
    expect(planReadDelta([], { isInFlight: never, now: NOW })).toEqual({ puts: [], deletes: [] });
  });
});

describe('planAnnotatedReads', () => {
  it('adds a read label for keys not already read', () => {
    const puts = planAnnotatedReads(['a', 'b'], 'article', { hasRead: () => false, now: NOW });
    expect(puts.map((p) => p.itemKey)).toEqual(['a', 'b']);
    expect(puts[0]).toMatchObject({ label: 'read', itemType: 'article', updatedAt: NOW });
  });

  // Additive-only invariant: annotation/merge never clears, and never disturbs an
  // already-read item (protecting an in-flight local mark-read on re-fetch).
  it('skips keys already labeled read (never re-adds, never clears)', () => {
    const already = new Set(['already']);
    const puts = planAnnotatedReads(['already', 'fresh'], 'article', {
      hasRead: (k) => already.has(k),
      now: NOW,
    });
    expect(puts.map((p) => p.itemKey)).toEqual(['fresh']);
  });

  it('carries the document item_type through for the document fetch path', () => {
    const puts = planAnnotatedReads(['at://doc'], 'document', { hasRead: () => false, now: NOW });
    expect(puts[0].itemType).toBe('document');
  });

  it('returns nothing when every key is already read', () => {
    const puts = planAnnotatedReads(['a', 'b'], 'article', { hasRead: () => true, now: NOW });
    expect(puts).toEqual([]);
  });
});

describe('advanceCursor', () => {
  it('advances only when the incoming cursor moves strictly forward', () => {
    expect(advanceCursor(100, 200)).toBe(200);
    expect(advanceCursor(100, 100)).toBeNull();
    expect(advanceCursor(100, 50)).toBeNull();
  });

  it('never advances on a missing/zero cursor (no rewind)', () => {
    expect(advanceCursor(100, 0)).toBeNull();
    expect(advanceCursor(100, null)).toBeNull();
    expect(advanceCursor(100, undefined)).toBeNull();
  });
});
