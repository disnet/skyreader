import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { handleGuestMarginHighlights } from '../src/routes/guest';
import { getRateLimitConfig } from '../src/services/rate-limit';

/**
 * POST /api/guest/margin-highlights — community highlights without a session.
 *
 * The answer is Margin's public records through the proxy's cache, so a session
 * gated nothing here except the feature itself: a guest opening a saved article
 * got a 401, an /api/auth/me probe behind it, and an unhighlighted page. This is
 * the same handler as the /api/v2 twin with the per-IP limit the authenticated
 * path gets for free from its per-DID one.
 */

const URL_UNDER_READ = 'https://example.com/an-article';

function request(body: unknown, ip = '198.51.100.7', method = 'POST'): Request {
  return new Request('https://api.example/api/guest/margin-highlights', {
    method,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

describe('guest community highlights', () => {
  let originalFetch: typeof fetch;
  let proxyCalls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    proxyCalls = [];
    (env as Env).FEED_PROXY_URL = 'https://proxy.example';
    (env as Env).FEED_PROXY_SECRET = 'test-secret';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      proxyCalls.push(typeof input === 'string' ? input : input.toString());
      return new Response(
        JSON.stringify({
          notes: [
            {
              did: 'did:plc:someone',
              handle: 'someone.example',
              selector: { exact: 'a marked sentence' },
            },
          ],
          capped: false,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it('answers a guest with the same public notes the authed twin returns', async () => {
    const res = await handleGuestMarginHighlights(request({ url: URL_UNDER_READ }), env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: Array<{ handle: string }>; capped: boolean };
    expect(body.notes.map((n) => n.handle)).toEqual(['someone.example']);
    expect(body.capped).toBe(false);
    expect(proxyCalls).toHaveLength(1);
  });

  // The point of the route: reachable with no session, where the /api/v2 twin
  // 401s. Goes through the worker so the routing and the public-path list are
  // exercised, not just the handler.
  it('is reachable through the worker without a session, unlike the /api/v2 twin', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(request({ url: URL_UNDER_READ }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const gatedCtx = createExecutionContext();
    const gated = await worker.fetch(
      new Request('https://api.example/api/v2/margin-highlights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify({ url: URL_UNDER_READ }),
      }),
      env,
      gatedCtx
    );
    await waitOnExecutionContext(gatedCtx);
    expect(gated.status).toBe(401);
  });

  it('rejects a non-POST and a body with no url', async () => {
    expect(
      (await handleGuestMarginHighlights(request(null, '198.51.100.8', 'GET'), env)).status
    ).toBe(405);
    expect((await handleGuestMarginHighlights(request({}, '198.51.100.9'), env)).status).toBe(400);
    expect(proxyCalls).toEqual([]);
  });

  // Per-IP, because an anonymous caller has no DID to key the usual limit on.
  it('rate limits per IP, and one IP does not spend another IP budget', async () => {
    const { limit } = getRateLimitConfig('/api/guest/margin-highlights');

    for (let i = 0; i < limit; i++) {
      const res = await handleGuestMarginHighlights(
        request({ url: `${URL_UNDER_READ}/${i}` }, '198.51.100.10'),
        env
      );
      expect(res.status).toBe(200);
    }

    const limited = await handleGuestMarginHighlights(
      request({ url: URL_UNDER_READ }, '198.51.100.10'),
      env
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    // The limit stopped the proxy call too, not just the response.
    expect(proxyCalls).toHaveLength(limit);

    const other = await handleGuestMarginHighlights(
      request({ url: URL_UNDER_READ }, '198.51.100.11'),
      env
    );
    expect(other.status).toBe(200);
  });
});
