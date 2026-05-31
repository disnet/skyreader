import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createApp, initDatabase, cleanupCache, type AppConfig } from './app';
import {
	buildCanonicalUrl,
	filterByPublication,
	filterSinceUris,
	parseAtUri,
	resolveSiteMeta,
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
						{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
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
	app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
	authors: unknown
) {
	return app.request('/documents', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': 'test-secret' },
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
	}
) {
	db.run(
		`INSERT INTO document_cache (did, documents_json, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at, last_requested_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.did ?? AUTHOR,
			JSON.stringify(row.documents ?? []),
			row.fetchedAt,
			row.fetchedAt,
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
		// __freestanding__ = anything not tied to an at:// publication
		expect(filterByPublication(docs, '__freestanding__')).toEqual([docs[1], docs[2]]);
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
				}),
			],
		});

		const res = await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }]);
		expect(res.status).toBe(200);
		const json = (await res.json()) as { authors: Array<{ status: string; documents: ProxyDocument[] }> };
		const entry = json.authors[0];
		expect(entry.status).toBe('ready');
		expect(entry.documents.length).toBe(1);
		const doc = entry.documents[0];
		expect(doc.title).toBe('Hello');
		expect(doc.canonicalUrl).toBe('https://blog.example.com/hello');
		expect(doc.coverImageCid).toBe('covercid');
		expect(doc.siteIcon).toContain('iconcid');
		expect(doc.content).toEqual({ $type: 'pub.leaflet.document', pages: [] });
	});

	it('applies the publication filter and returns newest first', async () => {
		const { app } = createTestApp();
		fetchMock = mockAtprotoFetch({
			docs: [
				docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' }),
				docRecord('b', { site: '', title: 'Freestanding', publishedAt: '2024-03-01T00:00:00Z' }),
				docRecord('c', { site: PUB_URI, title: 'C', publishedAt: '2024-02-01T00:00:00Z' }),
			],
		});

		// Scoped to the publication: excludes the freestanding doc.
		const scoped = (await (await postDocuments(app, [{ did: AUTHOR, siteUri: PUB_URI }])).json()) as {
			authors: Array<{ documents: ProxyDocument[] }>;
		};
		expect(scoped.authors[0].documents.map((d) => d.title)).toEqual(['C', 'A']);

		// Freestanding scope: only the doc without an at:// publication.
		const free = (await (
			await postDocuments(app, [{ did: AUTHOR, siteUri: '__freestanding__' }])
		).json()) as { authors: Array<{ documents: ProxyDocument[] }> };
		expect(free.authors[0].documents.map((d) => d.title)).toEqual(['Freestanding']);
	});

	it('serves a second request from cache (single upstream fetch round)', async () => {
		const { app } = createTestApp();
		fetchMock = mockAtprotoFetch({
			docs: [docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' })],
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

	it('rejects an empty authors array', async () => {
		const { app } = createTestApp();
		const res = await postDocuments(app, []);
		expect(res.status).toBe(400);
	});
});

describe('POST /documents cache lifecycle', () => {
	let fetchMock: ReturnType<typeof spyOn> | undefined;
	afterEach(() => {
		fetchMock?.mockRestore();
		fetchMock = undefined;
	});

	it('serves stale documents immediately and refreshes in the background', async () => {
		const { db, app, inFlightDocs } = createTestApp({ cacheTtlMs: 1000, staleTtlMs: 60_000 });
		// Fetched 5s ago: older than the 1s fresh TTL, within the 60s stale window.
		insertDocCache(db, {
			documents: [proxyDoc({ recordUri: 'stale', title: 'Stale' })],
			fetchedAt: Date.now() - 5000,
			lastRequestedAt: Date.now() - 5000,
		});
		fetchMock = mockAtprotoFetch({
			docs: [docRecord('fresh', { site: PUB_URI, title: 'Fresh', publishedAt: '2024-02-01T00:00:00Z' })],
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
			authors: Array<{ status: string; error?: string; errorCount?: number; nextRetryAt?: number }>;
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
						service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
					})
				);
			}
			if (url.includes('com.atproto.repo.getRecord')) {
				return new Response(
					JSON.stringify({ value: { $type: 'site.standard.publication', url: 'https://blog.example.com' } })
				);
			}
			if (url.includes('com.atproto.repo.listRecords')) {
				seenCursors.push(new URL(url).searchParams.get('cursor'));
				listCalls++;
				if (listCalls === 1) {
					return new Response(
						JSON.stringify({
							records: [
								docRecord('a', { site: PUB_URI, title: 'A', publishedAt: '2024-01-01T00:00:00Z' }),
								docRecord('b', { site: PUB_URI, title: 'B', publishedAt: '2024-02-01T00:00:00Z' }),
							],
							cursor: 'CURSOR2',
						})
					);
				}
				// Second page: no cursor → stop.
				return new Response(
					JSON.stringify({
						records: [docRecord('c', { site: PUB_URI, title: 'C', publishedAt: '2024-03-01T00:00:00Z' })],
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
});

describe('warmStaleDocuments', () => {
	let fetchMock: ReturnType<typeof spyOn> | undefined;
	afterEach(() => {
		fetchMock?.mockRestore();
		fetchMock = undefined;
	});

	it('refreshes a stale author that was recently requested', async () => {
		const { db, warmStaleDocuments } = createTestApp({ cacheTtlMs: 1000, staleTtlMs: 60_000 });
		const oldFetched = Date.now() - 60 * 60 * 1000; // 1h ago → past the warm threshold
		insertDocCache(db, { documents: [], fetchedAt: oldFetched, lastRequestedAt: Date.now() });
		fetchMock = mockAtprotoFetch({
			docs: [docRecord('w', { site: PUB_URI, title: 'Warmed', publishedAt: '2024-01-01T00:00:00Z' })],
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
		const { db, warmStaleDocuments } = createTestApp({ cacheTtlMs: 1000, staleTtlMs: 60_000 });
		const oldFetched = Date.now() - 60 * 60 * 1000;
		// last_requested_at NULL → outside the active working set, never warmed.
		insertDocCache(db, { documents: [], fetchedAt: oldFetched, lastRequestedAt: null });
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
		insertDocCache(db, { did: 'old', fetchedAt: now - 8 * 24 * 60 * 60 * 1000 });
		insertDocCache(db, { did: 'recent', fetchedAt: now - 6 * 24 * 60 * 60 * 1000 });

		const cleaned = cleanupCache(db);
		expect(cleaned).toBe(1);

		const remaining = db
			.query<{ did: string }, []>('SELECT did FROM document_cache')
			.all()
			.map((r) => r.did);
		expect(remaining).toEqual(['recent']);
	});
});
