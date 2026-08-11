import { describe, it, expect } from 'vitest';
import { generateTid } from './tid';

// The AT Protocol TID syntax: exactly 13 base32-sortable chars, the first
// restricted to the 16 values that keep the top bit of the 64-bit integer 0.
const TID_REGEX = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

// Decode a TID back to milliseconds — the property that separates a real TID
// from a string that merely passes the regex.
const S32 = '234567abcdefghijklmnopqrstuvwxyz';
function tidToMillis(tid: string): number {
  let value = 0n;
  for (const char of tid) value = value * 32n + BigInt(S32.indexOf(char));
  return Number((value >> 10n) / 1000n);
}

describe('generateTid', () => {
  it('is a syntactically valid TID', () => {
    for (let i = 0; i < 10000; i++) {
      const tid = generateTid();
      expect(tid, tid).toMatch(TID_REGEX);
      expect(tid.length, tid).toBe(13);
    }
  });

  it('satisfies the backend rkey contract', () => {
    // Mirrors TID_REGEX in backend/src/utils/validation.ts, which stays loose so
    // it keeps accepting the legacy rkeys already written to D1 and to PDSes.
    expect(generateTid()).toMatch(/^[a-z0-9]{13,}$/);
  });

  it('produces unique values across rapid successive calls', () => {
    const count = 10000;
    const tids = new Set<string>();
    for (let i = 0; i < count; i++) tids.add(generateTid());
    expect(tids.size).toBe(count);
  });

  it('sorts lexicographically by creation order', () => {
    const tids = Array.from({ length: 1000 }, generateTid);
    expect([...tids].sort()).toEqual(tids);
  });

  it('decodes back to the time it was created', () => {
    const before = Date.now();
    const decoded = tidToMillis(generateTid());
    expect(decoded).toBeGreaterThanOrEqual(before - 1000);
    expect(decoded).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
