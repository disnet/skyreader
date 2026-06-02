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

const LINKER = 'did:plc:linker1';
const LINKER_PDS = 'https://pds.linker.example';
const DOC_URI = 'at://did:plc:author/site.standard.document/doc1';
const ARTICLE = 'https://example.com/the-article';

function createTestApp(config: Partial<AppConfig> = {}) {
  const db = new Database(':memory:');
  initDatabase(db);
  const built = createApp(db, { ...DEFAULT_CONFIG, ...config });
  return { db, ...built };
}

// Mock the Constellation endpoints + the linker's PLC + getRecord calls.
function mockConstellationFetch(
  opts: {
    recommendCount?: number;
    quoteCount?: number;
    linkingDids?: string[];
    note?: string;
  } = {}
) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = String(input);

    if (url.includes('/links/count/distinct-dids')) {
      return new Response(JSON.stringify({ total: opts.recommendCount ?? 0 }));
    }
    if (url.includes('/links/count')) {
      return new Response(JSON.stringify({ total: opts.quoteCount ?? 0 }));
    }
    if (url.includes('/links?')) {
      const linking_records = (opts.linkingDids ?? []).map((did, i) => ({
        did,
        collection: 'site.standard.document',
        rkey: `rk${i}`,
      }));
      return new Response(JSON.stringify({ total: linking_records.length, linking_records }));
    }
    if (url.startsWith('https://plc.directory/')) {
      return new Response(
        JSON.stringify({
          id: LINKER,
          alsoKnownAs: ['at://linker.bsky.social'],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: LINKER_PDS,
            },
          ],
        })
      );
    }
    if (url.includes('com.atproto.repo.getRecord')) {
      return new Response(
        JSON.stringify({
          value: {
            $type: 'site.standard.document',
            content: {
              $type: 'pub.leaflet.content',
              pages: [
                {
                  blocks: [
                    {
                      block: {
                        $type: 'pub.leaflet.blocks.text',
                        plaintext: opts.note ?? 'great read',
                      },
                    },
                  ],
                },
              ],
            },
          },
        })
      );
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
    expect(ctx).toEqual({ recommendCount: 0, quoteCount: 0, alsoLinkedBy: [] });
  });

  it('assembles counts + also-linked-by with resolved handles and notes', async () => {
    const { db } = createTestApp();
    mockConstellationFetch({
      recommendCount: 3,
      quoteCount: 1,
      linkingDids: [LINKER],
      note: 'love this',
    });

    const ctx = await getSocialContext(db, {
      docUri: DOC_URI,
      articleUrl: ARTICLE,
    });
    expect(ctx.recommendCount).toBe(3);
    expect(ctx.quoteCount).toBe(1);
    expect(ctx.alsoLinkedBy).toHaveLength(1);
    expect(ctx.alsoLinkedBy[0]).toMatchObject({
      did: LINKER,
      handle: 'linker.bsky.social',
      note: 'love this',
    });
  });

  it('excludes the link post author from also-linked-by', async () => {
    const { db } = createTestApp();
    mockConstellationFetch({ linkingDids: [LINKER] });
    const ctx = await getSocialContext(db, {
      docUri: DOC_URI,
      articleUrl: ARTICLE,
      excludeDid: LINKER,
    });
    expect(ctx.alsoLinkedBy).toHaveLength(0);
  });

  it('serves a cached bundle on the second call (no extra fetches)', async () => {
    const { db } = createTestApp();
    const spy = mockConstellationFetch({
      recommendCount: 5,
      articleUrl: ARTICLE,
    } as never);
    await getSocialContext(db, { docUri: DOC_URI, articleUrl: ARTICLE });
    const callsAfterFirst = spy.mock.calls.length;
    await getSocialContext(db, { docUri: DOC_URI, articleUrl: ARTICLE });
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
    mockConstellationFetch({ recommendCount: 2, linkingDids: [] });
    const res = await post(app, {
      items: [{ key: 'a', docUri: DOC_URI, articleUrl: ARTICLE }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      items: Array<{ key: string; recommendCount: number }>;
    };
    expect(json.items[0].key).toBe('a');
    expect(json.items[0].recommendCount).toBe(2);
  });
});
