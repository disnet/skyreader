import { describe, expect, it, afterEach, beforeEach, spyOn } from 'bun:test';
import {
  constellationGet,
  getConstellationStats,
  isConstellationBreakerOpen,
  resetConstellationBreaker,
  setConstellationLimits,
} from './constellation-client';

beforeEach(() => {
  resetConstellationBreaker();
  setConstellationLimits();
});
afterEach(() => {
  (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
  resetConstellationBreaker();
  setConstellationLimits();
});

/** The shape Bun surfaces when a pooled keep-alive socket is reset mid-request. */
function connectionReset(): Error {
  const error = new Error(
    'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'
  );
  (error as Error & { code: string }).code = 'ECONNRESET';
  return error;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('constellationGet', () => {
  it('returns parsed JSON on success and keeps the breaker closed', async () => {
    spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response(JSON.stringify({ total: 7 }))) as unknown as typeof fetch
    );
    const data = await constellationGet<{ total: number }>('/links/count', { target: 'x' });
    expect(data?.total).toBe(7);
    expect(isConstellationBreakerOpen()).toBe(false);
  });

  it('returns null on a clean 4xx without tripping the breaker', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    );
    for (let i = 0; i < 10; i++) {
      expect(await constellationGet('/links/all', { target: 'x' })).toBeNull();
    }
    // A healthy service answering 404 should never open the breaker.
    expect(isConstellationBreakerOpen()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(10);
  });

  it('opens the breaker after repeated 5xx and then short-circuits without fetching', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('err', { status: 503 })) as unknown as typeof fetch
    );

    // Threshold is 5 consecutive failures.
    for (let i = 0; i < 5; i++) {
      expect(await constellationGet('/links/all', { target: 'x' })).toBeNull();
    }
    expect(isConstellationBreakerOpen()).toBe(true);

    const callsBefore = spy.mock.calls.length;
    // Further calls short-circuit to null without hitting the network.
    expect(await constellationGet('/links/all', { target: 'x' })).toBeNull();
    expect(spy.mock.calls.length).toBe(callsBefore);
  });

  it('opens the breaker on repeated network errors (timeouts)', async () => {
    spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch);
    for (let i = 0; i < 5; i++) {
      expect(await constellationGet('/links/all', { target: 'x' })).toBeNull();
    }
    expect(isConstellationBreakerOpen()).toBe(true);
  });

  it('a success resets the failure streak so the breaker stays closed', async () => {
    let call = 0;
    spyOn(globalThis, 'fetch').mockImplementation((async () => {
      call++;
      // Fail, fail, succeed, repeat — never 5 in a row.
      return call % 3 === 0
        ? new Response(JSON.stringify({ ok: true }))
        : new Response('err', { status: 500 });
    }) as unknown as typeof fetch);

    for (let i = 0; i < 12; i++) await constellationGet('/links/all', { target: 'x' });
    expect(isConstellationBreakerOpen()).toBe(false);
  });
});

describe('constellationGet connection-reset retry', () => {
  it('retries once after a reset and returns the data', async () => {
    let call = 0;
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      call++;
      if (call === 1) throw connectionReset();
      return new Response(JSON.stringify({ total: 3 }));
    }) as unknown as typeof fetch);

    const data = await constellationGet<{ total: number }>('/links/distinct-dids', { target: 'x' });
    expect(data?.total).toBe(3);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(isConstellationBreakerOpen()).toBe(false);
    const stats = getConstellationStats();
    expect(stats.retriesRecovered).toBe(1);
    expect(stats.failures).toBe(0);
  });

  it('recognises the reset by message alone when no code is attached', async () => {
    let call = 0;
    spyOn(globalThis, 'fetch').mockImplementation((async () => {
      call++;
      if (call === 1) throw new Error('The socket connection was closed unexpectedly.');
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch);

    expect(await constellationGet<{ ok: boolean }>('/links/all', { target: 'x' })).toEqual({
      ok: true,
    });
    expect(call).toBe(2);
  });

  it('counts a reset-then-reset as exactly one breaker failure', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw connectionReset();
    }) as unknown as typeof fetch);

    // Four logical calls = 8 sockets died, but only 4 breaker failures.
    for (let i = 0; i < 4; i++) {
      expect(await constellationGet('/links/all', { target: 'x' })).toBeNull();
    }
    expect(spy).toHaveBeenCalledTimes(8);
    expect(isConstellationBreakerOpen()).toBe(false);
    expect(getConstellationStats().failures).toBe(4);

    // The fifth logical call is what opens it.
    expect(await constellationGet('/links/all', { target: 'x' })).toBeNull();
    expect(isConstellationBreakerOpen()).toBe(true);
  });

  it('does not retry a timeout — the caller already waited out the full budget', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      const error = new Error('The operation timed out.');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch);

    expect(await constellationGet('/links/all', { target: 'x' })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getConstellationStats().failures).toBe(1);
  });

  it('does not retry an HTTP-level failure', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('err', { status: 503 })) as unknown as typeof fetch
    );
    expect(await constellationGet('/links/all', { target: 'x' })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('constellationGet concurrency cap', () => {
  it('never runs more than the cap in flight, and all callers still resolve', async () => {
    setConstellationLimits(3, 200);
    let active = 0;
    let peak = 0;
    const gate = deferred();
    spyOn(globalThis, 'fetch').mockImplementation((async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch);

    const calls = Array.from({ length: 12 }, () =>
      constellationGet<{ ok: boolean }>('/links/all', { target: 'x' })
    );
    // Let everything that can start, start.
    await Promise.resolve();
    await Promise.resolve();
    expect(getConstellationStats().inUse).toBe(3);
    expect(getConstellationStats().queued).toBe(9);

    gate.resolve();
    const results = await Promise.all(calls);
    expect(peak).toBe(3);
    expect(results.every((r) => r?.ok === true)).toBe(true);
    expect(getConstellationStats().inUse).toBe(0);
  });

  it('sheds on queue overflow, returning null without counting a breaker failure', async () => {
    setConstellationLimits(1, 1);
    const gate = deferred();
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      await gate.promise;
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch);

    // 1 in flight + 1 queued is the whole capacity; the rest are shed.
    const calls = Array.from({ length: 6 }, () => constellationGet('/links/all', { target: 'x' }));
    const results = await Promise.all([...calls.slice(2)]);
    expect(results.every((r) => r === null)).toBe(true);
    expect(getConstellationStats().shed).toBe(4);
    // Shedding is our own backpressure, not a Constellation health signal.
    expect(getConstellationStats().failures).toBe(0);
    expect(isConstellationBreakerOpen()).toBe(false);

    gate.resolve();
    expect(await Promise.all(calls.slice(0, 2))).toEqual([{ ok: true }, { ok: true }]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
