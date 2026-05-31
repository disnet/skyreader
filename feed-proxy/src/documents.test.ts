import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createApp, initDatabase, type AppConfig } from './app';
import {
	buildCanonicalUrl,
	filterByPublication,
	filterSinceUris,
	parseAtUri,
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
