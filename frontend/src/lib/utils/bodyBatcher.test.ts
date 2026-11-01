import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBodyBatcher } from './bodyBatcher';
import { RateLimitError } from '$lib/services/api';

describe('createBodyBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends many asks as one request, and an rkey asked twice once', async () => {
    const fetch = vi.fn(async (rkeys: string[]) =>
      Object.fromEntries(rkeys.map((r) => [r, `<p>${r}</p>`]))
    );
    const b = createBodyBatcher(fetch);
    const asks = ['a', 'b', 'a', 'c'].map((r) => b.get(r));
    await vi.runAllTimersAsync();
    expect(await Promise.all(asks)).toEqual(['<p>a</p>', '<p>b</p>', '<p>a</p>', '<p>c</p>']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('splits a long queue into batches, one request at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = vi.fn(async (rkeys: string[]) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return Object.fromEntries(rkeys.map((r) => [r, 'x']));
    });
    const b = createBodyBatcher(fetch, { batchSize: 2 });
    const asks = ['a', 'b', 'c', 'd', 'e'].map((r) => b.get(r));
    await vi.runAllTimersAsync();
    await Promise.all(asks);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(maxInFlight).toBe(1);
  });

  it('remembers that the server has no body, until forgotten', async () => {
    const fetch = vi.fn(async () => ({ a: null }));
    const b = createBodyBatcher(fetch);
    const first = b.get('a');
    await vi.runAllTimersAsync();
    expect(await first).toBeNull();
    expect(await b.get('a')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    b.forget('a');
    const again = b.get('a');
    await vi.runAllTimersAsync();
    await again;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('pauses after a failure, doubling the wait, and does not remember failures as empty', async () => {
    let t = 0;
    const fetch = vi.fn(async (): Promise<Record<string, string | null>> => {
      throw new Error('500');
    });
    const b = createBodyBatcher(fetch, { baseBackoffMs: 1000, now: () => t });
    const first = b.get('a');
    await vi.runAllTimersAsync();
    expect(await first).toBeNull();

    // Inside the pause: answered without a request.
    t = 500;
    expect(await b.get('a')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    // After it: asked again (a failure isn't "no body"), and fails into a 2s pause.
    t = 1000;
    const second = b.get('a');
    await vi.runAllTimersAsync();
    await second;
    expect(fetch).toHaveBeenCalledTimes(2);
    t = 2900;
    expect(await b.get('a')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits out a 429's Retry-After", async () => {
    let t = 0;
    const fetch = vi.fn(async (): Promise<Record<string, string | null>> => {
      throw new RateLimitError(30);
    });
    const b = createBodyBatcher(fetch, { now: () => t });
    const first = b.get('a');
    await vi.runAllTimersAsync();
    await first;
    t = 29_000;
    expect(await b.get('b')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('forgets a "no body" answer after emptyTtlMs', async () => {
    let t = 0;
    const fetch = vi.fn(async (rkeys: string[]) => Object.fromEntries(rkeys.map((r) => [r, null])));
    const b = createBodyBatcher(fetch, { now: () => t, emptyTtlMs: 1000 });
    const first = b.get('a');
    await vi.runAllTimersAsync();
    expect(await first).toBeNull();
    t = 999;
    expect(b.knownEmpty('a')).toBe(true);
    t = 1000;
    expect(b.knownEmpty('a')).toBe(false);
    const again = b.get('a');
    await vi.runAllTimersAsync();
    await again;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('hands back its "no body" answers for saving, and restores them', async () => {
    let t = 100;
    const onEmptyChange = vi.fn();
    const fetch = vi.fn(async (rkeys: string[]) => Object.fromEntries(rkeys.map((r) => [r, null])));
    const b = createBodyBatcher(fetch, { now: () => t, emptyTtlMs: 1000, onEmptyChange });
    b.markEmpty('a');
    expect(onEmptyChange).toHaveBeenCalledTimes(1);
    t = 500;
    b.markEmpty('b');
    t = 1200; // 'a' has expired, 'b' hasn't
    expect(b.emptyEntries()).toEqual([['b', 500]]);

    // A new page load: the saved answers come back, expired ones don't, and a
    // restored rkey isn't asked about.
    const next = createBodyBatcher(fetch, { now: () => t, emptyTtlMs: 1000 });
    next.restoreEmpty([
      ['a', 100],
      ['b', 500],
    ]);
    expect(next.knownEmpty('a')).toBe(false);
    expect(next.knownEmpty('b')).toBe(true);
    expect(await next.get('b')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
