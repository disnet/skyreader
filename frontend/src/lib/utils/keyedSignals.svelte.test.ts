import { describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import { KeyedSignals } from './keyedSignals.svelte';

// Counts how often a $derived over `key` re-runs while a reader holds it.
function watch(signals: KeyedSignals, key: string | null) {
  let runs = 0;
  const stop = $effect.root(() => {
    const value = $derived.by(() => {
      runs++;
      if (key === null) signals.trackAll();
      else signals.track(key);
      return runs;
    });
    $effect(() => {
      void value;
    });
  });
  flushSync();
  return {
    get runs() {
      return runs;
    },
    stop,
  };
}

describe('KeyedSignals', () => {
  it("re-runs a key's readers on its bump", () => {
    const signals = new KeyedSignals(64);
    const a = watch(signals, 'a');
    expect(a.runs).toBe(1);
    signals.bump('a');
    flushSync();
    expect(a.runs).toBe(2);
    a.stop();
  });

  it("leaves other buckets' readers alone", () => {
    const signals = new KeyedSignals(1024);
    const readers = Array.from({ length: 50 }, (_, i) => watch(signals, `item-${i}`));
    signals.bump('item-7');
    flushSync();
    const reran = readers.filter((r) => r.runs > 1).length;
    // item-7 itself, plus at most a bucket-mate or two.
    expect(reran).toBeGreaterThanOrEqual(1);
    expect(reran).toBeLessThanOrEqual(3);
    readers.forEach((r) => r.stop());
  });

  it('bumpAll and trackAll cover every key', () => {
    const signals = new KeyedSignals(64);
    const a = watch(signals, 'a');
    const all = watch(signals, null);
    signals.bump('z');
    flushSync();
    expect(all.runs).toBe(2);
    signals.bumpAll();
    flushSync();
    expect(a.runs).toBe(2);
    expect(all.runs).toBe(3);
    a.stop();
    all.stop();
  });
});
