/**
 * Standard.site (AT Protocol) document fetching + resolution.
 *
 * Ported from the backend's canonical-url.ts so the proxy can fetch
 * `site.standard.document` records directly from a publisher's PDS, resolve their
 * canonical URLs / publication metadata, and return them in the frontend's
 * `SocialDocument` shape. Publication base-URL/name/icon are cached in SQLite
 * (mirroring the old D1 `publications_cache`).
 */
import { Database } from 'bun:sqlite';
import { resolvePdsUrl } from './did-resolver';

// Publication records (base URL + icon) change rarely; cache for a day.
const PUBLICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// A failed resolution (no base URL — transient PDS/getRecord blip, or a publication
// that doesn't exist yet) is only cached briefly. Without this a single blip would
// pin every document's canonicalUrl to a bare relative path for a full day.
const PUBLICATION_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
// How many documents (most recent) to keep per author. Bounds payload + work; a
// reader rarely scrolls deeper than this, and older docs are still reachable by
// raising this cap later.
const MAX_DOCUMENTS_PER_AUTHOR = 100;
const MAX_LIST_PAGES = 5; // listRecords pages of 100 → up to 500 scanned
const FETCH_TIMEOUT_MS = 30 * 1000;

/**
 * A resolved document in the exact shape the frontend's `SocialDocument`
 * consumes (minus the client-only `id`). Dates are ISO strings, `coverImageCid`
 * is the raw blob CID (the client builds the CDN URL with the authorDid), and
 * `content` is the structured record object passed through untouched.
 */
export interface ProxyDocument {
	authorDid: string;
	recordUri: string;
	recordCid: string;
	siteUri: string;
	title: string;
	publishedAt: string;
	path?: string;
	description?: string;
	coverImageCid?: string;
	textContent?: string;
	bskyPostUri?: string;
	tags?: string[];
	updatedAt?: string;
	canonicalUrl?: string;
	content?: unknown;
	indexedAt?: string;
	createdAt: string;
	siteIcon?: string;
	// External resource refs (RFC-8288-style). A linkblog "link post" carries the
	// shared article's https URL here; the frontend renders it as a link post.
	links?: Array<{ uri: string; rel?: string }>;
}

interface BlobRef {
	ref?: { $link?: string };
	mimeType?: string;
}

interface DocumentRecord {
	$type?: string;
	site?: string;
	title?: string;
	publishedAt?: string;
	path?: string;
	description?: string;
	coverImage?: BlobRef;
	textContent?: string;
	bskyPostRef?: { uri?: string; cid?: string };
	tags?: string[];
	createdAt?: string;
	updatedAt?: string;
	content?: unknown;
	links?: Array<{ uri?: string; rel?: string }>;
}

interface PublicationRecord {
	$type?: string;
	url?: string;
	name?: string;
	description?: string;
	icon?: BlobRef;
}

interface ListRecordsResponse {
	records?: Array<{ uri: string; cid: string; value: DocumentRecord }>;
	cursor?: string;
}

interface ParsedAtUri {
	did: string;
	collection: string;
	rkey: string;
}

interface PublicationCacheRow {
	publication_uri: string;
	base_url: string | null;
	icon: string | null;
	cached_at: number;
}

/** Parse `at://did/collection/rkey` into its components, or null if malformed. */
export function parseAtUri(uri: string): ParsedAtUri | null {
	if (!uri.startsWith('at://')) return null;
	const parts = uri.slice(5).split('/');
	if (parts.length < 3) return null;
	const did = parts[0];
	if (!did.startsWith('did:')) return null;
	return { did, collection: parts[1], rkey: parts.slice(2).join('/') };
}

/** Bluesky CDN URL for a publication icon / image blob. */
function resolveBlobUrl(did: string, blob: BlobRef | undefined): string | null {
	if (!blob?.ref?.$link) return null;
	return `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${blob.ref.$link}@jpeg`;
}

/** Combine a publication base URL with a document path, normalizing slashes. */
export function buildCanonicalUrl(baseUrl: string, path: string): string {
	if (!baseUrl) return path || '';
	if (!path) return baseUrl;
	const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return `${normalizedBase}${normalizedPath}`;
}

async function fetchRecord<T>(
	pdsUrl: string,
	did: string,
	collection: string,
	rkey: string
): Promise<T | null> {
	try {
		const params = new URLSearchParams({ repo: did, collection, rkey });
		const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { value?: T };
		return data.value ?? null;
	} catch (error) {
		console.error('[standard-site] getRecord error:', error);
		return null;
	}
}

/**
 * Resolve a publication's base URL + icon from its `at://...publication/rkey`
 * URI, caching the result in SQLite. Returns nulls for non-`at://` sites (loose
 * https:// documents) — those have no publication record to resolve.
 */
export async function resolveSiteMeta(
	db: Database,
	siteUri: string
): Promise<{ baseUrl: string | null; icon: string | null }> {
	if (!siteUri) return { baseUrl: null, icon: null };

	// Loose https:// sites are already their own base URL, no record to fetch.
	if (siteUri.startsWith('http://') || siteUri.startsWith('https://')) {
		return { baseUrl: siteUri, icon: null };
	}

	const parsed = parseAtUri(siteUri);
	if (!parsed || parsed.collection !== 'site.standard.publication') {
		return { baseUrl: null, icon: null };
	}

	const now = Date.now();
	const cached = db
		.query<PublicationCacheRow, [string]>(
			'SELECT publication_uri, base_url, icon, cached_at FROM publication_cache WHERE publication_uri = ?'
		)
		.get(siteUri);
	if (cached) {
		const ttl = cached.base_url ? PUBLICATION_CACHE_TTL_MS : PUBLICATION_NEGATIVE_CACHE_TTL_MS;
		if (now - cached.cached_at < ttl) {
			return { baseUrl: cached.base_url, icon: cached.icon };
		}
	}

	const pdsUrl = await resolvePdsUrl(db, parsed.did);
	let baseUrl: string | null = null;
	let icon: string | null = null;
	if (pdsUrl) {
		const record = await fetchRecord<PublicationRecord>(
			pdsUrl,
			parsed.did,
			parsed.collection,
			parsed.rkey
		);
		baseUrl = record?.url || null;
		icon = resolveBlobUrl(parsed.did, record?.icon);
	}

	db.run(
		`INSERT INTO publication_cache (publication_uri, base_url, icon, cached_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(publication_uri) DO UPDATE SET base_url = excluded.base_url, icon = excluded.icon, cached_at = excluded.cached_at`,
		[siteUri, baseUrl, icon, now]
	);

	return { baseUrl, icon };
}

function toISO(value: string | undefined, fallback: string): string {
	if (!value) return fallback;
	const ms = new Date(value).getTime();
	return isNaN(ms) ? fallback : new Date(ms).toISOString();
}

/**
 * Fetch a publisher's recent `site.standard.document` records and map them to
 * `ProxyDocument`s (canonical URL + icon resolved). Returns the full unfiltered
 * list (newest first) so a single cached entry per author serves subscribers of
 * any of that author's publications; the publication filter is applied at
 * response time. Throws on PDS resolution / fetch failure so the caller records
 * an error + backoff.
 */
export async function fetchDocumentsForAuthor(
	db: Database,
	authorDid: string
): Promise<ProxyDocument[]> {
	const pdsUrl = await resolvePdsUrl(db, authorDid);
	if (!pdsUrl) {
		throw new Error(`Could not resolve PDS for ${authorDid}`);
	}

	const fetchedAtISO = new Date().toISOString();
	const raw: Array<{ uri: string; cid: string; value: DocumentRecord }> = [];
	let cursor: string | undefined;

	for (let page = 0; page < MAX_LIST_PAGES && raw.length < MAX_DOCUMENTS_PER_AUTHOR; page++) {
		const params = new URLSearchParams({
			repo: authorDid,
			collection: 'site.standard.document',
			limit: '100',
		});
		if (cursor) params.set('cursor', cursor);

		const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw new Error(`listRecords failed for ${authorDid}: HTTP ${res.status}`);
		}
		const data = (await res.json()) as ListRecordsResponse;
		const records = data.records ?? [];
		raw.push(...records);
		if (!data.cursor || records.length === 0) break;
		cursor = data.cursor;
	}

	// Resolve each distinct publication once, then build documents.
	const siteMetaCache = new Map<string, { baseUrl: string | null; icon: string | null }>();
	const documents: ProxyDocument[] = [];

	for (const record of raw.slice(0, MAX_DOCUMENTS_PER_AUTHOR)) {
		const doc = record.value;
		const siteUri = doc.site || '';

		let meta = siteMetaCache.get(siteUri);
		if (!meta) {
			meta = await resolveSiteMeta(db, siteUri);
			siteMetaCache.set(siteUri, meta);
		}

		const canonicalUrl = meta.baseUrl
			? buildCanonicalUrl(meta.baseUrl, doc.path || '')
			: doc.path || '';

		// Surface external resource refs (the shared article URL for link posts),
		// keeping only entries with a real uri.
		const links = Array.isArray(doc.links)
			? doc.links
					.filter((l): l is { uri: string; rel?: string } => typeof l?.uri === 'string' && !!l.uri)
					.map((l) => ({ uri: l.uri, ...(l.rel ? { rel: l.rel } : {}) }))
			: [];

		documents.push({
			authorDid,
			recordUri: record.uri,
			recordCid: record.cid,
			siteUri,
			title: doc.title || '',
			publishedAt: toISO(doc.publishedAt, fetchedAtISO),
			path: doc.path || undefined,
			description: doc.description || undefined,
			coverImageCid: doc.coverImage?.ref?.$link || undefined,
			textContent: doc.textContent || undefined,
			bskyPostUri: doc.bskyPostRef?.uri || undefined,
			tags: doc.tags && doc.tags.length > 0 ? doc.tags : undefined,
			updatedAt: doc.updatedAt ? toISO(doc.updatedAt, fetchedAtISO) : undefined,
			canonicalUrl: canonicalUrl || undefined,
			content: doc.content ?? undefined,
			indexedAt: fetchedAtISO,
			createdAt: toISO(doc.createdAt, toISO(doc.publishedAt, fetchedAtISO)),
			siteIcon: meta.icon || undefined,
			links: links.length > 0 ? links : undefined,
		});
	}

	// Newest first, matching the feed/timeline ordering.
	documents.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
	return documents;
}

/**
 * Apply a subscription's publication scope to an author's document list:
 * - empty/undefined → all documents
 * - `at://...` → only documents whose `site` matches that publication
 */
export function filterByPublication(documents: ProxyDocument[], siteUri?: string): ProxyDocument[] {
	if (!siteUri) return documents;
	return documents.filter((d) => d.siteUri === siteUri);
}

/**
 * Trim a (newest-first) document list to those newer than what the client
 * already has, mirroring the feed `since_guids` mechanism: stop at the first
 * document whose recordUri the client reports as already seen.
 *
 * Note: the current frontend deliberately sends no `since_uris` (it fetches the
 * full list each cycle so upstream edits/deletes self-heal), so this is a no-op
 * in practice today. Retained for API completeness / future incremental clients.
 */
export function filterSinceUris(documents: ProxyDocument[], sinceUris: Set<string>): ProxyDocument[] {
	if (sinceUris.size === 0) return documents;
	for (let i = 0; i < documents.length; i++) {
		if (sinceUris.has(documents[i].recordUri)) {
			return documents.slice(0, i);
		}
	}
	return documents;
}
