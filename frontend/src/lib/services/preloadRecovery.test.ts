import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const report = vi.hoisted(() => vi.fn());
vi.mock('./telemetry', () => ({ reportClientError: report }));

import { handlePreloadError, resetPreloadRecoveryForTests } from './preloadRecovery';

// The guard reloads once, then reports if the reload didn't help. What it must
// not do is mistake the rest of the *same* failed route load for that.

let store: Map<string, string>;
let reload: ReturnType<typeof vi.fn>;

function preloadError() {
  const event = new Event('vite:preloadError', { cancelable: true });
  handlePreloadError(event);
  return event;
}

beforeEach(() => {
  resetPreloadRecoveryForTests();
  report.mockReset();
  store = new Map();
  reload = vi.fn();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
  vi.stubGlobal('window', { location: { reload } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handlePreloadError', () => {
  it('reloads once on the first stale chunk', () => {
    const event = preloadError();
    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('stays quiet about more failures from the load it is already reloading', () => {
    preloadError();
    const second = preloadError();
    const third = preloadError();
    expect(second.defaultPrevented).toBe(true);
    expect(third.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports when the reloaded page fails again', () => {
    preloadError();
    // The reload: a fresh page with the guard still in sessionStorage.
    resetPreloadRecoveryForTests();
    const event = preloadError();
    expect(event.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toBe('preload_recovery_failed');
  });
});
