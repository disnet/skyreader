import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { verify } from 'web-bot-auth';
import { verifierFromJWK } from 'web-bot-auth/crypto';
import { fetchUpstream, configureWebBotAuth, HONEST_UA } from './app';
import { generateWebBotAuthKey, loadWebBotAuth } from './web-bot-auth';

const AGENT = 'https://api.skyreader.app';

const URL = 'https://refusing.example.com/feed';

function headersOf(init: unknown): Record<string, string> {
  return ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
}

// One identity, one attempt. The browser-UA retry this replaced is gone on
// purpose (see the HONEST_UA comment in app.ts): a refusal is an answer.
describe('fetchUpstream', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchMock?.mockRestore();
    configureWebBotAuth(null);
  });

  function record(respond: (headers: Record<string, string>) => Response) {
    const seen: Record<string, string>[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: unknown,
      init: unknown
    ) => {
      const h = headersOf(init);
      seen.push(h);
      return respond(h);
    }) as unknown as typeof fetch);
    return seen;
  }

  async function configureFreshIdentity() {
    const jwk = await generateWebBotAuthKey();
    configureWebBotAuth(await loadWebBotAuth({ key: JSON.stringify(jwk), signatureAgent: AGENT }));
    return jwk;
  }

  it('sends the caller headers as-is and returns a 403 without retrying', async () => {
    const seen = record(() => new Response('blocked', { status: 403 }));
    const res = await fetchUpstream(URL, { 'User-Agent': HONEST_UA, 'If-None-Match': '"abc"' });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0]['User-Agent']).toBe(HONEST_UA);
    expect(seen[0]['If-None-Match']).toBe('"abc"');
    expect(seen[0]['Signature-Agent']).toBeUndefined();
  });

  it('signs every fetch once an identity is configured', async () => {
    const jwk = await configureFreshIdentity();
    const seen = record(() => new Response('<rss/>', { status: 200 }));
    await fetchUpstream(URL, { 'User-Agent': HONEST_UA });
    expect(seen).toHaveLength(1);
    expect(seen[0]['User-Agent']).toBe(HONEST_UA);
    expect(seen[0]['Signature-Agent']).toBe(`"${AGENT}"`);
    expect(seen[0]['Signature-Input']).toContain('tag="web-bot-auth"');
    expect(seen[0]['Signature-Input']).toContain(`keyid="${jwk.kid}"`);
    expect(seen[0].Signature).toMatch(/^sig1=:/);
  });

  it('propagates a timeout as a TimeoutError', async () => {
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: unknown,
      init?: RequestInit
    ) => {
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
      return new Response('unreachable');
    }) as unknown as typeof fetch);
    const err = await fetchUpstream(URL, { 'User-Agent': HONEST_UA }, { fetchTimeoutMs: 20 }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('TimeoutError');
  });
});

// safeFetch follows redirects itself, re-validating each hop. The signature
// covers @authority, so a hop must carry its OWN signature: headers replayed
// from the previous hop verify against the wrong host and land as a *failed*
// signature, which a verifier (Cloudflare's included) treats as worse than an
// unsigned request. Redirecting feed URLs are ordinary, so this is the common
// case, not the edge one.
describe('fetchUpstream across redirects', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchMock?.mockRestore();
    configureWebBotAuth(null);
  });

  it('signs each hop for the host it actually reaches', async () => {
    const jwk = await generateWebBotAuthKey();
    configureWebBotAuth(await loadWebBotAuth({ key: JSON.stringify(jwk), signatureAgent: AGENT }));
    const verifier = await verifierFromJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JsonWebKey);

    const hops: Array<{ url: string; headers: Record<string, string> }> = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      url: unknown,
      init: unknown
    ) => {
      const target = String(url);
      hops.push({ url: target, headers: { ...headersOf(init) } });
      return target === 'http://example.com/feed.xml'
        ? new Response(null, {
            status: 301,
            headers: { location: 'https://www.example.com/feed.xml' },
          })
        : new Response('<rss/>', { status: 200 });
    }) as unknown as typeof fetch);

    const res = await fetchUpstream('http://example.com/feed.xml', { 'User-Agent': HONEST_UA });
    expect(res.status).toBe(200);
    expect(hops.map((h) => h.url)).toEqual([
      'http://example.com/feed.xml',
      'https://www.example.com/feed.xml',
    ]);

    // The point of the test: each hop verifies against the URL it was sent to.
    for (const hop of hops) {
      const verified = await verify(new Request(hop.url, { headers: hop.headers }), {
        resolver: () => verifier,
        validate: () => {},
      });
      expect(verified.signatureAgent?.uri).toBe(AGENT);
      expect(hop.headers['User-Agent']).toBe(HONEST_UA);
    }
    expect(hops[0].headers.Signature).not.toBe(hops[1].headers.Signature);
  });

  it('leaves the caller headers alone when no identity is configured', async () => {
    const hops: Array<Record<string, string>> = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      url: unknown,
      init: unknown
    ) => {
      hops.push(headersOf(init));
      return String(url) === 'https://example.com/feed.xml'
        ? new Response(null, { status: 302, headers: { location: '/moved.xml' } })
        : new Response('<rss/>', { status: 200 });
    }) as unknown as typeof fetch);

    await fetchUpstream('https://example.com/feed.xml', { 'User-Agent': HONEST_UA });
    expect(hops).toHaveLength(2);
    for (const h of hops) {
      expect(h['User-Agent']).toBe(HONEST_UA);
      expect(h['Signature-Input']).toBeUndefined();
    }
  });

  it('aborts the chain when onRedirect rejects the target', async () => {
    const hops: string[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      hops.push(String(url));
      return String(url) === 'https://example.com/feed.xml'
        ? new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/f' } })
        : new Response('<rss/>', { status: 200 });
    }) as unknown as typeof fetch);

    const err = await fetchUpstream(
      'https://example.com/feed.xml',
      { 'User-Agent': HONEST_UA },
      {
        onRedirect: (target) => {
          throw new Error(`refused ${target}`);
        },
      }
    ).catch((e) => e);

    expect((err as Error).message).toBe('refused https://elsewhere.example/f');
    // The redirect target is never fetched.
    expect(hops).toEqual(['https://example.com/feed.xml']);
  });
});
