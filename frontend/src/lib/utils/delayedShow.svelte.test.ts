import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { delayedShow } from './delayedShow.svelte';

describe('delayedShow', () => {
  afterEach(() => vi.useRealTimers());

  function setup(delayMs: number) {
    const state = $state({ on: false });
    let flag!: { current: boolean };
    const stop = $effect.root(() => {
      flag = delayedShow(() => state.on, delayMs);
    });
    flushSync();
    return { state, flag, stop };
  }

  it('stays off for a condition shorter than the delay', () => {
    vi.useFakeTimers();
    const { state, flag, stop } = setup(150);
    state.on = true;
    flushSync();
    vi.advanceTimersByTime(100);
    state.on = false;
    flushSync();
    vi.advanceTimersByTime(200);
    flushSync();
    expect(flag.current).toBe(false);
    stop();
  });

  it('turns on after the delay and off at once', () => {
    vi.useFakeTimers();
    const { state, flag, stop } = setup(150);
    state.on = true;
    flushSync();
    vi.advanceTimersByTime(150);
    flushSync();
    expect(flag.current).toBe(true);
    state.on = false;
    flushSync();
    expect(flag.current).toBe(false);
    stop();
  });
});
