import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createApp, initDatabase, cleanupCache, type AppConfig } from './app';
import {
  buildCanonicalUrl,
  filterByPublication,
  filterSinceUris,
  digestScope,
  parseAtUri,
  resolveSiteMeta,
  recordToProxyDocument,
  fetchSingleDocument,
  type ProxyDocument,
} from './standard-site';

const DEFAULT_CONFIG: AppConfig = {
  proxySecret: 'test-secret',
  cacheTtlMs: 15 * 60 * 1000,
  staleTtlMs: 60 * 60 * 1000,
  defaultLimit: 100,
};

const AUTHOR = 'did:plc:author123';
const PDS = 'https://pds.example.com';
const PUB_URI = 'at://did:plc:author123/site.standard.publication/pub1';

function createTestApp(config: Partial<AppConfig> = {}) {
  const db = new Database(':memory:');
  initDatabase(db);
  const built = createApp(db, { ...DEFAULT_CONFIG, ...config });
  return { db, ...built };
}

// Routes the three upstream calls the proxy makes: PLC DID resolution, the
// publication getRecord, and the document listRecords. `docs` are raw record
// values; `listRecordsResponse` lets a test override pagination/errors.
function mockAtprotoFetch(opts: {
  docs?: Array<{ uri: string; cid: string; value: Record<string, unknown> }>;
  publication?: Record<string, unknown> | null;
  listStatus?: number;
}) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = String(input);

    if (url.startsWith('https://plc.directory/')) {
      return new Response(
        JSON.stringify({
          id: AUTHOR,
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: PDS,
            },
          ],
        })
      );
    }

    if (url.includes('com.atproto.repo.getRecord')) {
      if (opts.publication === null) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({
          value: opts.publication ?? {
            $type: 'site.standard.publication',
            url: 'https://blog.example.com',
            name: 'Example Blog',
            icon: { ref: { $link: 'iconcid' }, mimeType: 'image/jpeg' },
          },
        })
      );
    }

    if (url.includes('com.atproto.repo.listRecords')) {
      if (opts.listStatus && opts.listStatus !== 200) {
        return new Response('error', { status: opts.listStatus });
      }
      return new Response(JSON.stringify({ records: opts.docs ?? [] }));
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch);
}

function docRecord(rkey: string, value: Record<string, unknown>) {
  return {
    uri: `at://${AUTHOR}/site.standard.document/${rkey}`,
    cid: `cid-${rkey}`,
    value: { $type: 'site.standard.document', ...value },
  };
}

async function postDocuments(
  app: {
    request: (path: string, init: RequestInit) => Response | Promise<Response>;
  },
  authors: unknown
) {
  return app.request('/documents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Secret': 'test-secret',
    },
    body: JSON.stringify({ authors }),
  });
}

// A minimal resolved ProxyDocument, as it would be stored in document_cache.
function proxyDoc(overrides: Partial<ProxyDocument> = {}): ProxyDocument {
  return {
    authorDid: AUTHOR,
    recordUri: `at://${AUTHOR}/site.standard.document/${overrides.recordUri ?? 'doc'}`,
    recordCid: 'cid',
    siteUri: PUB_URI,
    title: 'Cached',
    publishedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Insert a document_cache row with explicit freshness/backoff columns.
function insertDocCache(
  db: Database,
  row: {
    did?: string;
    documents?: ProxyDocument[];
    fetchedAt: number;
    errorCount?: number;
    lastError?: string | null;
    nextRetryAt?: number | null;
    lastRequestedAt?: number | null;
    // Last full PDS re-list. Defaults to fetchedAt (the two only diverge once a
    // firehose splice has bumped fetched_at); null models a pre-migration row.
    listedAt?: number | null;
  }
) {
  db.run(
    `INSERT INTO document_cache (did, documents_json, cached_at, fetched_at, listed_at, error_count, last_error, last_error_at, next_retry_at, last_requested_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.did ?? AUTHOR,
      JSON.stringify(row.documents ?? []),
      row.fetchedAt,
      row.fetchedAt,
      row.listedAt === undefined ? row.fetchedAt : row.listedAt,
      row.errorCount ?? 0,
      row.lastError ?? null,
      row.lastError ? row.fetchedAt : null,
      row.nextRetryAt ?? null,
      row.lastRequestedAt ?? null,
    ]
  );
}

describe('standard-site helpers', () => {
  it('parses at:// URIs', () => {
    expect(parseAtUri(PUB_URI)).toEqual({
      did: 'did:plc:author123',
      collection: 'site.standard.publication',
      rkey: 'pub1',
    });
    expect(parseAtUri('https://not-at-uri')).toBeNull();
    expect(parseAtUri('at://did:plc:x/only-two')).toBeNull();
  });

  it('builds canonical URLs with slash normalization', () => {
    expect(buildCanonicalUrl('https://b.com/', '/post')).toBe('https://b.com/post');
    expect(buildCanonicalUrl('https://b.com', 'post')).toBe('https://b.com/post');
    expect(buildCanonicalUrl('https://b.com', '')).toBe('https://b.com');
  });

  it('filters by publication scope', () => {
    const docs = [
      { siteUri: PUB_URI } as ProxyDocument,
      { siteUri: '' } as ProxyDocument,
      { siteUri: 'https://loose.example.com' } as ProxyDocument,
    ];
    expect(filterByPublication(docs).length).toBe(3);
    expect(filterByPublication(docs, PUB_URI)).toEqual([docs[0]]);
  });

  it('trims documents the client already has (since_uris)', () => {
    const docs = [
      { recordUri: 'c' } as ProxyDocument,
      { recordUri: 'b' } as ProxyDocument,
      { recordUri: 'a' } as ProxyDocument,
    ];
    expect(filterSinceUris(docs, new Set(['b'])).map((d) => d.recordUri)).toEqual(['c']);
    expect(filterSinceUris(docs, new Set()).length).toBe(3);
  });

  describe('digestScope', () => {
    const pair = (recordUri: string, recordCid: string) =>
      ({ recordUri, recordCid }) as ProxyDocument;

    it('is identical for the same set regardless of order', () => {
      const a = [pair('u1', 'c1'), pair('u2', 'c2')];
      const b = [pair('u2', 'c2'), pair('u1', 'c1')];
      expect(digestScope(a)).toBe(digestScope(b));
    });

    it('changes when a NEW document is added', () => {
      const before = [pair('u1', 'c1')];
      const after = [pair('u1', 'c1'), pair('u2', 'c2')];
      expect(digestScope(after)).not.toBe(digestScope(before));
    });

    it('changes when a document is EDITED (recordCid moves)', () => {
      const before = [pair('u1', 'c1')];
      const after = [pair('u1', 'c2')];
      expect(digestScope(after)).not.toBe(digestScope(before));
    });

    it('changes when a document is DELETED (pair removed)', () => {
      const before = [pair('u1', 'c1'), pair('u2', 'c2')];
      const after = [pair('u1', 'c1')];
      expect(digestScope(after)).not.toBe(digestScope(before));
    });

    it('is stable across repeated calls (deterministic hash)', () => {
      const docs = [pair('u1', 'c1'), pair('u2', 'c2')];
      expect(digestScope(docs)).toBe(digestScope([...docs]));
    });
  });
});

describe('POST /documents', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    fetchMock?.mockRestore();
    fetchMock = undefined;
  });

  it('rejects requests without the proxy secret', async () => {
    const { app } = createTestApp();
    const res = await app.request('/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authors: [{ did: AUTHOR }] }),
    });
    expect(res.status).toBe(401);
  });

  it('resolves documents with canonical URL + site icon', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({
      docs: [
        docRecord('doc1', {
          site: PUB_URI,
          title: 'Hello',
          path: '/hello',
          publishedAt: '2024-01-02T00:00:00Z',
          createdAt: '2024-01-02T00:00:00Z',
          coverImage: { ref: { $link: 'covercid' }, mimeType: 'image/jpeg' },
          content: { $type: 'pub.leaflet.document', pages: [] },
          links: [{ uri: 'https://example.com/the-article', rel: 'related' }, { rel: 'nouri' }],
        }),
      ],
    });

    const res = await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      authors: Array<{ status: string; documents: ProxyDocument[] }>;
    };
    const entry = json.authors[0];
    expect(entry.status).toBe('ready');
    expect(entry.documents.length).toBe(1);
    const doc = entry.documents[0];
    expect(doc.title).toBe('Hello');
    expect(doc.canonicalUrl).toBe('https://blog.example.com/hello');
    expect(doc.coverImageCid).toBe('covercid');
    expect(doc.siteIcon).toContain('iconcid');
    expect(doc.content).toEqual({ $type: 'pub.leaflet.document', pages: [] });
    // The external link survives fetch→cache→response; entries without a uri are dropped.
    expect(doc.links).toEqual([{ uri: 'https://example.com/the-article', rel: 'related' }]);
  });

  it('applies the publication filter and returns newest first', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({
      docs: [
        docRecord('a', {
          site: PUB_URI,
          title: 'A',
          publishedAt: '2024-01-01T00:00:00Z',
        }),
        docRecord('b', {
          site: '',
          title: 'Freestanding',
          publishedAt: '2024-03-01T00:00:00Z',
        }),
        docRecord('c', {
          site: PUB_URI,
          title: 'C',
          publishedAt: '2024-02-01T00:00:00Z',
        }),
      ],
    });

    // Scoped to the publication: excludes the doc without an at:// publication.
    const scoped = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])
    ).json()) as {
      authors: Array<{ documents: ProxyDocument[] }>;
    };
    expect(scoped.authors[0].documents.map((d) => d.title)).toEqual(['C', 'A']);

    // Unscoped: all of the author's documents, newest first.
    const all = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{ documents: ProxyDocument[] }>;
    };
    expect(all.authors[0].documents.map((d) => d.title)).toEqual(['Freestanding', 'C', 'A']);
  });

  it('marks the result complete when the author is under the per-author cap', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({
      docs: [docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' })],
    });

    const json = (await (await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])).json()) as {
      authors: Array<{ status: string; complete?: boolean }>;
    };
    // A small set fit under the cap → the whole document set was returned, so a
    // client may treat any locally-known-but-absent share as deleted.
    expect(json.authors[0].status).toBe('ready');
    expect(json.authors[0].complete).toBe(true);
  });

  it('serves a second request from cache (single upstream fetch round)', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({
      docs: [
        docRecord('a', {
          site: PUB_URI,
          title: 'A',
          publishedAt: '2024-01-01T00:00:00Z',
        }),
      ],
    });

    await postDocuments(app, [{ did: AUTHOR }]);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await postDocuments(app, [{ did: AUTHOR }]);
    // Fresh cache hit → no new upstream calls.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('reports an error result when listRecords fails and no cache exists', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({ listStatus: 500 });

    const json = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{ status: string; error?: string }>;
    };
    expect(json.authors[0].status).toBe('error');
  });

  it('shortens a legacy error-placeholder backoff when the author is requested', async () => {
    const { db, app } = createTestApp();
    const now = Date.now();
    insertDocCache(db, {
      documents: [],
      fetchedAt: now,
      listedAt: now,
      lastRequestedAt: now - 1000,
      errorCount: 5,
      nextRetryAt: now + 7 * 24 * 60 * 60 * 1000,
    });

    const json = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{ status: string; nextRetryAt?: number }>;
    };
    const row = db
      .query<{ next_retry_at: number }, [string]>(
        'SELECT next_retry_at FROM document_cache WHERE did = ?'
      )
      .get(AUTHOR);

    expect(json.authors[0].status).toBe('error');
    expect(row!.next_retry_at).toBeLessThanOrEqual(Date.now() + 6 * 60 * 60 * 1000);
    expect(json.authors[0].nextRetryAt).toBe(row!.next_retry_at);
  });

  it('rejects an empty authors array', async () => {
    const { app } = createTestApp();
    const res = await postDocuments(app, []);
    expect(res.status).toBe(400);
  });

  // --- per-scope digest short-circuit ---------------------------------------

  it('cold start returns the full set plus a digest (no since_digest)', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({
      docs: [docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' })],
    });

    const json = (await (await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])).json()) as {
      authors: Array<{ status: string; documents?: ProxyDocument[]; digest?: string }>;
    };
    const entry = json.authors[0];
    expect(entry.status).toBe('ready');
    expect(entry.documents?.length).toBe(1);
    expect(typeof entry.digest).toBe('string');
    expect(entry.digest!.length).toBeGreaterThan(0);
  });

  it('returns status:unchanged with no body when since_digest matches', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({
      docs: [docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' })],
    });

    const first = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])
    ).json()) as {
      authors: Array<{ digest?: string }>;
    };
    const digest = first.authors[0].digest!;

    const second = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI, since_digest: digest }])
    ).json()) as {
      authors: Array<{ status: string; documents?: ProxyDocument[]; digest?: string }>;
    };
    const entry = second.authors[0];
    expect(entry.status).toBe('unchanged');
    expect(entry.documents).toBeUndefined();
    expect(entry.digest).toBeUndefined();
  });

  it('stays unchanged across a forced refetch with no upstream change (stable recordCid)', async () => {
    // Low TTL so the second request forces a real re-list rather than a cache hit.
    const { db, app } = createTestApp({ cacheTtlMs: 1, staleTtlMs: 1 });
    fetchMock = mockAtprotoFetch({
      docs: [docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' })],
    });

    const first = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])
    ).json()) as {
      authors: Array<{ digest?: string }>;
    };
    const digest = first.authors[0].digest!;

    // Age the cache past the stale window so the next poll re-pulls and rewrites
    // the blob; the upstream content (and so each recordCid) is identical.
    db.run('UPDATE document_cache SET fetched_at = ? WHERE did = ?', [Date.now() - 60_000, AUTHOR]);

    const second = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI, since_digest: digest }])
    ).json()) as { authors: Array<{ status: string }> };
    // A refetch happened, but the recomputed digest is identical → still unchanged.
    expect(second.authors[0].status).toBe('unchanged');
  });

  it('returns the full set with a new digest when a doc is added across a refetch', async () => {
    const { db, app } = createTestApp({ cacheTtlMs: 1, staleTtlMs: 1 });
    fetchMock = mockAtprotoFetch({
      docs: [docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' })],
    });

    const first = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])
    ).json()) as {
      authors: Array<{ digest?: string }>;
    };
    const digest = first.authors[0].digest!;

    // Upstream now publishes a second doc; force a refetch.
    fetchMock.mockRestore();
    fetchMock = mockAtprotoFetch({
      docs: [
        docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' }),
        docRecord('b', { site: PUB_URI, title: 'B', publishedAt: '2024-02-01T00:00:00Z' }),
      ],
    });
    db.run('UPDATE document_cache SET fetched_at = ? WHERE did = ?', [Date.now() - 60_000, AUTHOR]);

    const second = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI, since_digest: digest }])
    ).json()) as {
      authors: Array<{ status: string; documents?: ProxyDocument[]; digest?: string }>;
    };
    const entry = second.authors[0];
    expect(entry.status).toBe('ready');
    expect(entry.documents?.map((d) => d.title)).toEqual(['B', 'A']);
    expect(entry.digest).not.toBe(digest);
  });

  it('keeps digests per publication scope (no cross-scope leakage)', async () => {
    const PUB_Q = 'at://did:plc:author123/site.standard.publication/pubQ';
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({
      docs: [
        docRecord('p1', { site: PUB_URI, title: 'P1', publishedAt: '2024-01-01T00:00:00Z' }),
        docRecord('q1', { site: PUB_Q, title: 'Q1', publishedAt: '2024-01-02T00:00:00Z' }),
      ],
    });

    const p = (await (await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])).json()) as {
      authors: Array<{ digest?: string }>;
    };
    const q = (await (await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_Q }])).json()) as {
      authors: Array<{ digest?: string }>;
    };
    // Different scopes hash different sets → different digests; P's digest must not
    // satisfy Q's request.
    expect(p.authors[0].digest).not.toBe(q.authors[0].digest);
    const qWithP = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_Q, since_digest: p.authors[0].digest }])
    ).json()) as { authors: Array<{ status: string }> };
    expect(qWithP.authors[0].status).toBe('ready');
  });

  it('returns status:error (never unchanged) when the blob is non-authoritative', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({ listStatus: 500 });

    // Even with a since_digest in hand, an un-backfillable blob must not
    // short-circuit to unchanged or serve an empty full-replace.
    const json = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI, since_digest: 'whatever' }])
    ).json()) as { authors: Array<{ status: string }> };
    expect(json.authors[0].status).toBe('error');
  });

  it('serves the full blob for a legacy client sending neither since_digest nor since_uris', async () => {
    const { app } = createTestApp();
    fetchMock = mockAtprotoFetch({
      docs: [docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' })],
    });

    const json = (await (await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])).json()) as {
      authors: Array<{ status: string; documents?: ProxyDocument[] }>;
    };
    expect(json.authors[0].status).toBe('ready');
    expect(json.authors[0].documents?.length).toBe(1);
  });
});

describe('POST /documents cache lifecycle', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchMock?.mockRestore();
    fetchMock = undefined;
  });

  it('serves stale documents immediately and refreshes in the background', async () => {
    const { db, app, inFlightDocs } = createTestApp({
      cacheTtlMs: 1000,
      staleTtlMs: 60_000,
    });
    // Fetched 5s ago: older than the 1s fresh TTL, within the 60s stale window.
    insertDocCache(db, {
      documents: [proxyDoc({ recordUri: 'stale', title: 'Stale' })],
      fetchedAt: Date.now() - 5000,
      lastRequestedAt: Date.now() - 5000,
    });
    fetchMock = mockAtprotoFetch({
      docs: [
        docRecord('fresh', {
          site: PUB_URI,
          title: 'Fresh',
          publishedAt: '2024-02-01T00:00:00Z',
        }),
      ],
    });

    const json = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{ status: string; documents: ProxyDocument[] }>;
    };
    // Returns the stale doc right away.
    expect(json.authors[0].status).toBe('ready');
    expect(json.authors[0].documents.map((d) => d.title)).toEqual(['Stale']);

    // A background refresh was triggered; wait for it and confirm the cache updated.
    expect(inFlightDocs.size).toBeGreaterThan(0);
    await Promise.all(inFlightDocs.values());
    const refreshed = db
      .query<{ documents_json: string }, [string]>(
        'SELECT documents_json FROM document_cache WHERE did = ?'
      )
      .get(AUTHOR);
    expect((JSON.parse(refreshed!.documents_json) as ProxyDocument[]).map((d) => d.title)).toEqual([
      'Fresh',
    ]);
  });

  it('returns the cached error during the backoff window without re-fetching', async () => {
    const { db, app } = createTestApp();
    const now = Date.now();
    // Pure error placeholder (no docs) still inside its backoff window.
    insertDocCache(db, {
      documents: [],
      fetchedAt: now,
      errorCount: 3,
      lastError: 'listRecords failed',
      nextRetryAt: now + 60_000,
      lastRequestedAt: now,
    });
    fetchMock = mockAtprotoFetch({}); // would succeed if it were ever called

    const json = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{
        status: string;
        error?: string;
        errorCount?: number;
        nextRetryAt?: number;
      }>;
    };
    const entry = json.authors[0];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('listRecords failed');
    expect(entry.errorCount).toBe(3);
    expect(entry.nextRetryAt).toBeGreaterThan(now);
    // Circuit breaker held: no upstream calls at all.
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('serves stale-but-real documents when a refresh errors, and records the error', async () => {
    const { db, app } = createTestApp({ cacheTtlMs: 1000, staleTtlMs: 2000 });
    // Older than the stale window → the handler attempts a blocking refresh.
    insertDocCache(db, {
      documents: [proxyDoc({ recordUri: 'real', title: 'Real' })],
      fetchedAt: Date.now() - 10_000,
      lastRequestedAt: Date.now() - 10_000,
    });
    fetchMock = mockAtprotoFetch({ listStatus: 500 }); // the refresh fails

    const json = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{ status: string; documents: ProxyDocument[] }>;
    };
    // Still served the real cached docs rather than an error.
    expect(json.authors[0].status).toBe('ready');
    expect(json.authors[0].documents.map((d) => d.title)).toEqual(['Real']);

    // The failure was recorded with a backoff for next time.
    const row = db
      .query<{ error_count: number; next_retry_at: number | null }, [string]>(
        'SELECT error_count, next_retry_at FROM document_cache WHERE did = ?'
      )
      .get(AUTHOR);
    expect(row!.error_count).toBe(1);
    expect(row!.next_retry_at).toBeGreaterThan(Date.now());
  });

  it('follows listRecords pagination across pages', async () => {
    const { app } = createTestApp();
    const seenCursors: Array<string | null> = [];
    let listCalls = 0;
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('https://plc.directory/')) {
        return new Response(
          JSON.stringify({
            id: AUTHOR,
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: PDS,
              },
            ],
          })
        );
      }
      if (url.includes('com.atproto.repo.getRecord')) {
        return new Response(
          JSON.stringify({
            value: {
              $type: 'site.standard.publication',
              url: 'https://blog.example.com',
            },
          })
        );
      }
      if (url.includes('com.atproto.repo.listRecords')) {
        // The collection sidecar listing is a separate call; this test only
        // exercises site.standard.document pagination, so ignore the rest.
        if (new URL(url).searchParams.get('collection') !== 'site.standard.document') {
          return new Response(JSON.stringify({ records: [] }));
        }
        seenCursors.push(new URL(url).searchParams.get('cursor'));
        listCalls++;
        if (listCalls === 1) {
          return new Response(
            JSON.stringify({
              records: [
                docRecord('a', {
                  site: PUB_URI,
                  title: 'A',
                  publishedAt: '2024-01-01T00:00:00Z',
                }),
                docRecord('b', {
                  site: PUB_URI,
                  title: 'B',
                  publishedAt: '2024-02-01T00:00:00Z',
                }),
              ],
              cursor: 'CURSOR2',
            })
          );
        }
        // Second page: no cursor → stop.
        return new Response(
          JSON.stringify({
            records: [
              docRecord('c', {
                site: PUB_URI,
                title: 'C',
                publishedAt: '2024-03-01T00:00:00Z',
              }),
            ],
          })
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);

    const json = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{ documents: ProxyDocument[] }>;
    };
    expect(json.authors[0].documents.map((d) => d.title)).toEqual(['C', 'B', 'A']);
    expect(listCalls).toBe(2);
    expect(seenCursors).toEqual([null, 'CURSOR2']);
  });
});

// The firehose fast path serves a covered author's cache without an age check.
// That is right for anything written while the stream was connected, and wrong
// for everything else — a reconnect gap, or a document that predates the cache
// row, which is every post of a publication the client has only just subscribed
// to. Without a floor, `documents_json` is frozen for as long as the author
// stays active, and the stable digest turns that into `unchanged` forever.
describe('POST /documents firehose-covered re-list floor', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchMock?.mockRestore();
    fetchMock = undefined;
  });

  const COVERED = { healthy: true, isSubscribed: () => true };

  it('re-lists a covered author whose last list is older than the floor', async () => {
    const { db, app, inFlightDocs } = createTestApp({
      firehoseRelistMs: 60_000,
      getFirehoseStatus: () => COVERED,
    });
    const now = Date.now();
    // Splices have kept `fetched_at` current; the last real list was long ago.
    insertDocCache(db, {
      documents: [proxyDoc({ recordUri: 'spliced', title: 'Spliced' })],
      fetchedAt: now - 1000,
      listedAt: now - 10 * 60_000,
      lastRequestedAt: now,
    });
    fetchMock = mockAtprotoFetch({
      docs: [docRecord('missed', { site: PUB_URI, title: 'Missed' })],
    });

    const json = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{ status: string; documents: ProxyDocument[] }>;
    };
    // Still served from cache — the refresh is background, not inline.
    expect(json.authors[0].status).toBe('ready');
    expect(json.authors[0].documents.map((d) => d.title)).toEqual(['Spliced']);

    expect(inFlightDocs.size).toBeGreaterThan(0);
    await Promise.all(inFlightDocs.values());
    const row = db
      .query<{ documents_json: string; listed_at: number }, [string]>(
        'SELECT documents_json, listed_at FROM document_cache WHERE did = ?'
      )
      .get(AUTHOR);
    expect((JSON.parse(row!.documents_json) as ProxyDocument[]).map((d) => d.title)).toEqual([
      'Missed',
    ]);
    expect(row!.listed_at).toBeGreaterThanOrEqual(now);
  });

  it('does not re-list a covered author listed inside the floor', async () => {
    const { db, app, inFlightDocs } = createTestApp({
      firehoseRelistMs: 60_000,
      getFirehoseStatus: () => COVERED,
    });
    const now = Date.now();
    insertDocCache(db, {
      documents: [proxyDoc({ recordUri: 'a', title: 'A' })],
      // Well past cacheTtlMs: only the firehose fast path can be serving this.
      fetchedAt: now - 30 * 60_000,
      listedAt: now - 5_000,
      lastRequestedAt: now,
    });
    fetchMock = mockAtprotoFetch({ docs: [docRecord('b', { site: PUB_URI, title: 'B' })] });

    const json = (await (await postDocuments(app, [{ did: AUTHOR }])).json()) as {
      authors: Array<{ documents: ProxyDocument[] }>;
    };
    expect(json.authors[0].documents.map((d) => d.title)).toEqual(['A']);
    expect(inFlightDocs.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-lists when a requested publication scope is empty but the author is not', async () => {
    const OTHER_PUB = `at://${AUTHOR}/site.standard.publication/pub2`;
    const { db, app, inFlightDocs } = createTestApp({
      cacheTtlMs: 1000,
      firehoseRelistMs: 24 * 60 * 60 * 1000, // floor far away; the scope check must fire
      getFirehoseStatus: () => COVERED,
    });
    const now = Date.now();
    // The author is cached, but only for the publication someone already read.
    // The newly-subscribed one has no documents here at all.
    insertDocCache(db, {
      documents: [proxyDoc({ recordUri: 'known', title: 'Known', siteUri: PUB_URI })],
      fetchedAt: now - 5_000,
      listedAt: now - 5_000,
      lastRequestedAt: now,
    });
    fetchMock = mockAtprotoFetch({
      docs: [
        docRecord('known', { site: PUB_URI, title: 'Known' }),
        docRecord('backlog', { site: OTHER_PUB, title: 'Backlog' }),
      ],
      publication: { name: 'Pub', url: 'https://example.com' },
    });

    const first = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: OTHER_PUB }])
    ).json()) as { authors: Array<{ documents: ProxyDocument[] }> };
    expect(first.authors[0].documents).toEqual([]);

    // The empty scope triggered a re-list rather than settling into `unchanged`.
    expect(inFlightDocs.size).toBeGreaterThan(0);
    await Promise.all(inFlightDocs.values());

    const second = (await (
      await postDocuments(app, [{ did: AUTHOR, siteUri: OTHER_PUB }])
    ).json()) as { authors: Array<{ documents: ProxyDocument[] }> };
    expect(second.authors[0].documents.map((d) => d.title)).toEqual(['Backlog']);
  });

  it('does not re-list an empty scope again inside the TTL', async () => {
    const EMPTY_PUB = `at://${AUTHOR}/site.standard.publication/empty`;
    const { db, app, inFlightDocs } = createTestApp({
      cacheTtlMs: 60_000,
      getFirehoseStatus: () => COVERED,
    });
    const now = Date.now();
    insertDocCache(db, {
      documents: [proxyDoc({ recordUri: 'known', title: 'Known' })],
      fetchedAt: now - 1_000,
      listedAt: now - 1_000,
      lastRequestedAt: now,
    });
    fetchMock = mockAtprotoFetch({ docs: [] });

    // A genuinely empty publication costs one refresh per TTL, not one per poll.
    await postDocuments(app, [{ did: AUTHOR, siteUri: EMPTY_PUB }]);
    expect(inFlightDocs.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('document cache repair guards', () => {
  it('backfills a pre-migration NULL listed_at from fetched_at', () => {
    const db = new Database(':memory:');
    initDatabase(db);
    const fetchedAt = Date.now() - 123_000;
    db.run(
      `INSERT INTO document_cache
       (did, documents_json, cached_at, fetched_at, listed_at, last_requested_at)
       VALUES (?, '[]', ?, ?, NULL, ?)`,
      [AUTHOR, fetchedAt, fetchedAt, fetchedAt]
    );

    initDatabase(db);

    const row = db
      .query<{ listed_at: number }, [string]>('SELECT listed_at FROM document_cache WHERE did = ?')
      .get(AUTHOR);
    expect(row?.listed_at).toBe(fetchedAt);
  });

  it('caps permanent-error backoff for an actively requested author', async () => {
    const { db, app } = createTestApp({ cacheTtlMs: 1, staleTtlMs: 2 });
    const now = Date.now();
    insertDocCache(db, {
      documents: [proxyDoc({ recordUri: 'real' })],
      fetchedAt: now - 10_000,
      listedAt: now - 10_000,
      lastRequestedAt: now,
      errorCount: 4,
    });
    const fetchMock = mockAtprotoFetch({ listStatus: 500 });

    await postDocuments(app, [{ did: AUTHOR }]);

    const row = db
      .query<{ error_count: number; next_retry_at: number }, [string]>(
        'SELECT error_count, next_retry_at FROM document_cache WHERE did = ?'
      )
      .get(AUTHOR);
    expect(row?.error_count).toBe(5);
    expect(row!.next_retry_at).toBeLessThanOrEqual(Date.now() + 6 * 60 * 60 * 1000);
    fetchMock.mockRestore();
  });
});

describe('resolveSiteMeta caching', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchMock?.mockRestore();
    fetchMock = undefined;
  });

  function freshDb() {
    const db = new Database(':memory:');
    initDatabase(db);
    return db;
  }

  function insertPubCache(db: Database, baseUrl: string | null, ageMs: number) {
    db.run(
      'INSERT INTO publication_cache (publication_uri, base_url, icon, cached_at) VALUES (?, ?, ?, ?)',
      [PUB_URI, baseUrl, null, Date.now() - ageMs]
    );
  }

  it('serves a fresh cached publication without re-fetching', async () => {
    const db = freshDb();
    insertPubCache(db, 'https://blog.example.com', 0);
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch);

    const meta = await resolveSiteMeta(db, PUB_URI);
    expect(meta.baseUrl).toBe('https://blog.example.com');
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('keeps a successful resolution past the negative window (long TTL)', async () => {
    const db = freshDb();
    // base_url present, cached 10 min ago: past the 5-min negative TTL but well within 24h.
    insertPubCache(db, 'https://blog.example.com', 10 * 60 * 1000);
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch);

    const meta = await resolveSiteMeta(db, PUB_URI);
    expect(meta.baseUrl).toBe('https://blog.example.com');
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('does not re-resolve a failed (null) publication within the negative TTL', async () => {
    const db = freshDb();
    insertPubCache(db, null, 60 * 1000); // 1 min ago, inside the 5-min window
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch);

    const meta = await resolveSiteMeta(db, PUB_URI);
    expect(meta.baseUrl).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('re-resolves a failed (null) publication once the negative TTL expires', async () => {
    const db = freshDb();
    insertPubCache(db, null, 10 * 60 * 1000); // 10 min ago, past the 5-min window
    fetchMock = mockAtprotoFetch({}); // PLC + getRecord succeed now

    const meta = await resolveSiteMeta(db, PUB_URI);
    expect(meta.baseUrl).toBe('https://blog.example.com');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('captures the publication name + basicTheme (and round-trips theme through the cache)', async () => {
    const db = freshDb();
    const theme = {
      accent: { r: 196, g: 33, b: 188 },
      background: { r: 255, g: 240, b: 254 },
      foreground: { r: 38, g: 4, b: 37 },
      accentForeground: { r: 255, g: 255, b: 255 },
    };
    fetchMock = mockAtprotoFetch({
      publication: {
        $type: 'site.standard.publication',
        url: 'https://blog.example.com',
        name: 'Dispatches from the Atmosphere',
        basicTheme: theme,
      },
    });

    const meta = await resolveSiteMeta(db, PUB_URI);
    expect(meta.name).toBe('Dispatches from the Atmosphere');
    expect(meta.theme).toEqual(theme);

    // Second call hits the SQLite cache (no further fetch) and still parses theme.
    fetchMock.mockClear();
    const cached = await resolveSiteMeta(db, PUB_URI);
    expect(cached.name).toBe('Dispatches from the Atmosphere');
    expect(cached.theme).toEqual(theme);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe('warmStaleDocuments', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchMock?.mockRestore();
    fetchMock = undefined;
  });

  it('refreshes a stale author that was recently requested', async () => {
    const { db, warmStaleDocuments } = createTestApp({
      cacheTtlMs: 1000,
      staleTtlMs: 60_000,
    });
    const oldFetched = Date.now() - 60 * 60 * 1000; // 1h ago → past the warm threshold
    insertDocCache(db, {
      documents: [],
      fetchedAt: oldFetched,
      lastRequestedAt: Date.now(),
    });
    fetchMock = mockAtprotoFetch({
      docs: [
        docRecord('w', {
          site: PUB_URI,
          title: 'Warmed',
          publishedAt: '2024-01-01T00:00:00Z',
        }),
      ],
    });

    const refreshed = await warmStaleDocuments();
    expect(refreshed).toBe(1);

    const row = db
      .query<{ documents_json: string; fetched_at: number }, [string]>(
        'SELECT documents_json, fetched_at FROM document_cache WHERE did = ?'
      )
      .get(AUTHOR);
    expect((JSON.parse(row!.documents_json) as ProxyDocument[]).map((d) => d.title)).toEqual([
      'Warmed',
    ]);
    expect(row!.fetched_at).toBeGreaterThan(oldFetched);
  });

  it('skips authors with no recent request', async () => {
    const { db, warmStaleDocuments } = createTestApp({
      cacheTtlMs: 1000,
      staleTtlMs: 60_000,
    });
    const oldFetched = Date.now() - 60 * 60 * 1000;
    // last_requested_at NULL → outside the active working set, never warmed.
    insertDocCache(db, {
      documents: [],
      fetchedAt: oldFetched,
      lastRequestedAt: null,
    });
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch);

    const refreshed = await warmStaleDocuments();
    expect(refreshed).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe('cleanupCache (documents)', () => {
  it('removes document_cache rows older than 7 days', () => {
    const db = new Database(':memory:');
    initDatabase(db);
    const now = Date.now();
    insertDocCache(db, {
      did: 'old',
      fetchedAt: now - 8 * 24 * 60 * 60 * 1000,
    });
    insertDocCache(db, {
      did: 'recent',
      fetchedAt: now - 6 * 24 * 60 * 60 * 1000,
    });

    const cleaned = cleanupCache(db);
    expect(cleaned).toBe(1);

    const remaining = db
      .query<{ did: string }, []>('SELECT did FROM document_cache')
      .all()
      .map((r) => r.did);
    expect(remaining).toEqual(['recent']);
  });
});

describe('readerCollection resolution', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  // Routes PLC resolution, the publication getRecord, and per-item document
  // getRecords. `items` maps an item rkey → its document record value (or null
  // for a 404), so a test can mix resolvable and unresolvable curated pieces.
  function mockCollectionFetch(
    items: Record<string, Record<string, unknown> | null>,
    opts: { fonts?: { title?: string; body?: string }; basicTheme?: Record<string, unknown> } = {}
  ) {
    return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = String(input);

      if (url.startsWith('https://plc.directory/')) {
        return new Response(
          JSON.stringify({
            id: AUTHOR,
            service: [
              { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
            ],
          })
        );
      }

      if (url.includes('com.atproto.repo.getRecord')) {
        const params = new URLSearchParams(url.split('?')[1]);
        const collection = params.get('collection');
        if (collection === 'site.standard.publication') {
          return new Response(
            JSON.stringify({
              value: {
                $type: 'site.standard.publication',
                url: 'https://blog.example.com',
                name: 'Example Blog',
                icon: { ref: { $link: 'iconcid' }, mimeType: 'image/jpeg' },
                ...(opts.basicTheme ? { basicTheme: opts.basicTheme } : {}),
              },
            })
          );
        }
        // The publication's typography sidecar (paired by rkey).
        if (collection === 'app.standard-reader.publicationTheme') {
          if (!opts.fonts) return new Response('not found', { status: 404 });
          return new Response(
            JSON.stringify({
              value: {
                $type: 'app.standard-reader.publicationTheme',
                publication: PUB_URI,
                fonts: opts.fonts,
              },
            })
          );
        }
        // A curated item's document record.
        const rkey = params.get('rkey') ?? '';
        const value = items[rkey];
        if (!value) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ value }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);
  }

  // Build a structured Markpub markdown body, the shape collection notes/editorial
  // use on the PDS (the resolver flattens it to plain markdown).
  function markpub(markdown: string) {
    return {
      text: { $type: 'at.markpub.text', markdown },
      $type: 'at.markpub.markdown',
      flavor: 'gfm',
    };
  }

  function itemUri(rkey: string) {
    return `at://${AUTHOR}/site.standard.document/${rkey}`;
  }

  it('resolves curated items to previews and carries editorial/colophon', async () => {
    const db = new Database(':memory:');
    initDatabase(db);
    mockCollectionFetch({
      good: {
        $type: 'site.standard.document',
        site: PUB_URI,
        title: 'A Resolved Piece',
        description: 'Its excerpt.',
        path: '/a-resolved-piece',
        publishedAt: '2026-06-01T00:00:00.000Z',
      },
    });

    const resolved = await recordToProxyDocument(
      db,
      AUTHOR,
      itemUri('edition'),
      'cid-edition',
      {
        $type: 'site.standard.document',
        site: PUB_URI,
        title: 'My Edition',
        publishedAt: '2026-06-10T00:00:00.000Z',
      },
      // The paired app.standard-reader.collection sidecar. Notes/editorial are
      // structured Markpub; the colophon is a legacy plain string — both flatten.
      {
        document: itemUri('edition'),
        editorial: { title: 'A Word Before', body: markpub('The intro.') },
        colophon: { body: 'The closing.' },
        items: [
          { document: itemUri('good'), note: markpub('Read this one.') },
          { document: itemUri('missing'), note: markpub('Could not resolve.') },
        ],
        createdAt: '2026-06-10T00:00:00.000Z',
      }
    );

    const rc = resolved.readerCollection;
    expect(rc).toBeDefined();
    expect(rc?.editorial?.title).toBe('A Word Before');
    expect(rc?.editorial?.body).toBe('The intro.');
    expect(rc?.colophon?.body).toBe('The closing.');
    expect(rc?.items).toHaveLength(2);

    // Resolved piece carries title + canonical URL + the (flattened) curator note
    // + the referenced publication's name (the magazine TOC source label).
    const good = rc!.items[0];
    expect(good.title).toBe('A Resolved Piece');
    expect(good.canonicalUrl).toBe('https://blog.example.com/a-resolved-piece');
    expect(good.note).toBe('Read this one.');
    expect(good.authorDid).toBe(AUTHOR);
    expect(good.sourceName).toBe('Example Blog');

    // The edition carries its own publication name (for the magazine masthead).
    expect(rc?.publicationName).toBe('Example Blog');

    // Unresolvable piece degrades to a note-only stub (the URI + note survive).
    const missing = rc!.items[1];
    expect(missing.document).toBe(itemUri('missing'));
    expect(missing.note).toBe('Could not resolve.');
    expect(missing.title).toBeUndefined();
    expect(missing.canonicalUrl).toBeUndefined();
  });

  it('carries publication fonts (publicationTheme) onto the edition', async () => {
    const db = new Database(':memory:');
    initDatabase(db);
    mockCollectionFetch(
      {
        good: {
          $type: 'site.standard.document',
          site: PUB_URI,
          title: 'A Resolved Piece',
          path: '/p',
          publishedAt: '2026-06-01T00:00:00.000Z',
        },
      },
      { fonts: { title: 'Black Ops One', body: 'Space Grotesk' } }
    );

    const resolved = await recordToProxyDocument(
      db,
      AUTHOR,
      itemUri('edition'),
      'cid-edition',
      {
        $type: 'site.standard.document',
        site: PUB_URI,
        title: 'My Edition',
        publishedAt: '2026-06-10T00:00:00.000Z',
      },
      {
        document: itemUri('edition'),
        items: [{ document: itemUri('good') }],
        createdAt: '2026-06-10T00:00:00.000Z',
      }
    );

    expect(resolved.readerCollection?.fonts).toEqual({
      title: 'Black Ops One',
      body: 'Space Grotesk',
    });
  });

  it('leaves readerCollection undefined for ordinary documents (no paired collection)', async () => {
    const db = new Database(':memory:');
    initDatabase(db);
    mockCollectionFetch({});

    const resolved = await recordToProxyDocument(db, AUTHOR, itemUri('plain'), 'cid-plain', {
      $type: 'site.standard.document',
      site: PUB_URI,
      title: 'Just an article',
      publishedAt: '2026-06-10T00:00:00.000Z',
    });

    expect(resolved.readerCollection).toBeUndefined();
  });

  it('drops readerCollection when no items resolve (empty edition)', async () => {
    const db = new Database(':memory:');
    initDatabase(db);
    mockCollectionFetch({});

    // An edition whose only item has no `document` URI resolves to nothing, so the
    // collection is dropped and the doc renders as an ordinary body, not an empty
    // edition card.
    const resolved = await recordToProxyDocument(
      db,
      AUTHOR,
      itemUri('edition'),
      'cid-edition',
      {
        $type: 'site.standard.document',
        site: PUB_URI,
        title: 'Empty Edition',
        publishedAt: '2026-06-10T00:00:00.000Z',
      },
      {
        document: itemUri('edition'),
        editorial: { body: markpub('Nothing made the cut.') },
        items: [{ note: markpub('A note with no document reference.') }],
        createdAt: '2026-06-10T00:00:00.000Z',
      }
    );

    expect(resolved.readerCollection).toBeUndefined();
  });
});

describe('fetchSingleDocument', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  function mockSingleFetch(doc: Record<string, unknown> | null) {
    return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('https://plc.directory/')) {
        return new Response(
          JSON.stringify({
            id: AUTHOR,
            service: [
              { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
            ],
          })
        );
      }
      if (url.includes('com.atproto.repo.getRecord')) {
        const params = new URLSearchParams(url.split('?')[1]);
        if (params.get('collection') === 'site.standard.publication') {
          return new Response(
            JSON.stringify({ value: { url: 'https://blog.example.com', name: 'Example Blog' } })
          );
        }
        if (!doc) return new Response('not found', { status: 404 });
        const fullUri = `at://${params.get('repo')}/${params.get('collection')}/${params.get('rkey')}`;
        return new Response(JSON.stringify({ uri: fullUri, cid: 'cid-1', value: doc }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);
  }

  const DOC_URI = `at://${AUTHOR}/site.standard.document/piece1`;

  it('resolves a document by at:// URI', async () => {
    const db = new Database(':memory:');
    initDatabase(db);
    mockSingleFetch({
      $type: 'site.standard.document',
      site: PUB_URI,
      title: 'On-demand Piece',
      path: '/on-demand-piece',
      publishedAt: '2026-06-01T00:00:00.000Z',
    });

    const doc = await fetchSingleDocument(db, DOC_URI);
    expect(doc).not.toBeNull();
    expect(doc?.title).toBe('On-demand Piece');
    expect(doc?.recordUri).toBe(DOC_URI);
    expect(doc?.canonicalUrl).toBe('https://blog.example.com/on-demand-piece');
  });

  it('returns null for a non-document collection', async () => {
    const db = new Database(':memory:');
    initDatabase(db);
    const doc = await fetchSingleDocument(db, `at://${AUTHOR}/site.standard.publication/pub1`);
    expect(doc).toBeNull();
  });

  it('returns null when the record is missing', async () => {
    const db = new Database(':memory:');
    initDatabase(db);
    mockSingleFetch(null);
    const doc = await fetchSingleDocument(db, DOC_URI);
    expect(doc).toBeNull();
  });
});
