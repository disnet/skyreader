import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { Defuddle } from 'defuddle/node';
import { parseFeed } from './feed-parser';
import type { ParsedFeed, FeedItem } from './types';
import {
  fetchDocumentsForAuthor,
  filterByPublication,
  filterSinceUris,
  type ProxyDocument,
} from './standard-site';
import { getSocialContext, type SocialContext, type SocialContextQuery } from './constellation';
import { getLinkblogRegistry } from './linkblog-registry';
import { readCachedMentions, enrichMentions } from './mentions';
import { normalizeArticleUrl } from './url-normalize';

export interface AppConfig {
  proxySecret?: string;
  cacheTtlMs: number;
  staleTtlMs: number;
  defaultLimit: number;
  // Self-warming loop (optional; defaults applied in createApp).
  // Refresh any cached feed older than this so user requests always land in the
  // fresh window (a HIT) instead of triggering a blocking upstream fetch.
  warmRefreshThresholdMs?: number;
  // Only warm feeds requested by a client within this window, so abandoned feeds
  // age out of the working set (and eventually get cleaned up) instead of being
  // polled forever.
  warmActiveWindowMs?: number;
  // Max feeds to refresh per warm tick (bounds work regardless of cache size).
  warmBatchCap?: number;
  // Max concurrent upstream fetches during a warm tick.
  warmConcurrency?: number;
  // Pre-warm Phase 5 mention counts for a refreshed feed's items (extra
  // Constellation load). Off by default; enabled in production via index.ts.
  warmMentionsEnabled?: boolean;
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
  last_requested_at: number | null;
}

interface FilterResult {
  items: FeedItem[];
  filter: 'MATCHED' | 'FULL' | 'LIMITED' | 'NONE';
  matchedGuid?: string;
}

// Cache row for an author's resolved standard.site documents. Mirrors `cache`'s
// freshness/backoff columns so documents reuse the same TTL / stale-while-
// revalidate / circuit-breaker machinery, keyed by the author DID.
export interface DocumentCacheRow {
  did: string;
  documents_json: string;
  cached_at: number;
  fetched_at: number;
  error_count: number;
  last_error: string | null;
  last_error_at: number | null;
  next_retry_at: number | null;
  last_requested_at: number | null;
}

interface DocumentRequestEntry {
  did: string;
  siteUri?: string;
  since_uris?: string[];
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

// A bare 403 from the target site means the server is explicitly refusing our
// automated fetcher — bot filters / CDNs like Cloudflare and Akamai answer 403
// to clients they don't recognize. This is a property of the *target site*, not
// a failure of our proxy, so we label it distinctly instead of folding it into
// a generic gateway error.
export function isBlockedStatus(status: number): boolean {
  return status === 403;
}

// Canonical phrase used in every "blocked" message so downstream layers can
// recognize the condition by substring without threading a flag through every
// cache row. Keep it stable if you reword the surrounding text.
export const BLOCKED_MESSAGE_MARKER = 'blocking automated access';

export function describeFetchFailure(
  status: number,
  url: string
): { error: string; blocked: boolean } {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  if (isBlockedStatus(status)) {
    return {
      error: `${host} is ${BLOCKED_MESSAGE_MARKER} (HTTP ${status}). The site likely uses a bot filter or CDN (e.g. Cloudflare, Akamai) that rejects non-browser clients.`,
      blocked: true,
    };
  }
  return { error: `Failed to fetch ${host}: HTTP ${status}`, blocked: false };
}

const BASE_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours
const PERMANENT_ERROR_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_RECOVERABLE_ERRORS = 5;
const FETCH_TIMEOUT_MS = 30 * 1000; // 30 seconds
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
// Extracted article content is effectively immutable per URL; cache it for a long
// time so repeat (and cross-user) saves of the same article are free.
const EXTRACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ExtractedArticle {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  domain: string | null;
  image: string | null;
  published: string | null;
  wordCount: number;
}

// Coerce a Defuddle date string to a valid ISO timestamp, rejecting obviously
// bogus values (pre-1990 or future-dated) the same way the old client did.
function toValidISODate(value: string | undefined | null): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (isNaN(ms)) return null;
  if (ms < 631152000000 || ms > Date.now() + 86400000) return null;
  return new Date(ms).toISOString();
}

async function extractArticle(html: string, url: string): Promise<ExtractedArticle> {
  // Defuddle's node entry builds a DOM from the HTML string via linkedom and
  // resolves relative URLs against `url`.
  const result = await Defuddle(html, url, { url });
  return {
    title: result.title || null,
    author: result.author || null,
    description: result.description || null,
    content: result.content || null,
    domain: result.domain || null,
    image: result.image || null,
    published: toValidISODate(result.published),
    wordCount: result.wordCount || 0,
  };
}

export class ResponseTooLargeError extends Error {
  constructor(size: number, limit: number) {
    super(`Response size ${size} exceeds limit of ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

// Carries an upstream-fetch failure (with the proxy's HTTP status + blocked flag)
// out of the async extraction closure so the route can render the right response.
class FetchHtmlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly blocked: boolean
  ) {
    super(message);
    this.name = 'FetchHtmlError';
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

export function filterItems(
  items: FeedItem[],
  sinceGuids: Set<string>,
  limit: number
): FilterResult {
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
  return new Set(
    param
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean)
  );
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
  // Tracks the last time a client actually asked for this feed. Drives the
  // self-warming loop's "active feed" window so we stop polling abandoned feeds.
  if (!columnNames.has('last_requested_at')) {
    db.run(`ALTER TABLE cache ADD COLUMN last_requested_at INTEGER`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_cache_last_requested_at ON cache(last_requested_at)`);

  // Extracted article content (Defuddle output), keyed by source URL. Separate
  // from the feed cache: article content is effectively immutable per URL, so it
  // has its own long TTL and is not touched by the feed self-warming loop.
  db.run(`
		CREATE TABLE IF NOT EXISTS extract_cache (
			url_hash TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			extracted_json TEXT NOT NULL,
			cached_at INTEGER NOT NULL
		)
	`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_extract_cache_cached_at ON extract_cache(cached_at)`);

  // DID → PDS URL resolution cache (used by standard.site document fetching).
  db.run(`
		CREATE TABLE IF NOT EXISTS did_cache (
			did TEXT PRIMARY KEY,
			pds_url TEXT,
			cached_at INTEGER NOT NULL
		)
	`);
  // Migration: add the handle column for DID caches predating Phase 3.
  const didColumns = db.query<{ name: string }, []>(`PRAGMA table_info(did_cache)`).all();
  if (!didColumns.some((c) => c.name === 'handle')) {
    db.run(`ALTER TABLE did_cache ADD COLUMN handle TEXT`);
  }

  // Assembled Constellation social context per link post (recommend/quote counts
  // + "also linked by"), keyed by the query bundle. Short TTL — the Constellation
  // index is firehose-fresh.
  db.run(`
		CREATE TABLE IF NOT EXISTS constellation_cache (
			cache_key TEXT PRIMARY KEY,
			context_json TEXT NOT NULL,
			cached_at INTEGER NOT NULL
		)
	`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_constellation_cache_cached_at ON constellation_cache(cached_at)`
  );

  // The Skyreader linkblog registry (Phase 6): a single cached row holding every
  // DID that has a linkblog, derived from one Constellation marker query. Global
  // and slowly-changing, so one row serves all users. Self-refreshing in place
  // (upsert on the fixed `marker` key) — no cleanup branch needed.
  db.run(`
		CREATE TABLE IF NOT EXISTS linkblog_registry_cache (
			marker TEXT PRIMARY KEY,
			dids_json TEXT NOT NULL,
			cached_at INTEGER NOT NULL
		)
	`);

  // Resolved standard.site publication metadata (base URL + icon), mirroring the
  // backend's former D1 publications_cache.
  db.run(`
		CREATE TABLE IF NOT EXISTS publication_cache (
			publication_uri TEXT PRIMARY KEY,
			base_url TEXT,
			icon TEXT,
			cached_at INTEGER NOT NULL
		)
	`);

  // Per-author resolved standard.site documents. Same freshness/backoff shape as
  // `cache`, keyed by the author DID. Documents are stored unfiltered (full
  // author list); the publication scope filter is applied per-request.
  db.run(`
		CREATE TABLE IF NOT EXISTS document_cache (
			did TEXT PRIMARY KEY,
			documents_json TEXT NOT NULL,
			cached_at INTEGER NOT NULL,
			fetched_at INTEGER NOT NULL,
			error_count INTEGER DEFAULT 0,
			last_error TEXT,
			last_error_at INTEGER,
			next_retry_at INTEGER,
			last_requested_at INTEGER
		)
	`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_document_cache_fetched_at ON document_cache(fetched_at)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_document_cache_last_requested_at ON document_cache(last_requested_at)`
  );

  // Network-wide article mentions (Phase 5), keyed by the *normalized* article
  // URL so the same article dedups across every user and every feed it appears
  // in. `total_dids` is the distinct-DID union across all lanes (the threshold +
  // "+N more"); `lanes_json` is the per-lane breakdown in priority order. The row
  // has its own decay-based freshness (see mentions.ts), decoupled from the feed
  // TTL — `first_seen_at` anchors the curve, `checked_at` gates re-polling.
  db.run(`
		CREATE TABLE IF NOT EXISTS mention_cache (
			url_hash TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			total_dids INTEGER NOT NULL DEFAULT 0,
			lanes_json TEXT NOT NULL DEFAULT '[]',
			first_seen_at INTEGER NOT NULL,
			checked_at INTEGER NOT NULL
		)
	`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mention_cache_checked_at ON mention_cache(checked_at)`);
}

export function createApp(db: Database, config: AppConfig) {
  const { proxySecret, cacheTtlMs, staleTtlMs, defaultLimit } = config;

  // Track in-flight fetches to avoid duplicate requests
  const inFlight = new Map<string, Promise<ParsedFeed | null>>();
  // Same idea for /extract: collapse concurrent extractions of the same URL.
  const inFlightExtract = new Map<string, Promise<ExtractedArticle>>();
  // And for standard.site document fetches, keyed by author DID.
  const inFlightDocs = new Map<string, Promise<ProxyDocument[] | null>>();
  // Collapse concurrent social-context lookups for the same link post.
  const inFlightContext = new Map<string, Promise<SocialContext>>();
  // Collapse concurrent mention enrichments for the same normalized URL.
  const inFlightMentions = new Map<string, Promise<void>>();

  // Fire-and-forget background enrichment of an article's mention breakdown,
  // deduped per normalized URL. The decay gate inside enrichMentions makes most
  // of these no-ops (fresh/settled rows), so callers can trigger liberally.
  function triggerMentionEnrich(normUrl: string): void {
    if (inFlightMentions.has(normUrl)) return;
    const promise = enrichMentions(db, normUrl).finally(() => {
      inFlightMentions.delete(normUrl);
    });
    inFlightMentions.set(normUrl, promise);
  }

  // Pre-warm mention breakdowns for a freshly refreshed feed's newest items so
  // counts are ready before a reader opens them. Decay-gated + deduped; capped
  // per feed to bound Constellation load.
  const WARM_MENTION_ITEM_CAP = 25;
  function warmFeedItemMentions(feed: ParsedFeed): void {
    for (const item of feed.items.slice(0, WARM_MENTION_ITEM_CAP)) {
      const normUrl = normalizeArticleUrl(item.url);
      if (normUrl) triggerMentionEnrich(normUrl);
    }
  }

  async function fetchParseAndCache(
    url: string,
    urlHash: string,
    cached?: CacheRow
  ): Promise<ParsedFeed | null> {
    const now = Date.now();

    // Circuit breaker: skip fetch if in backoff period
    if (cached?.next_retry_at && now < cached.next_retry_at) {
      console.log(
        `[Proxy] ${url}: in backoff until ${new Date(cached.next_retry_at).toISOString()}, skipping fetch`
      );
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
        // A 403 means the site is blocking our fetcher — store the explanatory
        // message so the reader UI can say so. Other statuses keep the compact
        // "HTTP n" form (downstream classifies them by code).
        const failure = describeFetchFailure(response.status, url);
        const errorMessage = failure.blocked ? failure.error : `HTTP ${response.status}`;

        let nextRetryAt: number;
        if (errorType === 'permanent') {
          nextRetryAt = now + PERMANENT_ERROR_DELAY_MS;
          console.error(`[Proxy] ${url}: ${errorMessage} (permanent error, retry in 7 days)`);
        } else if (errorType === 'recoverable' && newErrorCount >= MAX_RECOVERABLE_ERRORS) {
          nextRetryAt = now + PERMANENT_ERROR_DELAY_MS;
          console.error(`[Proxy] ${url}: ${errorMessage} (max errors reached, retry in 7 days)`);
        } else {
          nextRetryAt = now + calculateBackoff(newErrorCount);
          console.error(
            `[Proxy] ${url}: ${errorMessage} (${errorType}, retry at ${new Date(nextRetryAt).toISOString()})`
          );
        }

        // Update error tracking in cache
        if (cached) {
          db.run(
            'UPDATE cache SET error_count = ?, last_error = ?, last_error_at = ?, next_retry_at = ? WHERE url_hash = ?',
            [newErrorCount, errorMessage, now, nextRetryAt, urlHash]
          );
        } else {
          // Create a cache entry for tracking errors even without content
          const emptyFeed: ParsedFeed = {
            title: '',
            items: [],
            fetchedAt: now,
          };
          db.run(
            `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at, last_requested_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              urlHash,
              url,
              JSON.stringify(emptyFeed),
              now,
              now,
              newErrorCount,
              errorMessage,
              now,
              nextRetryAt,
              now,
            ]
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

      // Success: save feed and reset error tracking.
      // last_requested_at is set only on insert (a fresh user-request miss) and
      // deliberately NOT in DO UPDATE, so warm-loop refreshes preserve the real
      // last-requested time rather than keeping abandoned feeds alive forever.
      db.run(
        `INSERT INTO cache (url_hash, url, parsed_json, etag, last_modified, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at, last_requested_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)
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
        [urlHash, url, parsedJson, etag, lastModified, now, now, now]
      );

      return parsed;
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      const isTooLarge = error instanceof ResponseTooLargeError;
      const msg = isTimeout
        ? `Timeout after ${FETCH_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : 'Unknown error';
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
          `INSERT INTO cache (url_hash, url, parsed_json, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at, last_requested_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            urlHash,
            url,
            JSON.stringify(emptyFeed),
            now,
            now,
            newErrorCount,
            errorMessage,
            now,
            nextRetryAt,
            now,
          ]
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

  // Mark that a client just asked for this feed, so the warm loop knows it's
  // still part of the active working set. No-op if the row doesn't exist yet
  // (a cold miss) — fetchParseAndCache seeds last_requested_at on insert.
  function recordRequest(urlHash: string, now: number): void {
    db.run('UPDATE cache SET last_requested_at = ? WHERE url_hash = ?', [now, urlHash]);
  }

  // Warm loop config (defaults keep the active set fresh well inside cacheTtlMs).
  // Mirror index.ts's production default: leave a ~2-interval margin (assuming the
  // default 60s tick) below the TTL, but never less than half the TTL. For a 300s
  // TTL this is 180s, giving ~120s of headroom before a refreshed feed could expire.
  const warmRefreshThresholdMs =
    config.warmRefreshThresholdMs ?? Math.max(cacheTtlMs - 120_000, Math.floor(cacheTtlMs / 2));
  const warmActiveWindowMs = config.warmActiveWindowMs ?? 14 * 24 * 60 * 60 * 1000;
  const warmBatchCap = config.warmBatchCap ?? 200;
  const warmConcurrency = config.warmConcurrency ?? 8;
  const warmMentionsEnabled = config.warmMentionsEnabled ?? false;

  // Proactively re-fetch feeds that are about to go stale so user requests land
  // on a fresh cache (a HIT) instead of triggering a blocking upstream fetch.
  // Reuses the on-demand fetch path (and its circuit breaker / conditional
  // requests) and dedups against in-flight refreshes via the same inFlight map.
  async function warmStaleFeeds(): Promise<number> {
    const now = Date.now();
    const rows = db
      .query<CacheRow, [number, number, number, number]>(
        `SELECT * FROM cache
				WHERE fetched_at < ?
					AND (next_retry_at IS NULL OR next_retry_at < ?)
					AND last_requested_at IS NOT NULL
					AND last_requested_at > ?
				ORDER BY fetched_at ASC
				LIMIT ?`
      )
      .all(now - warmRefreshThresholdMs, now, now - warmActiveWindowMs, warmBatchCap);

    if (rows.length === 0) return 0;

    const queue = [...rows];
    let refreshed = 0;

    async function worker(): Promise<void> {
      for (let row = queue.shift(); row; row = queue.shift()) {
        // Skip feeds an on-demand request is already refreshing.
        if (inFlight.has(row.url_hash)) continue;
        const promise = fetchParseAndCache(row.url, row.url_hash, row).finally(() => {
          inFlight.delete(row.url_hash);
        });
        inFlight.set(row.url_hash, promise);
        try {
          const feed = await promise;
          refreshed++;
          // Pre-warm Phase 5 mention counts for this feed's items (decay-gated).
          if (feed && warmMentionsEnabled) warmFeedItemMentions(feed);
        } catch {
          // fetchParseAndCache already records errors/backoff; never let one
          // bad feed abort the warm tick.
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(warmConcurrency, queue.length) }, worker));

    return refreshed;
  }

  // --- standard.site documents -------------------------------------------------
  // Mirrors fetchParseAndCache for an author's resolved document list: circuit
  // breaker on backoff, fetch + resolve via fetchDocumentsForAuthor, persist, and
  // fall back to stale-but-real content on error.

  async function fetchAndCacheDocuments(
    did: string,
    cached?: DocumentCacheRow
  ): Promise<ProxyDocument[] | null> {
    const now = Date.now();

    // Circuit breaker: respect backoff window.
    if (cached?.next_retry_at && now < cached.next_retry_at) {
      return cached.documents_json ? (JSON.parse(cached.documents_json) as ProxyDocument[]) : null;
    }

    try {
      const documents = await fetchDocumentsForAuthor(db, did);
      const documentsJson = JSON.stringify(documents);

      // last_requested_at only set on insert (a real client miss), not on the
      // warm-loop refresh path — same rationale as the feed cache.
      db.run(
        `INSERT INTO document_cache (did, documents_json, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at, last_requested_at)
				VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, ?)
				ON CONFLICT(did) DO UPDATE SET
					documents_json = excluded.documents_json,
					cached_at = excluded.cached_at,
					fetched_at = excluded.fetched_at,
					error_count = 0,
					last_error = NULL,
					last_error_at = NULL,
					next_retry_at = NULL`,
        [did, documentsJson, now, now, now]
      );

      return documents;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const newErrorCount = (cached?.error_count || 0) + 1;
      const nextRetryAt =
        newErrorCount >= MAX_RECOVERABLE_ERRORS
          ? now + PERMANENT_ERROR_DELAY_MS
          : now + calculateBackoff(newErrorCount);
      console.error(
        `[Proxy] documents ${did}: ${msg} (retry at ${new Date(nextRetryAt).toISOString()})`
      );

      if (cached) {
        db.run(
          'UPDATE document_cache SET error_count = ?, last_error = ?, last_error_at = ?, next_retry_at = ? WHERE did = ?',
          [newErrorCount, msg, now, nextRetryAt, did]
        );
      } else {
        db.run(
          `INSERT INTO document_cache (did, documents_json, cached_at, fetched_at, error_count, last_error, last_error_at, next_retry_at, last_requested_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [did, '[]', now, now, newErrorCount, msg, now, nextRetryAt, now]
        );
      }

      // Serve stale-but-real documents if we have them.
      if (cached?.documents_json) {
        const stale = JSON.parse(cached.documents_json) as ProxyDocument[];
        if (stale.length > 0) return stale;
      }
      return null;
    }
  }

  function triggerBackgroundDocumentRefresh(did: string, cached?: DocumentCacheRow): void {
    if (inFlightDocs.has(did)) return;
    const promise = fetchAndCacheDocuments(did, cached).finally(() => {
      inFlightDocs.delete(did);
    });
    inFlightDocs.set(did, promise);
  }

  function recordDocumentRequest(did: string, now: number): void {
    db.run('UPDATE document_cache SET last_requested_at = ? WHERE did = ?', [now, did]);
  }

  // Proactively refresh active authors' documents before they go stale, mirroring
  // warmStaleFeeds.
  async function warmStaleDocuments(): Promise<number> {
    const now = Date.now();
    const rows = db
      .query<DocumentCacheRow, [number, number, number, number]>(
        `SELECT * FROM document_cache
				WHERE fetched_at < ?
					AND (next_retry_at IS NULL OR next_retry_at < ?)
					AND last_requested_at IS NOT NULL
					AND last_requested_at > ?
				ORDER BY fetched_at ASC
				LIMIT ?`
      )
      .all(now - warmRefreshThresholdMs, now, now - warmActiveWindowMs, warmBatchCap);

    if (rows.length === 0) return 0;

    const queue = [...rows];
    let refreshed = 0;

    async function worker(): Promise<void> {
      for (let row = queue.shift(); row; row = queue.shift()) {
        if (inFlightDocs.has(row.did)) continue;
        const promise = fetchAndCacheDocuments(row.did, row).finally(() => {
          inFlightDocs.delete(row.did);
        });
        inFlightDocs.set(row.did, promise);
        try {
          await promise;
          refreshed++;
        } catch {
          // errors already recorded in fetchAndCacheDocuments
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(warmConcurrency, queue.length) }, worker));
    return refreshed;
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
      .query<
        { count: number },
        [number]
      >('SELECT COUNT(*) as count FROM cache WHERE fetched_at > ?')
      .get(now - cacheTtlMs);
    const stale = db
      .query<
        { count: number },
        [number, number]
      >('SELECT COUNT(*) as count FROM cache WHERE fetched_at <= ? AND fetched_at > ?')
      .get(now - cacheTtlMs, now - staleTtlMs);

    // Error statistics
    const inError = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM cache WHERE error_count > 0')
      .get();
    const inBackoff = db
      .query<
        { count: number },
        [number]
      >('SELECT COUNT(*) as count FROM cache WHERE next_retry_at > ?')
      .get(now);
    const permanentErrors = db
      .query<
        { count: number },
        [number]
      >('SELECT COUNT(*) as count FROM cache WHERE next_retry_at > ? AND error_count >= 5')
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
    const limit = limitParam
      ? Math.min(parseInt(limitParam, 10) || defaultLimit, 500)
      : defaultLimit;

    const urlHash = hashUrl(feedUrl);
    const now = Date.now();

    const cached = db
      .query<CacheRow, [string]>('SELECT * FROM cache WHERE url_hash = ?')
      .get(urlHash);
    recordRequest(urlHash, now);

    let feed: ParsedFeed | null = null;
    let cacheStatus: string;

    if (cached) {
      const age = now - cached.fetched_at;
      const isInErrorBackoff =
        cached.error_count > 0 && cached.next_retry_at && now < cached.next_retry_at;
      const cachedFeed = JSON.parse(cached.parsed_json) as ParsedFeed;
      const hasRealContent = cachedFeed.items.length > 0 || cachedFeed.title !== '';
      const isErrorPlaceholder = cached.error_count > 0 && !hasRealContent;

      // Return error response for empty error placeholders in backoff period
      if (isInErrorBackoff && isErrorPlaceholder) {
        return c.json(
          {
            feed: null,
            cache: 'ERROR',
            filter: 'NONE',
            error: cached.last_error || 'Failed to fetch feed',
            errorCount: cached.error_count,
            nextRetryAt: cached.next_retry_at,
          },
          502
        );
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
      return c.json(
        {
          feed: null,
          cache: 'ERROR',
          filter: 'NONE',
          error: errorCache?.last_error || 'Failed to fetch feed',
          errorCount: errorCache?.error_count || 0,
          nextRetryAt: errorCache?.next_retry_at || undefined,
        },
        502
      );
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

    return c.json(
      {
        feed: filteredFeed,
        cache: cacheStatus!,
        filter: filterHeader,
        totalItems: feed.items.length,
        returnedItems: filterResult.items.length,
      },
      200,
      headers
    );
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
        const { error, blocked } = describeFetchFailure(response.status, siteUrl);
        // A clean upstream block is a successful determination on our side
        // (the proxy worked; the site refused us), so don't return 502 — that
        // reads like our gateway failed. Other upstream failures stay 502.
        return c.json({ error, blocked }, blocked ? 200 : 502);
      }

      const contentType = response.headers.get('Content-Type') || '';
      const text = await readResponseWithLimit(response, MAX_RESPONSE_SIZE_BYTES);

      // If it's already a feed, return the URL
      if (
        contentType.includes('xml') ||
        contentType.includes('rss') ||
        contentType.includes('atom')
      ) {
        return c.json({ feeds: [siteUrl], standardSites: [] });
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

      // Detect standard.site (AT Protocol) advertisements. Sites expose these as
      // <link> tags whose href is an at:// URI pointing to either a
      // site.standard.document record (article pages) or a site.standard.publication
      // record (publication homepages), e.g.
      // <link rel="site.standard.publication" href="at://did/site.standard.publication/rkey">.
      // The at:// href (regardless of rel) is the reliable signal.
      const standardSites: string[] = [];
      const maxStandardSites = 5;
      const linkTagRegex = /<link\b[^>]*>/gi;
      let linkTag;
      while (
        (linkTag = linkTagRegex.exec(text)) !== null &&
        standardSites.length < maxStandardSites
      ) {
        const href = linkTag[0].match(/href=["']([^"']+)["']/i)?.[1];
        if (
          href &&
          href.startsWith('at://') &&
          (href.includes('/site.standard.document/') ||
            href.includes('/site.standard.publication/')) &&
          !standardSites.includes(href)
        ) {
          standardSites.push(href);
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

      return c.json({ feeds, standardSites });
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

  // Fetch a URL and return cleaned, extracted article content (Defuddle).
  // Results are cached (article content is effectively immutable per URL), so
  // repeat and cross-user saves of the same article skip the fetch + extract.
  app.post('/extract', async (c) => {
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

    const url = body.url;
    const urlHash = hashUrl(url);
    const now = Date.now();

    // Serve from cache when fresh.
    const cached = db
      .query<
        { extracted_json: string; cached_at: number },
        [string]
      >('SELECT extracted_json, cached_at FROM extract_cache WHERE url_hash = ?')
      .get(urlHash);
    if (cached && now - cached.cached_at < EXTRACT_CACHE_TTL_MS) {
      c.header('X-Cache', 'HIT');
      c.header('X-Cache-Age', String(Math.floor((now - cached.cached_at) / 1000)));
      return c.body(cached.extracted_json, 200, {
        'Content-Type': 'application/json',
      });
    }

    // Collapse concurrent extractions of the same URL into one fetch + parse.
    let pending = inFlightExtract.get(urlHash);
    const isLeader = !pending;
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url, {
          headers: {
            ...FETCH_HEADERS,
            Accept: 'text/html, application/xhtml+xml, */*',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const { error, blocked } = describeFetchFailure(response.status, url);
          throw new FetchHtmlError(error, 502, blocked);
        }

        const html = await readResponseWithLimit(response, MAX_RESPONSE_SIZE_BYTES);
        const extracted = await extractArticle(html, url);

        db.run(
          'INSERT OR REPLACE INTO extract_cache (url_hash, url, extracted_json, cached_at) VALUES (?, ?, ?, ?)',
          [urlHash, url, JSON.stringify(extracted), Date.now()]
        );

        return extracted;
      })();
      inFlightExtract.set(urlHash, pending);
    }

    try {
      const extracted = await pending;
      c.header('X-Cache', isLeader ? 'MISS' : 'COALESCED');
      return c.json(extracted);
    } catch (error) {
      if (error instanceof FetchHtmlError) {
        return c.json({ error: error.message, blocked: error.blocked }, 502);
      }
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
    } finally {
      if (isLeader) inFlightExtract.delete(urlHash);
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

    let feedRequests: Array<{
      url: string;
      sinceGuids: Set<string>;
      limit: number;
    }>;

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
        recordRequest(urlHash, now);

        let feed: ParsedFeed | null = null;
        let cacheStatus: string;

        if (cached) {
          const age = now - cached.fetched_at;
          const isInErrorBackoff =
            cached.error_count > 0 && cached.next_retry_at && now < cached.next_retry_at;
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

  // Bulk standard.site document endpoint. Symmetric with /feeds, but keyed by
  // author DID instead of feed URL. Returns each requested author's documents
  // (scoped to a publication and trimmed to what the client hasn't seen yet).
  app.post('/documents', async (c) => {
    if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { authors?: DocumentRequestEntry[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const authors = body.authors;
    if (!Array.isArray(authors)) {
      return c.json({ error: 'Missing authors array' }, 400);
    }
    if (authors.length === 0) {
      return c.json({ error: 'Empty request' }, 400);
    }
    if (authors.length > 50) {
      return c.json({ error: 'Too many authors (max 50)' }, 400);
    }

    const now = Date.now();

    interface DocumentResult {
      did: string;
      siteUri?: string;
      documents: ProxyDocument[];
      status: 'ready' | 'error';
      error?: string;
      errorCount?: number;
      nextRetryAt?: number;
    }

    const results: DocumentResult[] = await Promise.all(
      authors.map(async (entry): Promise<DocumentResult> => {
        const { did, siteUri } = entry;

        if (!did || typeof did !== 'string' || !did.startsWith('did:')) {
          return {
            did: String(did),
            siteUri,
            documents: [],
            status: 'error',
            error: 'Invalid DID',
          };
        }

        const cached = db
          .query<DocumentCacheRow, [string]>('SELECT * FROM document_cache WHERE did = ?')
          .get(did);
        recordDocumentRequest(did, now);

        let documents: ProxyDocument[] | null = null;

        if (cached && cached.documents_json) {
          const age = now - cached.fetched_at;
          const inErrorBackoff =
            cached.error_count > 0 && cached.next_retry_at && now < cached.next_retry_at;
          const stale = JSON.parse(cached.documents_json) as ProxyDocument[];
          const isErrorPlaceholder = cached.error_count > 0 && stale.length === 0;

          if (inErrorBackoff && isErrorPlaceholder) {
            return {
              did,
              siteUri,
              documents: [],
              status: 'error',
              error: cached.last_error || 'Failed to fetch documents',
              errorCount: cached.error_count,
              nextRetryAt: cached.next_retry_at ?? undefined,
            };
          }

          if (!isErrorPlaceholder) {
            if (age < cacheTtlMs) {
              documents = stale;
            } else if (age < staleTtlMs) {
              documents = stale;
              triggerBackgroundDocumentRefresh(did, cached);
            }
          }
        }

        if (!documents) {
          documents = await fetchAndCacheDocuments(did, cached ?? undefined);
        }

        if (!documents) {
          const errorCache = db
            .query<DocumentCacheRow, [string]>('SELECT * FROM document_cache WHERE did = ?')
            .get(did);
          return {
            did,
            siteUri,
            documents: [],
            status: 'error',
            error: errorCache?.last_error || 'Failed to fetch documents',
            errorCount: errorCache?.error_count || 0,
            nextRetryAt: errorCache?.next_retry_at || undefined,
          };
        }

        const scoped = filterByPublication(documents, siteUri);
        const trimmed = filterSinceUris(scoped, new Set(entry.since_uris || []));

        return { did, siteUri, documents: trimmed, status: 'ready' };
      })
    );

    return c.json({ authors: results });
  });

  // Linkblog registry (Phase 6): the DIDs of everyone with a Skyreader linkblog,
  // from one cached Constellation marker query. The backend intersects this with
  // a user's Bluesky follows (onboarding) or lists it whole (/discover). Cheap,
  // global, and degrades to empty/stale on a Constellation outage.
  app.get('/linkblog-registry', async (c) => {
    if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const dids = await getLinkblogRegistry(db);
    return c.json({ dids });
  });

  // Social context for link posts (Phase 3). Batch lookup of Constellation
  // backlink data — recommend/quote counts + "who else linked this article" — per
  // link post. Adornment only: each item degrades silently to zeros/empty, and
  // the whole endpoint is best-effort so the read never depends on it.
  app.post('/social-context', async (c) => {
    if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { items?: Array<SocialContextQuery & { key?: string }> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const items = body.items;
    if (!Array.isArray(items)) {
      return c.json({ error: 'Missing items array' }, 400);
    }
    if (items.length === 0) {
      return c.json({ error: 'Empty request' }, 400);
    }
    if (items.length > 25) {
      return c.json({ error: 'Too many items (max 25)' }, 400);
    }

    const results = await Promise.all(
      items.map(async (item) => {
        const query: SocialContextQuery = {
          docUri: item.docUri,
          articleUrl: item.articleUrl,
          excludeDid: item.excludeDid,
        };
        // Key the response back to the request (the client's own `key`, or the
        // docUri, so it can reconcile by position-independent id).
        const key = item.key || item.docUri || item.articleUrl || '';
        const inflightKey = `${query.docUri || ''}|${query.articleUrl || ''}|${query.excludeDid || ''}`;

        let pending = inFlightContext.get(inflightKey);
        if (!pending) {
          pending = getSocialContext(db, query).finally(() => {
            inFlightContext.delete(inflightKey);
          });
          inFlightContext.set(inflightKey, pending);
        }

        try {
          const context = await pending;
          return { key, ...context };
        } catch (error) {
          // Best-effort: never fail the batch over one item.
          console.error('[social-context] item error:', error);
          return { key, recommendCount: 0, quoteCount: 0, alsoLinkedBy: [] };
        }
      })
    );

    return c.json({ items: results });
  });

  // Network-wide article mentions (Phase 5). Batch lookup of the per-lane
  // breakdown for a set of article URLs, keyed back by the original URL string.
  // Non-blocking: returns whatever is cached now (empty on a cold/sub-threshold
  // URL) and triggers a decay-gated background enrichment so a later poll has it.
  // Adornment only — the read never depends on it.
  app.post('/mentions', async (c) => {
    if (proxySecret && c.req.header('X-Proxy-Secret') !== proxySecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { urls?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const urls = body.urls;
    if (!Array.isArray(urls)) {
      return c.json({ error: 'Missing urls array' }, 400);
    }
    if (urls.length === 0) {
      return c.json({ error: 'Empty request' }, 400);
    }
    if (urls.length > 50) {
      return c.json({ error: 'Too many urls (max 50)' }, 400);
    }

    const now = Date.now();
    const seen = new Set<string>();
    const items = urls.map((url) => {
      // Dedup repeated URLs in one batch; only the first triggers enrichment.
      const fresh = !seen.has(url);
      seen.add(url);
      const { normUrl, mentions, shouldEnrich } = readCachedMentions(db, url, now);
      if (fresh && shouldEnrich && normUrl) triggerMentionEnrich(normUrl);
      return { url, total: mentions.total, lanes: mentions.lanes };
    });

    return c.json({ items });
  });

  return { app, inFlight, inFlightDocs, warmStaleFeeds, warmStaleDocuments };
}

export function cleanupCache(db: Database): number {
  const now = Date.now();
  const threshold = now - 7 * 24 * 60 * 60 * 1000; // 7 days
  const result = db.run('DELETE FROM cache WHERE fetched_at < ?', [threshold]);
  const extractResult = db.run('DELETE FROM extract_cache WHERE cached_at < ?', [
    now - EXTRACT_CACHE_TTL_MS,
  ]);
  // Documents age out on the same 7-day idle window as feeds.
  const docResult = db.run('DELETE FROM document_cache WHERE fetched_at < ?', [threshold]);
  // Constellation context is short-lived; drop anything past a generous window so
  // the table can't accumulate stale link-post bundles.
  const constellationResult = db.run('DELETE FROM constellation_cache WHERE cached_at < ?', [
    now - 24 * 60 * 60 * 1000,
  ]);
  // Mention rows settle (stop being re-checked) after ~7 days; drop them well
  // past that so the article is old and rarely read by the time it's evicted.
  const mentionResult = db.run('DELETE FROM mention_cache WHERE checked_at < ?', [
    now - 30 * 24 * 60 * 60 * 1000,
  ]);
  return (
    result.changes +
    extractResult.changes +
    docResult.changes +
    constellationResult.changes +
    mentionResult.changes
  );
}
