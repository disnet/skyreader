import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createApp, initDatabase, type AppConfig } from './app';
import { getSocialContext } from './constellation';

const DEFAULT_CONFIG: AppConfig = {
  proxySecret: 'test-secret',
  cacheTtlMs: 15 * 60 * 1000,
  staleTtlMs: 60 * 60 * 1000,
  defaultLimit: 100,
};

const DOC_URI = 'at://did:plc:author/site.standard.document/doc1';

function createTestApp(config: Partial<AppConfig> = {}) {
  const db = new Database(':memory:');
  initDatabase(db);
  const built = createApp(db, { ...DEFAULT_CONFIG, ...config });
  return { db, ...built };
}

// Mock the one Constellation endpoint the context still reads.
//
// It's asked once per `links` shape: the legacy array (`.links[].uri`) and the
// union object Skyreader writes now (`.links.refs[].uri`). A given reshare is
// indexed at exactly one of them, so the mock answers them separately and the
// context sums.
function mockConstellationFetch(opts: { legacy?: number; union?: number } = {}) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = String(input);
    if (url.includes('/links/count')) {
      const isUnion = decodeURIComponent(url).includes('.links.refs[].uri');
      return new Response(JSON.stringify({ total: (isUnion ? opts.union : opts.legacy) ?? 0 }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch);
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe('getSocialContext', () => {
  it('returns empty without throwing when query is empty', async () => {
    const { db } = createTestApp();
    const ctx = await getSocialContext(db, {});
    expect(ctx).toEqual({ quoteCount: 0 });
  });

  it('counts the posts quoting this one', async () => {
    const { db } = createTestApp();
    mockConstellationFetch({ legacy: 1 });

    const ctx = await getSocialContext(db, { docUri: DOC_URI });
    expect(ctx).toEqual({ quoteCount: 1 });
  });

  // Reshares written before the lexicon change are indexed under the array path
  // and newer ones under the union path. Asking only one would undercount a post
  // quoted on both sides of the change.
  it('sums quotes across both `links` shapes', async () => {
    const { db } = createTestApp();
    mockConstellationFetch({ legacy: 2, union: 3 });

    const ctx = await getSocialContext(db, { docUri: DOC_URI });
    expect(ctx).toEqual({ quoteCount: 5 });
  });

  // The context used to fan out to every linker's PDS for their note. Nothing
  // renders that now, so nothing should fetch it: the only calls are the
  // /links/count pair, one per `links` shape.
  it('reads only the quote count — no per-linker PDS fan-out', async () => {
    const { db } = createTestApp();
    const spy = mockConstellationFetch({ legacy: 2 });
    await getSocialContext(db, { docUri: DOC_URI });
    expect(spy.mock.calls.length).toBe(2);
    expect(spy.mock.calls.every(([input]) => String(input).includes('/links/count'))).toBe(true);
  });

  it('serves a cached bundle on the second call (no extra fetches)', async () => {
    const { db } = createTestApp();
    const spy = mockConstellationFetch({ legacy: 5 });
    await getSocialContext(db, { docUri: DOC_URI });
    const callsAfterFirst = spy.mock.calls.length;
    await getSocialContext(db, { docUri: DOC_URI });
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('POST /social-context', () => {
  const post = (
    app: {
      request: (p: string, i: RequestInit) => Response | Promise<Response>;
    },
    body: unknown
  ) =>
    app.request('/social-context', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': 'test-secret',
      },
      body: JSON.stringify(body),
    });

  it('rejects a missing items array', async () => {
    const { app } = createTestApp();
    const res = await post(app, {});
    expect(res.status).toBe(400);
  });

  it('returns a per-item context keyed back to the request', async () => {
    const { app } = createTestApp();
    mockConstellationFetch({ legacy: 2 });
    const res = await post(app, { items: [{ key: 'a', docUri: DOC_URI }] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      items: Array<{ key: string; quoteCount: number }>;
    };
    expect(json.items[0].key).toBe('a');
    expect(json.items[0].quoteCount).toBe(2);
  });
});
