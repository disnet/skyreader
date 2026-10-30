import { describe, it, expect } from 'vitest';
import { formatResumeAt } from './backingExport';

describe('formatResumeAt', () => {
  it('names the day when the copy resumes on another one', () => {
    const now = new Date(2026, 9, 30, 22, 0);
    expect(formatResumeAt(new Date(2026, 9, 30, 23, 5), now)).not.toMatch(/ at /);
    expect(formatResumeAt(new Date(2026, 9, 31, 1, 5), now)).toMatch(/^Saturday at /);
  });
});
