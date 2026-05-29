import { describe, it, expect } from 'vitest';
import { generateTid } from '../src/utils/tid';
import { isValidRkey } from '../src/utils/validation';

describe('generateTid', () => {
  it('always produces an rkey accepted by isValidRkey', () => {
    for (let i = 0; i < 10000; i++) {
      const tid = generateTid();
      expect(isValidRkey(tid), tid).toBe(true);
    }
  });

  it('always produces at least 13 lowercase alphanumeric characters', () => {
    for (let i = 0; i < 10000; i++) {
      const tid = generateTid();
      expect(tid.length, tid).toBeGreaterThanOrEqual(13);
      expect(tid, tid).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('produces unique values across rapid successive calls', () => {
    const count = 10000;
    const tids = new Set<string>();
    for (let i = 0; i < count; i++) tids.add(generateTid());
    expect(tids.size).toBe(count);
  });
});
