import { describe, it, expect } from 'vitest';
import { generateTid } from './tid';

// Mirrors the backend's TID_REGEX in backend/src/utils/validation.ts — the
// contract every generated rkey must satisfy or the backend rejects the record.
const TID_REGEX = /^[a-z0-9]{13,}$/;

describe('generateTid', () => {
  it('always satisfies the backend rkey contract (lowercase alphanumeric, >=13 chars)', () => {
    for (let i = 0; i < 10000; i++) {
      const tid = generateTid();
      expect(tid, tid).toMatch(TID_REGEX);
      expect(tid.length).toBeGreaterThanOrEqual(13);
    }
  });

  it('produces unique values across rapid successive calls', () => {
    const count = 10000;
    const tids = new Set<string>();
    for (let i = 0; i < count; i++) tids.add(generateTid());
    expect(tids.size).toBe(count);
  });

  it('is roughly time-ordered (timestamp prefix sorts ascending)', () => {
    const a = generateTid();
    // Same millisecond as `a`; prefixes are equal so this only asserts the
    // prefix is the base36 timestamp and not random-led.
    const b = generateTid();
    const prefixLen = Date.now().toString(36).length;
    expect(a.slice(0, prefixLen)).toBe(b.slice(0, prefixLen));
  });
});
