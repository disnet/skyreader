import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { parseFeed } from './feed-parser';
import type { ParsedFeed, FeedItem } from './types';

export interface AppConfig {
	proxySecret?: string;
	cacheTtlMs: number;
	staleTtlMs: number;
	defaultLimit: number;
}

export interface CacheRow {
	url_hash: string;
	url: string;
	parsed_json: string;
	etag: string | null;
	last_modified: string | null;
	cached_at: number;
	fetched_at: number;
	error_count: number;
	last_error: string | null;
	last_error_at: number | null;
	next_retry_at: number | null;
}

interface FilterResult {
	items: FeedItem[];
	filter: 'MATCHED' | 'FULL' | 'LIMITED' | 'NONE';
	matchedGuid?: string;
}

const FETCH_HEADERS = {
	// Don't impersonate Googlebot (e.g. "like FeedFetcher-Google"): CDNs such as
	// Akamai (used by cbc.ca) verify Google crawlers by reverse-DNS and 403 any
	// non-Google IP that claims to be one. Identify honestly with a contact URL.
	'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
	Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
	'Accept-Language': 'en-US,en;q=0.9',
	'Accept-Encoding': 'gzip, deflate',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
};

export function hashUrl(url: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(url);
	return hasher.digest('hex').slice(0, 16);
}

export type ErrorType = 'transient' | 'permanent' | 'recoverable';

export function classifyError(status: number): ErrorType {
	if ([429, 500, 502, 503, 504].includes(status)) return 'transient';
	if ([401, 403, 404, 410].includes(status)) return 'permanent';
	return 'recoverable';
}

const BASE_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours
const PERMANENT_ERROR_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_RECOVERABLE_ERRORS = 5;
const FETCH_TIMEOUT_MS = 30 * 1000; // 30 seconds
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export class ResponseTooLargeError extends Error {
	constructor(size: number, limit: number) {
		super(`Response size ${size} exceeds limit of ${limit} bytes`);
		this.name = 'ResponseTooLargeError';
	}
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
	// Check Content-Length header first for fast rejection
	const contentLength = response.headers.get('Content-Length');
	if (contentLength) {
		const size = parseInt(contentLength, 10);
		if (!isNaN(size) && size > maxBytes) {
			throw new ResponseTooLargeError(size, maxBytes);
		}
	}

	// Read body and check size
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > maxBytes) {
		throw new ResponseTooLargeError(buffer.byteLength, maxBytes);
	}

	return new TextDecoder().decode(buffer);
}

export function calculateBackoff(errorCount: number): number {
	return Math.min(BASE_DELAY_MS * Math.pow(2, errorCount), MAX_DELAY_MS);
}

export function filterItems(items: FeedItem[], sinceGuids: Set<string>, limit: number): FilterResult {
	if (sinceGuids.size === 0) {
		return {
			items: items.slice(0, limit),
			filter: 'LIMITED',
		};
	}

	for (let i = 0; i < items.length; i++) {
		if (sinceGuids.has(items[i].guid)) {
			return {
				items: items.slice(0, i),
				filter: 'MATCHED',
				matchedGuid: items[i].guid,
			};
		}
	}

	return {
		items: items.slice(0, limit),
		filter: 'FULL',
	};
}

export function parseSinceGuids(param: string | undefined): Set<string> {
	if (!param) return new Set();
	return new Set(param.split(',').map((g) => g.trim()).filter(Boolean));
}

export function initDatabase(db: Database): void {
	db.run('PRAGMA journal_mode = WAL');
	db.run(`
		CREATE TABLE IF NOT EXISTS cache (
			url_hash TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			parsed_json TEXT NOT NULL,
			etag TEXT,
			last_modified TEXT,
			cached_at INTEGER NOT NULL,
			fetched_at INTEGER NOT NULL,
			error_count INTEGER DEFAULT 0,
			last_error TEXT,
			last_error_at INTEGER,
			next_retry_at INTEGER
		)
	`);
	db.run(`CREATE INDEX IF NOT EXISTS idx_cache_fetched_at ON cache(fetched_at)`);

	// Migration: add error tracking columns if they don't exist
	const columns = db.query<{ name: string }, []>(`PRAGMA table_info(cache)`).all();
	const columnNames = new Set(columns.map((c) => c.name));

	if (!columnNames.has('error_count')) {
		db.run(`ALTER TABLE cache ADD COLUMN error_count INTEGER DEFAULT 0`);
	}
	if (!columnNames.has('last_error')) {
		db.run(`ALTER TABLE cache ADD COLUMN last_error TEXT`);
	}
	if (!columnNames.has('last_error_at')) {
		db.run(`ALTER TABLE cache ADD COLUMN last_error_at INTEGER`);
	}
	if (!columnNames.has('next_retry_at')) {
		db.run(`ALTER TABLE cache ADD COLUMN next_retry_at INTEGER`);
	}
}

export function createApp(db: Database, config: AppConfig) {
	const { proxySecret, cacheTtlMs, staleTtlMs, defaultLimit } = config;

	// Track in-flight fetches to avoid duplicate requests
	const inFlight = new Map<string, Promise<ParsedFeed | null>>();

	async function fetchParseAndCache(
		url: string,
		urlHash: string,
		cached?: CacheRow
	): Promise<ParsedFeed | null> {
		const now = Date.now();

		// Circuit breaker: skip fetch if in backoff period
		if (cached?.next_retry_at && now < cached.next_retry_at) {
			console.log(`[Proxy] ${url}: in backoff until ${new Date(cached.next_retry_at).toISOString()}, skipping fetch`);
			return cached.parsed_json ? (JSON.parse(cached.parsed_json) as ParsedFeed) : null;
		}

		const headers: Record<string, string> = { ...FETCH_HEADERS };

		if (cached?.etag) headers['If-None-Match'] = cached.etag;
		if (cached?.last_modified) headers['If-Modified-Since'] = cached.last_modified;

		try {
			const response = await fetch(url, {
				headers,
				redirect: 'follow',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});

			if (response.status === 304 && cached) {
				// Success: reset error tracking
				db.run(
					'UPDATE cache SET fetched_at = ?, error_count = 0, last_error = NULL, last_error_at = NULL, next_retry_at = NULL WHERE url_hash = ?',
					[now, urlHash]
				);
				return JSON.parse(cached.parsed_json) as ParsedFeed;
			}

			if (!response.ok) {
				const errorType = classifyError(response.status);
				const newErrorCount = (cached?.error_count || 0) + 1;
				const errorMessage = `HTTP ${response.status}`;

				let nextRetryAt: number;
				if (errorType === 'permanent') {
					nextRetryAt = now + PERMANENT_ERROR_DELAY_MS;
					console.error(`[Proxy] ${url}: ${errorMessage} (permanent error, retry in 7 days)`);
				} else if (errorType === 'recoverable' && newErrorCount >= MAX_RECOVERABLE_ERRORS) {
					nextRetryAt = now + PERMANENT_ERROR_DELAY_MS;
					console.error(`[Proxy] ${url}: ${errorMessage} (max errors reached, retry in 7 days)`);
				} else {
					nextRetryAt = now + calculateBackoff(newErrorCount);
					console.error(`[Proxy] ${url}: ${errorMessage} (${errorType}, retry at ${new Date(nextRetryAt).toISOString()})`);
				}

				// Update error tracking in cache
				if (cached) {
					db.run(
						'UPDATE cache SET error_count = ?, last_error = ?, last_error_at = ?, next_retry_at = ? WHERE url_hash = ?',
						[newErrorCount, errorMessage, now, nextRetryAt, urlHash]
					);
				} else {
					// Create a cache entry for tracking errors even without content
					const emptyFeed: ParsedFeed = { title: '', items: [], fetchedAt: now };
					db.run(
						`INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[urlHash, url, JSON.stringify(emptyFeed), now, now, newErrorCount, errorMessage, now, nextRetryAt]
					);
				}

				// Only return cached content if it has real content (not an error placeholder)
				if (cached?.parsed_json) {
					const cachedFeed = JSON.parse(cached.parsed_json) as ParsedFeed;
					if (cachedFeed.items.length > 0 || cachedFeed.title !== '') {
						return cachedFeed;
					}
				}
				return null;
			}

			const content = await readResponseWithLimit(response, MAX_RESPONSE_SIZE_BYTES);
			const etag = response.headers.get('ETag');
			const lastModified = response.headers.get('Last-Modified');

			let parsed: ParsedFeed;
			try {
				parsed = parseFeed(content, url);
			} catch (parseError) {
				console.error(`[Proxy] ${url}: parse error - ${parseError}`);
				// Track parse errors as recoverable
				const newErrorCount = (cached?.error_count || 0) + 1;
				const nextRetryAt = now + calculateBackoff(newErrorCount);
				const errorMessage = `Parse error: ${parseError}`;

				if (cached) {
					db.run(
						'UPDATE cache SET error_count = ?, last_error = ?, last_error_at = ?, next_retry_at = ? WHERE url_hash = ?',
						[newErrorCount, errorMessage, now, nextRetryAt, urlHash]
					);
				}

				// Only return cached content if it has real content (not an error placeholder)
				if (cached?.parsed_json) {
					const cachedFeed = JSON.parse(cached.parsed_json) as ParsedFeed;
					if (cachedFeed.items.length > 0 || cachedFeed.title !== '') {
						return cachedFeed;
					}
				}
				return null;
			}

			const parsedJson = JSON.stringify(parsed);

			// Success: save feed and reset error tracking
			db.run(
				`INSERT INTO cache (url_hash, url, parsed_json, etag, last_modified, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)
				ON CONFLICT(url_hash) DO UPDATE SET
					parsed_json = excluded.parsed_json,
					etag = excluded.etag,
					last_modified = excluded.last_modified,
					cached_at = excluded.cached_at,
					fetched_at = excluded.fetched_at,
					error_count = 0,
					last_error = NULL,
					last_error_at = NULL,
					next_retry_at = NULL`,
				[urlHash, url, parsedJson, etag, lastModified, now, now]
			);

			return parsed;
		} catch (error) {
			const isTimeout = error instanceof Error && error.name === 'TimeoutError';
			const isTooLarge = error instanceof ResponseTooLargeError;
			const msg = isTimeout
				? `Timeout after ${FETCH_TIMEOUT_MS / 1000}s`
				: (error instanceof Error ? error.message : 'Unknown error');
			console.error(`[Proxy] ${url}: fetch error - ${msg}`);

			// Response too large is treated as permanent (feed unlikely to shrink)
			// Network/timeout errors are transient, apply backoff
			const newErrorCount = (cached?.error_count || 0) + 1;
			const nextRetryAt = isTooLarge
				? now + PERMANENT_ERROR_DELAY_MS
				: now + calculateBackoff(newErrorCount);
			const errorMessage = isTooLarge ? msg : `Network error: ${msg}`;

			if (cached) {
				db.run(
					'UPDATE cache SET error_count = ?, last_error = ?, last_error_at = ?, next_retry_at = ? WHERE url_hash = ?',
					[newErrorCount, errorMessage, now, nextRetryAt, urlHash]
				);
			} else {
				const emptyFeed: ParsedFeed = { title: '', items: [], fetchedAt: now };
				db.run(
					`INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[urlHash, url, JSON.stringify(emptyFeed), now, now, newErrorCount, errorMessage, now, nextRetryAt]
				);
			}

			// Only return cached content if it has real content (not an error placeholder)
			if (cached?.parsed_json) {
				const cachedFeed = JSON.parse(cached.parsed_json) as ParsedFeed;
				if (cachedFeed.items.length > 0 || cachedFeed.title !== '') {
					return cachedFeed;
				}
			}
			return null;
		}
	}

	function triggerBackgroundRefresh(url: string, urlHash: string, cached?: CacheRow): void {
		if (inFlight.has(urlHash)) return;

		const promise = fetchParseAndCache(url, urlHash, cached).finally(() => {
			inFlight.delete(urlHash);
		});

		inFlight.set(urlHash, promise);
	}

	const app = new Hono();

	// Health check (no auth)
	app.get('/health', (c) => {
		const cacheCount = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM cache').get();
		return c.json({
			status: 'ok',
			timestamp: Date.now(),
			cachedFeeds: cacheCount?.count || 0,
		});
	});

	// Stats endpoint
	app.get('/stats', (c) => {
		if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		const now = Date.now();
		const total = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM cache').get();
		const fresh = db
			.query<{ count: number }, [number]>('SELECT COUNT(*) as count FROM cache WHERE fetched_at > ?')
			.get(now - cacheTtlMs);
		const stale = db
			.query<{ count: number }, [number, number]>(
				'SELECT COUNT(*) as count FROM cache WHERE fetched_at <= ? AND fetched_at > ?'
			)
			.get(now - cacheTtlMs, now - staleTtlMs);

		// Error statistics
		const inError = db
			.query<{ count: number }, []>('SELECT COUNT(*) as count FROM cache WHERE error_count > 0')
			.get();
		const inBackoff = db
			.query<{ count: number }, [number]>('SELECT COUNT(*) as count FROM cache WHERE next_retry_at > ?')
			.get(now);
		const permanentErrors = db
			.query<{ count: number }, [number]>(
				'SELECT COUNT(*) as count FROM cache WHERE next_retry_at > ? AND error_count >= 5'
			)
			.get(now + 6 * 24 * 60 * 60 * 1000); // More than 6 days means it's a permanent error

		return c.json({
			total: total?.count || 0,
			fresh: fresh?.count || 0,
			stale: stale?.count || 0,
			inFlight: inFlight.size,
			cacheTtlSeconds: cacheTtlMs / 1000,
			staleTtlSeconds: staleTtlMs / 1000,
			errors: {
				total: inError?.count || 0,
				inBackoff: inBackoff?.count || 0,
				permanent: permanentErrors?.count || 0,
			},
		});
	});

	// Main feed endpoint
	app.get('/feed', async (c) => {
		if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		const feedUrl = c.req.query('url');
		const sinceGuidsParam = c.req.query('since_guids');
		const limitParam = c.req.query('limit');

		if (!feedUrl) {
			return c.json({ error: 'Missing url parameter' }, 400);
		}

		try {
			new URL(feedUrl);
		} catch {
			return c.json({ error: 'Invalid url' }, 400);
		}

		const sinceGuids = parseSinceGuids(sinceGuidsParam);
		const limit = limitParam ? Math.min(parseInt(limitParam, 10) || defaultLimit, 500) : defaultLimit;

		const urlHash = hashUrl(feedUrl);
		const now = Date.now();

		const cached = db.query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?').get(urlHash);

		let feed: ParsedFeed | null = null;
		let cacheStatus: string;

		if (cached) {
			const age = now - cached.fetched_at;
			const isInErrorBackoff = cached.error_count > 0 && cached.next_retry_at && now < cached.next_retry_at;
			const cachedFeed = JSON.parse(cached.parsed_json) as ParsedFeed;
			const hasRealContent = cachedFeed.items.length > 0 || cachedFeed.title !== '';
			const isErrorPlaceholder = cached.error_count > 0 && !hasRealContent;

			// Return error response for empty error placeholders in backoff period
			if (isInErrorBackoff && isErrorPlaceholder) {
				return c.json({
					feed: null,
					cache: 'ERROR',
					filter: 'NONE',
					error: cached.last_error || 'Failed to fetch feed',
					errorCount: cached.error_count,
					nextRetryAt: cached.next_retry_at,
				}, 502);
			}

			// Never serve empty error placeholders as valid cache - let them go through fetch
			if (!isErrorPlaceholder) {
				if (age < cacheTtlMs) {
					feed = cachedFeed;
					cacheStatus = 'HIT';
				} else if (age < staleTtlMs) {
					feed = cachedFeed;
					triggerBackgroundRefresh(feedUrl, urlHash, cached);
					cacheStatus = 'STALE';
				}
			}
		}

		if (!feed) {
			feed = await fetchParseAndCache(feedUrl, urlHash, cached ?? undefined);
			cacheStatus = cached ? 'REVALIDATED' : 'MISS';
		}

		if (!feed) {
			// Re-fetch cached row to get error info
			const errorCache = db
				.query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
				.get(urlHash);
			return c.json({
				feed: null,
				cache: 'ERROR',
				filter: 'NONE',
				error: errorCache?.last_error || 'Failed to fetch feed',
				errorCount: errorCache?.error_count || 0,
				nextRetryAt: errorCache?.next_retry_at || undefined,
			}, 502);
		}

		const filterResult = filterItems(feed.items, sinceGuids, limit);

		let filterHeader: string;
		if (filterResult.filter === 'MATCHED') {
			filterHeader = `MATCHED:${filterResult.matchedGuid}`;
		} else {
			filterHeader = filterResult.filter;
		}

		const filteredFeed: ParsedFeed = {
			...feed,
			items: filterResult.items,
		};

		const headers: Record<string, string> = {
			'X-Cache': cacheStatus!,
			'X-Filter': filterHeader,
			'X-Total-Items': String(feed.items.length),
			'X-Returned-Items': String(filterResult.items.length),
		};

		if (cached) {
			headers['X-Cache-Age'] = String(Math.floor((now - cached.fetched_at) / 1000));
		}

		return c.json({
			feed: filteredFeed,
			cache: cacheStatus!,
			filter: filterHeader,
			totalItems: feed.items.length,
			returnedItems: filterResult.items.length,
		}, 200, headers);
	});

	// Feed discovery endpoint
	app.get('/discover', async (c) => {
		if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		const siteUrl = c.req.query('url');
		if (!siteUrl) {
			return c.json({ error: 'Missing url parameter' }, 400);
		}

		try {
			new URL(siteUrl);
		} catch {
			return c.json({ error: 'Invalid url' }, 400);
		}

		try {
			const response = await fetch(siteUrl, {
				headers: FETCH_HEADERS,
				redirect: 'follow',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});

			if (!response.ok) {
				return c.json({ error: `Failed to fetch: HTTP ${response.status}` }, 502);
			}

			const contentType = response.headers.get('Content-Type') || '';
			const text = await readResponseWithLimit(response, MAX_RESPONSE_SIZE_BYTES);

			// If it's already a feed, return the URL
			if (
				contentType.includes('xml') ||
				contentType.includes('rss') ||
				contentType.includes('atom')
			) {
				return c.json({ feeds: [siteUrl] });
			}

			// Parse HTML to find link tags
			const feeds: string[] = [];
			const maxFeedsFromHtml = 10;
			const linkRegex =
				/<link[^>]*type=["'](application\/rss\+xml|application\/atom\+xml)["'][^>]*>/gi;
			let match;

			while ((match = linkRegex.exec(text)) !== null && feeds.length < maxFeedsFromHtml) {
				const hrefMatch = match[0].match(/href=["']([^"']+)["']/i);
				if (hrefMatch) {
					let feedUrl = hrefMatch[1];
					// Handle relative URLs
					if (!feedUrl.startsWith('http')) {
						const baseUrl = new URL(siteUrl);
						feedUrl = new URL(feedUrl, baseUrl).toString();
					}
					feeds.push(feedUrl);
				}
			}

			// Try common feed paths if no links found (stop after first match)
			if (feeds.length === 0) {
				const commonPaths = ['/feed', '/rss', '/atom.xml', '/feed.xml', '/rss.xml', '/index.xml'];
				const baseUrl = new URL(siteUrl);
				const maxProbes = 3;
				let probeCount = 0;

				for (const path of commonPaths) {
					if (feeds.length > 0 || probeCount >= maxProbes) break;
					probeCount++;

					try {
						const testUrl = new URL(path, baseUrl).toString();
						const testResponse = await fetch(testUrl, {
							method: 'HEAD',
							headers: FETCH_HEADERS,
							redirect: 'follow',
							signal: AbortSignal.timeout(5000),
						});

						if (testResponse.ok) {
							const testContentType = testResponse.headers.get('Content-Type') || '';
							if (
								testContentType.includes('xml') ||
								testContentType.includes('rss') ||
								testContentType.includes('atom')
							) {
								feeds.push(testUrl);
							}
						}
					} catch {
						// Ignore errors for common path probing
					}
				}
			}

			return c.json({ feeds });
		} catch (error) {
			const isTimeout = error instanceof Error && error.name === 'TimeoutError';
			const msg = isTimeout
				? `Timeout after ${FETCH_TIMEOUT_MS / 1000}s`
				: error instanceof Error
					? error.message
					: 'Unknown error';
			return c.json({ error: msg }, 502);
		}
	});

	// Fetch raw HTML from a URL (extraction done client-side)
	app.post('/fetch-html', async (c) => {
		if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		let body: { url: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		if (!body.url || typeof body.url !== 'string') {
			return c.json({ error: 'Missing url field' }, 400);
		}

		try {
			new URL(body.url);
		} catch {
			return c.json({ error: 'Invalid url' }, 400);
		}

		try {
			const response = await fetch(body.url, {
				headers: {
					...FETCH_HEADERS,
					Accept: 'text/html, application/xhtml+xml, */*',
				},
				redirect: 'follow',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});

			if (!response.ok) {
				return c.json({ error: `Failed to fetch: HTTP ${response.status}` }, 502);
			}

			const html = await readResponseWithLimit(response, MAX_RESPONSE_SIZE_BYTES);

			return c.html(html);
		} catch (error) {
			const isTimeout = error instanceof Error && error.name === 'TimeoutError';
			const isTooLarge = error instanceof ResponseTooLargeError;
			const msg = isTimeout
				? `Timeout after ${FETCH_TIMEOUT_MS / 1000}s`
				: isTooLarge
					? error.message
					: error instanceof Error
						? error.message
						: 'Unknown error';
			return c.json({ error: msg }, 502);
		}
	});

	// Bulk fetch endpoint
	app.post('/feeds', async (c) => {
		if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		interface BulkRequest {
			urls?: string[];
			feeds?: Array<{
				url: string;
				since_guids?: string[];
				limit?: number;
			}>;
			limit?: number;
		}

		const body = await c.req.json<BulkRequest>();
		const globalLimit = body.limit ?? defaultLimit;

		let feedRequests: Array<{ url: string; sinceGuids: Set<string>; limit: number }>;

		if (body.feeds && Array.isArray(body.feeds)) {
			feedRequests = body.feeds.map((f) => ({
				url: f.url,
				sinceGuids: new Set(f.since_guids || []),
				limit: f.limit ?? globalLimit,
			}));
		} else if (body.urls && Array.isArray(body.urls)) {
			feedRequests = body.urls.map((url) => ({
				url,
				sinceGuids: new Set<string>(),
				limit: globalLimit,
			}));
		} else {
			return c.json({ error: 'Missing urls or feeds array' }, 400);
		}

		if (feedRequests.length === 0) {
			return c.json({ error: 'Empty request' }, 400);
		}

		if (feedRequests.length > 50) {
			return c.json({ error: 'Too many feeds (max 50)' }, 400);
		}

		const now = Date.now();

		interface FeedResult {
			feed: ParsedFeed | null;
			cache: string;
			filter: string;
			totalItems?: number;
			returnedItems?: number;
			error?: string;
			errorCount?: number;
			nextRetryAt?: number;
		}

		const results: Record<string, FeedResult> = {};

		await Promise.all(
			feedRequests.map(async ({ url: feedUrl, sinceGuids, limit }) => {
				try {
					new URL(feedUrl);
				} catch {
					results[feedUrl] = {
						feed: null,
						cache: 'INVALID',
						filter: 'NONE',
						error: 'Invalid URL',
					};
					return;
				}

				const urlHash = hashUrl(feedUrl);
				const cached = db
					.query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
					.get(urlHash);

				let feed: ParsedFeed | null = null;
				let cacheStatus: string;

				if (cached) {
					const age = now - cached.fetched_at;
					const isInErrorBackoff = cached.error_count > 0 && cached.next_retry_at && now < cached.next_retry_at;
					const cachedFeed = JSON.parse(cached.parsed_json) as ParsedFeed;
					const hasRealContent = cachedFeed.items.length > 0 || cachedFeed.title !== '';
					const isErrorPlaceholder = cached.error_count > 0 && !hasRealContent;

					// Return error response for empty error placeholders in backoff period
					if (isInErrorBackoff && isErrorPlaceholder) {
						results[feedUrl] = {
							feed: null,
							cache: 'ERROR',
							filter: 'NONE',
							error: cached.last_error || 'Failed to fetch',
							errorCount: cached.error_count,
							nextRetryAt: cached.next_retry_at ?? undefined,
						};
						return;
					}

					// Never serve empty error placeholders as valid cache - let them go through fetch
					if (!isErrorPlaceholder) {
						if (age < cacheTtlMs) {
							feed = cachedFeed;
							cacheStatus = 'HIT';
						} else if (age < staleTtlMs) {
							feed = cachedFeed;
							triggerBackgroundRefresh(feedUrl, urlHash, cached);
							cacheStatus = 'STALE';
						}
					}
				}

				if (!feed) {
					feed = await fetchParseAndCache(feedUrl, urlHash, cached ?? undefined);
					cacheStatus = feed ? 'MISS' : 'ERROR';
				}

				if (!feed) {
					// Re-fetch cached row to get error info (it may have been updated)
					const errorCache = db
						.query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
						.get(urlHash);
					results[feedUrl] = {
						feed: null,
						cache: 'ERROR',
						filter: 'NONE',
						error: errorCache?.last_error || 'Failed to fetch',
						errorCount: errorCache?.error_count || 0,
						nextRetryAt: errorCache?.next_retry_at || undefined,
					};
					return;
				}

				const filterResult = filterItems(feed.items, sinceGuids, limit);

				let filterStatus: string;
				if (filterResult.filter === 'MATCHED') {
					filterStatus = `MATCHED:${filterResult.matchedGuid}`;
				} else {
					filterStatus = filterResult.filter;
				}

				// Re-fetch cached row to get latest error state
				const latestCache = db
					.query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
					.get(urlHash);

				const result: FeedResult = {
					feed: {
						...feed,
						items: filterResult.items,
					},
					cache: cacheStatus!,
					filter: filterStatus,
					totalItems: feed.items.length,
					returnedItems: filterResult.items.length,
				};

				// Include error info if present
				if (latestCache?.error_count && latestCache.error_count > 0) {
					result.error = latestCache.last_error || undefined;
					result.errorCount = latestCache.error_count;
					result.nextRetryAt = latestCache.next_retry_at || undefined;
				}

				results[feedUrl] = result;
			})
		);

		return c.json({ feeds: results });
	});

	return { app, inFlight };
}

export function cleanupCache(db: Database): number {
	const threshold = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
	const result = db.run('DELETE FROM cache WHERE fetched_at < ?', [threshold]);
	return result.changes;
}
