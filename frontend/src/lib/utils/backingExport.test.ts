import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const exportSavesBatch = vi.fn();
vi.mock('$lib/services/api', () => ({
  api: { exportSavesBatch: (...args: unknown[]) => exportSavesBatch(...args) },
  RateLimitError: class extends Error {},
}));

const { copySavesToBacking, formatResumeAt } = await import('./backingExport');

describe('copySavesToBacking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    exportSavesBatch.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('waits out a pause and resumes the Library past the last save handled', async () => {
    exportSavesBatch
      .mockResolvedValueOnce({ exported: 1, scanned: 1, total: 3, lastId: 7, retryAfter: 60 })
      .mockResolvedValueOnce({ exported: 2, scanned: 2, total: 3, lastId: 9 });
    const pauses: (Date | null)[] = [];
    const done = copySavesToBacking(undefined, { onPause: (at) => pauses.push(at) });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(exportSavesBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(3);
    expect(exportSavesBatch.mock.calls[1]).toEqual([1, { afterId: 7 }]);
    expect(pauses).toHaveLength(2);
    expect(pauses[1]).toBeNull();
  });

  it('re-sends the same named slice after a pause', async () => {
    const rkeys = ['a', 'b'];
    exportSavesBatch
      .mockResolvedValueOnce({ exported: 1, scanned: 1, total: 2, lastId: 1, retryAfter: 1 })
      .mockResolvedValueOnce({ exported: 1, scanned: 2, total: 2, lastId: 2 });
    const done = copySavesToBacking(undefined, { rkeys });
    await vi.runAllTimersAsync();
    expect(await done).toBe(2);
    expect(exportSavesBatch.mock.calls.map((c) => c[1])).toEqual([{ rkeys }, { rkeys }]);
  });
});

describe('formatResumeAt', () => {
  it('names the day when the copy resumes on another one', () => {
    const now = new Date(2026, 9, 30, 22, 0);
    expect(formatResumeAt(new Date(2026, 9, 30, 23, 5), now)).not.toMatch(/ at /);
    expect(formatResumeAt(new Date(2026, 9, 31, 1, 5), now)).toMatch(/^Saturday at /);
  });
});
