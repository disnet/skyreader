import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import { fetchWithBotFallback, __resetUaBlockMemoryForTests } from './app';

// The honest identity fetchWithBotFallback sends on its first attempt (mirrors
// HONEST_UA in app.ts; kept as a literal here so the test pins the actual string).
const HONEST_UA = 'Skyreader/1.0 (+https://skyreader.app)';
const URL = 'https://blocked.example.com/feed';

function uaOf(init: unknown): string {
  return (
    ((init as RequestInit | undefined)?.headers as Record<string, string>)?.['User-Agent'] ?? ''
  );
}
function headersOf(init: unknown): Record<string, string> {
  return ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
}

describe('fetchWithBotFallback', () => {
  let fetchMock: ReturnType<typeof spyOn>;
  beforeEach(() => __resetUaBlockMemoryForTests()); // module-level learned-block memory
  afterEach(() => {
    fetchMock?.mockRestore();
    __resetUaBlockMemoryForTests();
  });

  it('uses the honest UA and does not retry when the first attempt succeeds', async () => {
    const seen: string[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: unknown,
      init: unknown
    ) => {
      seen.push(uaOf(init));
      return new Response('<rss/>', { status: 200 });
    }) as unknown as typeof fetch);

    const res = await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
    expect(res.status).toBe(200);
    expect(seen).toEqual([HONEST_UA]);
  });

  it('does NOT retry on a non-403 error status (e.g. 404/500)', async () => {
    const seen: string[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: unknown,
      init: unknown
    ) => {
      seen.push(uaOf(init));
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch);

    const res = await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
    expect(res.status).toBe(404);
    expect(seen).toEqual([HONEST_UA]); // single attempt — only 403 is a "block"
  });

  it('retries with a browser UA after an explicit 403', async () => {
    const seen: string[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: unknown,
      init: unknown
    ) => {
      const ua = uaOf(init);
      seen.push(ua);
      return ua === HONEST_UA
        ? new Response('blocked', { status: 403 })
        : new Response('<rss/>', { status: 200 });
    }) as unknown as typeof fetch);

    const res = await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(HONEST_UA);
    expect(seen[1]).toContain('Mozilla/5.0');
    expect(seen[1]).toContain('Chrome');
  });

  it('retries with a browser UA when the honest attempt silently hangs (timeout)', async () => {
    const seen: string[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: unknown,
      init: unknown
    ) => {
      const ua = uaOf(init);
      seen.push(ua);
      if (ua === HONEST_UA) {
        // Simulate a black-holed connection: never resolve, reject only on abort
        // (which AbortSignal.timeout(probeTimeoutMs) triggers).
        const signal = (init as RequestInit).signal!;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out.', 'TimeoutError'))
          );
        });
      }
      return new Response('<rss/>', { status: 200 });
    }) as unknown as typeof fetch);

    const res = await fetchWithBotFallback(
      URL,
      { 'User-Agent': HONEST_UA },
      { probeTimeoutMs: 50 }
    );
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[1]).toContain('Mozilla/5.0');
  });

  it('preserves conditional-request headers across the fallback, swapping only the UA', async () => {
    const seen: Array<Record<string, string>> = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: unknown,
      init: unknown
    ) => {
      const h = headersOf(init);
      seen.push(h);
      return h['User-Agent'] === HONEST_UA
        ? new Response('blocked', { status: 403 })
        : new Response('<rss/>', { status: 200 });
    }) as unknown as typeof fetch);

    await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA, 'If-None-Match': '"abc"' });
    expect(seen[1]['If-None-Match']).toBe('"abc"');
    expect(seen[1]['User-Agent']).toContain('Mozilla/5.0');
  });

  describe('per-host learned-block memory', () => {
    // A mock that 403s the honest UA and 200s the browser UA, recording every UA
    // it sees so a test can count attempts across calls.
    function mockBlockingHost(seen: string[]) {
      return spyOn(globalThis, 'fetch').mockImplementation((async (
        _url: unknown,
        init: unknown
      ) => {
        const ua = uaOf(init);
        seen.push(ua);
        return ua === HONEST_UA
          ? new Response('blocked', { status: 403 })
          : new Response('<rss/>', { status: 200 });
      }) as unknown as typeof fetch);
    }

    it('skips the honest probe on later fetches once a host is learned-blocked', async () => {
      const seen: string[] = [];
      fetchMock = mockBlockingHost(seen);

      // First fetch: honest (403) → browser (200), and the host is remembered.
      await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
      expect(seen).toEqual([HONEST_UA, expect.stringContaining('Mozilla/5.0')]);

      // Second fetch: straight to the browser UA, no honest probe.
      seen.length = 0;
      await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
      expect(seen.length).toBe(1);
      expect(seen[0]).toContain('Mozilla/5.0');
    });

    it('re-probes the honest UA after the block TTL expires', async () => {
      const seen: string[] = [];
      fetchMock = mockBlockingHost(seen);

      await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA }, { now: 0 });
      seen.length = 0;

      // 6h + 1ms later the entry has expired, so we probe honestly again
      // (honest 403 → browser 200): two attempts, honest first.
      const sixHoursPlus = 6 * 60 * 60 * 1000 + 1;
      await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA }, { now: sixHoursPlus });
      expect(seen.length).toBe(2);
      expect(seen[0]).toBe(HONEST_UA);
    });

    it('does not remember a host when the browser UA is also blocked', async () => {
      const seen: string[] = [];
      // Both UAs 403 (e.g. IP-blocked / truly forbidden, not UA-gating).
      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
        _url: unknown,
        init: unknown
      ) => {
        seen.push(uaOf(init));
        return new Response('blocked', { status: 403 });
      }) as unknown as typeof fetch);

      const res = await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
      expect(res.status).toBe(403);
      expect(seen).toEqual([HONEST_UA, expect.stringContaining('Mozilla/5.0')]);

      // Not remembered → the next fetch still probes honestly first.
      seen.length = 0;
      await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
      expect(seen[0]).toBe(HONEST_UA);
    });

    it('keeps using the honest UA for hosts that never block', async () => {
      const seen: string[] = [];
      fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
        _url: unknown,
        init: unknown
      ) => {
        seen.push(uaOf(init));
        return new Response('<rss/>', { status: 200 });
      }) as unknown as typeof fetch);

      await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
      await fetchWithBotFallback(URL, { 'User-Agent': HONEST_UA });
      expect(seen).toEqual([HONEST_UA, HONEST_UA]); // honest both times, no fallback
    });
  });
});
