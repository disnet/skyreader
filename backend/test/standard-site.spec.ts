import { env } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCanonicalUrl,
  digestScope,
  isValidDid,
  markpubToMarkdown,
  publishedAtMs,
  recordToDocument,
  resolveSiteMeta,
  EMPTY_SITE_META,
  filterByPublication,
  filterSinceUris,
  PUBLICATION_NEGATIVE_CACHE_TTL_MS,
} from '../src/services/standard-site';
import type { ProxyDocument } from '../src/services/feed-proxy-client';

const AUTHOR = 'did:plc:author';
const PUBLICATION = 'at://did:plc:author/site.standard.publication/pub1';

function doc(uri: string, cid: string): ProxyDocument {
  return { recordUri: uri, recordCid: cid } as ProxyDocument;
}

describe('isValidDid', () => {
  it('accepts real DIDs', () => {
    expect(isValidDid('did:plc:abcdef123456')).toBe(true);
    expect(isValidDid('did:web:example.com')).toBe(true);
  });

  // The whole point of the strict check: Jetstream rejects an `options_update`
  // wholesale on one malformed entry and closes the socket, so a value that merely
  // starts with "did:" must never reach the filter.
  it('rejects values that only look like DIDs', () => {
    expect(isValidDid('did:')).toBe(false);
    expect(isValidDid('did:plc:')).toBe(false);
    expect(isValidDid('did:PLC:abc')).toBe(false);
    expect(isValidDid('not-a-did')).toBe(false);
    expect(isValidDid('did:plc:abc ')).toBe(false);
    expect(isValidDid(null)).toBe(false);
    expect(isValidDid('did:plc:' + 'a'.repeat(3000))).toBe(false);
  });
});

describe('digestScope', () => {
  // Parity with the proxy's `digestScope` (sha256 over sorted "uri\tcid" pairs
  // joined by newlines). The expected values are the proxy algorithm's output for
  // these fixtures, so a drift in either implementation fails here rather than in
  // production as a permanent client cache miss.
  it('matches the proxy digest for the same documents', async () => {
    const documents = [
      doc('at://did:plc:author/site.standard.document/3lb', 'bafyreib'),
      doc('at://did:plc:author/site.standard.document/3la', 'bafyreia'),
    ];
    await expect(digestScope(documents)).resolves.toBe(
      '15e6a709a682456eb0d24ae380af5bb81e301858d0297c86a467a28053de288e'
    );
  });

  it('digests the empty scope to the empty-string hash', async () => {
    await expect(digestScope([])).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('is order-independent but cid-sensitive', async () => {
    const a = doc('at://did:plc:author/site.standard.document/1', 'cid1');
    const b = doc('at://did:plc:author/site.standard.document/2', 'cid2');
    expect(await digestScope([a, b])).toBe(await digestScope([b, a]));
    expect(await digestScope([a, b])).not.toBe(
      await digestScope([a, doc('at://did:plc:author/site.standard.document/2', 'cid2-edited')])
    );
  });
});

describe('buildCanonicalUrl', () => {
  it('normalizes slashes between base and path', () => {
    expect(buildCanonicalUrl('https://ex.com/', '/post')).toBe('https://ex.com/post');
    expect(buildCanonicalUrl('https://ex.com', 'post')).toBe('https://ex.com/post');
    expect(buildCanonicalUrl('https://ex.com', '')).toBe('https://ex.com');
    expect(buildCanonicalUrl('', '/post')).toBe('/post');
  });
});

describe('markpubToMarkdown', () => {
  it('flattens both the structured and the legacy string form', () => {
    expect(markpubToMarkdown({ text: { markdown: '# hi' } })).toBe('# hi');
    expect(markpubToMarkdown('# hi')).toBe('# hi');
    expect(markpubToMarkdown(undefined)).toBeUndefined();
    expect(markpubToMarkdown('')).toBeUndefined();
  });
});

describe('recordToDocument', () => {
  it('maps a record into the wire shape', () => {
    const mapped = recordToDocument(
      AUTHOR,
      `at://${AUTHOR}/site.standard.document/3la`,
      'bafycid',
      {
        site: PUBLICATION,
        title: 'A Post',
        path: '/a-post',
        publishedAt: '2026-01-02T03:04:05.000Z',
        description: 'about things',
        tags: ['reading'],
        links: [{ uri: 'https://example.com/article', rel: 'related' }, { rel: 'noop' }],
        skyreaderLinkblog: 'https://skyreader.app/linkblog',
      },
      { ...EMPTY_SITE_META, baseUrl: 'https://ex.com', icon: 'https://cdn/icon', name: 'Ex' },
      { indexedAt: '2026-02-01T00:00:00.000Z' }
    );

    expect(mapped.canonicalUrl).toBe('https://ex.com/a-post');
    expect(mapped.siteIcon).toBe('https://cdn/icon');
    expect(mapped.publishedAt).toBe('2026-01-02T03:04:05.000Z');
    // createdAt falls back to publishedAt when the record carries none.
    expect(mapped.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(mapped.indexedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(mapped.tags).toEqual(['reading']);
    // Link entries without a uri are dropped, not emitted as holes.
    expect(mapped.links).toEqual([{ uri: 'https://example.com/article', rel: 'related' }]);
    expect(mapped.skyreaderLinkblog).toBe('https://skyreader.app/linkblog');
  });

  it('falls back to the bare path when the publication has no base URL', () => {
    const mapped = recordToDocument(
      AUTHOR,
      'at://x/site.standard.document/1',
      'cid',
      {
        path: '/loose',
      },
      EMPTY_SITE_META
    );
    expect(mapped.canonicalUrl).toBe('/loose');
    expect(mapped.title).toBe('');
  });
});

describe('publishedAtMs', () => {
  it('falls back when the record has no usable date', () => {
    expect(publishedAtMs({ publishedAt: '2026-01-01T00:00:00.000Z' }, 5)).toBe(
      Date.parse('2026-01-01T00:00:00.000Z')
    );
    expect(publishedAtMs({ publishedAt: 'nonsense' }, 5)).toBe(5);
    expect(publishedAtMs({}, 5)).toBe(5);
  });
});

describe('scope helpers', () => {
  it('filters by publication and stops at the first seen uri', () => {
    const docs = [
      { recordUri: 'a', siteUri: PUBLICATION } as ProxyDocument,
      { recordUri: 'b', siteUri: 'at://other/site.standard.publication/x' } as ProxyDocument,
    ];
    expect(filterByPublication(docs, PUBLICATION).map((d) => d.recordUri)).toEqual(['a']);
    expect(filterByPublication(docs).length).toBe(2);
    expect(filterSinceUris(docs, new Set(['b'])).map((d) => d.recordUri)).toEqual(['a']);
    expect(filterSinceUris(docs, new Set()).length).toBe(2);
  });
});

describe('resolveSiteMeta', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await env.DB.prepare('DELETE FROM publications_cache_v2').run();
  });

  it('treats a loose https site as its own base URL without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const meta = await resolveSiteMeta(env, 'https://blog.example');
    expect(meta.baseUrl).toBe('https://blog.example');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves a publication once and then serves it from D1', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('plc.directory')) {
        return new Response(
          JSON.stringify({
            id: AUTHOR,
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://pds.example',
              },
            ],
          })
        );
      }
      if (url.includes('site.standard.publication')) {
        return new Response(
          JSON.stringify({ value: { url: 'https://ex.com', name: 'Ex', basicTheme: {} } })
        );
      }
      // publicationTheme sidecar — absent is the common case.
      return new Response('{}', { status: 404 });
    });

    const first = await resolveSiteMeta(env, PUBLICATION);
    expect(first.baseUrl).toBe('https://ex.com');
    expect(first.name).toBe('Ex');
    const callsAfterFirst = fetchSpy.mock.calls.length;

    const second = await resolveSiteMeta(env, PUBLICATION);
    expect(second.baseUrl).toBe('https://ex.com');
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('caches a failed resolution only briefly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const meta = await resolveSiteMeta(env, PUBLICATION);
    expect(meta.baseUrl).toBeNull();

    const row = await env.DB.prepare(
      'SELECT cached_at FROM publications_cache_v2 WHERE publication_uri = ?'
    )
      .bind(PUBLICATION)
      .first<{ cached_at: number }>();
    expect(row).not.toBeNull();

    // Age the negative entry past its short TTL: the next read must re-resolve
    // rather than pin every document's canonical URL to a bare path for a day.
    await env.DB.prepare('UPDATE publications_cache_v2 SET cached_at = ? WHERE publication_uri = ?')
      .bind(Date.now() - PUBLICATION_NEGATIVE_CACHE_TTL_MS - 1000, PUBLICATION)
      .run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockClear();
    await resolveSiteMeta(env, PUBLICATION);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
