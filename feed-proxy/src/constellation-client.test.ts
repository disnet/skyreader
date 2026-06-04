import { describe, expect, it, afterEach, beforeEach, spyOn } from 'bun:test';
import {
  constellationGet,
  isConstellationBreakerOpen,
  resetConstellationBreaker,
} from './constellation-client';

beforeEach(() => resetConstellationBreaker());
afterEach(() => {
  (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
  resetConstellationBreaker();
});

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
