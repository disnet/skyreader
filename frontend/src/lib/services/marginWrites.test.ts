import { beforeEach, describe, expect, it, vi } from 'vitest';
import { marginRkeysWrittenSince, resetMarginWrites, trackMarginWrite } from './marginWrites';

describe('marginWrites', () => {
  beforeEach(() => {
    resetMarginWrites();
    vi.useRealTimers();
  });

  it('names a write while it is out, and after only if it started since', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const settle = trackMarginWrite('rk1');
    vi.setSystemTime(5_000);
    expect(marginRkeysWrittenSince(4_000)).toEqual(new Set(['rk1']));
    settle();
    expect(marginRkeysWrittenSince(4_000)).toEqual(new Set());
    expect(marginRkeysWrittenSince(1_000)).toEqual(new Set(['rk1']));
  });

  it('keeps a note in flight until every overlapping write settles', () => {
    const first = trackMarginWrite('rk1');
    const second = trackMarginWrite('rk1');
    first();
    expect(marginRkeysWrittenSince(Number.MAX_SAFE_INTEGER)).toEqual(new Set(['rk1']));
    second();
    expect(marginRkeysWrittenSince(Number.MAX_SAFE_INTEGER)).toEqual(new Set());
  });
});
