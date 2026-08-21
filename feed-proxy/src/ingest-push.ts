import type { Database } from 'bun:sqlite';
import type { FeedItem } from './types';
import { hashUrl, itemContentHash } from './app';

/**
 * Ingest push: the proxy stops being a read path and becomes a crawler that
 * pushes deltas into its paired Worker's D1.
 *
 * The durable item log IS the outbox — there is no separate queue. A row is
 * *dirty* when `push_state` has no row for its seq, or the hash we last pushed
 * differs from the row's current `content_hash`. That comparison is race-free
 * against concurrent edits: if `writeFeedItems` rewrites an item between select
 * and ack, the hashes no longer match and the row simply re-qualifies.
 *
 * One proxy pushes to exactly ONE Worker (prod proxy → prod Worker, staging
 * proxy → staging Worker), so delivery state is keyed by seq alone. With
 * `INGEST_URL` unset both loops are disabled — the safe default for local dev
 * and the gate for a staged rollout.
 */

export interface IngestConfig {
  // Base URL of the paired Worker, e.g. https://api.skyreader.app
  ingestUrl: string;
  // Shared secret, sent as X-Proxy-Secret (the same PROXY_SECRET the Worker uses
  // to authenticate to us — one secret per environment, no new names).
  secret?: string;
  // Items per push request. The Worker's own cap is well above this.
  batchSize?: number;
  timeoutMs?: number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

interface DirtyRow {
  seq: number;
  url_hash: string;
  guid: string;
  item_json: string;
  published_at: number | null;
  first_seen_at: number;
  content_hash: string;
  feed_url: string;
}

interface FeedMetaRow {
  url_hash: string;
  url: string;
  title: string | null;
  site_url: string | null;
  description: string | null;
  image_url: string | null;
}

export interface PushResult {
  pushed: number;
  // True when the log still holds dirty rows beyond this batch.
  hasMore: boolean;
  error?: string;
}

// The dirty-scan walks the WHOLE item log every push cycle, almost always to
// find nothing. It must stay on idx_feed_items_push (seq, content_hash,
// url_hash) so filtering and the cache join never touch item_json row pages —
// only genuinely dirty rows get fetched. Exported so the query-plan tests can
// pin that; app.ts's /stats pending count inlines the same shape (it can't
// import from here — circular).
export const DIRTY_ROWS_SQL = `SELECT fi.seq, fi.url_hash, fi.guid, fi.item_json, fi.published_at, fi.first_seen_at,
			        COALESCE(fi.content_hash, '') AS content_hash, c.url AS feed_url
			   FROM feed_items fi
			   JOIN cache c ON c.url_hash = fi.url_hash
			   LEFT JOIN push_state ps ON ps.seq = fi.seq
			  WHERE ps.seq IS NULL OR ps.pushed_hash <> COALESCE(fi.content_hash, '')
			  ORDER BY fi.seq ASC
			  LIMIT ?`;

export const DIRTY_COUNT_SQL = `SELECT COUNT(*) AS count
		     FROM feed_items fi
		     JOIN cache c ON c.url_hash = fi.url_hash
		     LEFT JOIN push_state ps ON ps.seq = fi.seq
		    WHERE ps.seq IS NULL OR ps.pushed_hash <> COALESCE(fi.content_hash, '')`;

export interface PushLoopDeps {
  /** One push attempt — pushDirtyItems bound to this proxy's db/config. */
  push: () => Promise<PushResult>;
  /** Gap between back-to-back pushes while draining a backlog. */
  chainDelayMs: number;
  /** Backoff schedule after `failures` consecutive failed pushes. */
  backoff: (failures: number) => number;
  schedule: (fn: () => void, delayMs: number) => void;
  now: () => number;
  /** Unexpected-rejection hook (Sentry in prod). */
  onError?: (error: unknown) => void;
}

/**
 * The push loop: one push, which re-schedules itself while a backlog remains.
 * The caller drives the steady-state cadence (setInterval in index.ts); this
 * owns the drain chaining, the failure backoff, and the re-entrancy guard.
 *
 * The steady-state interval is tuned for a trickle of freshly crawled items —
 * at 100 items per tick it drains ~400/min. That is the wrong shape for a
 * backlog: the first prod backfill queued 175k items, where the interval (not
 * the work) was the bottleneck and the pusher sat idle ~90% of the time. So
 * when a push comes back with `hasMore`, go again after `chainDelayMs` instead
 * of waiting out the interval. This self-limits: the moment the backlog clears,
 * `hasMore` is false and the loop reverts to the plain interval, with no
 * configuration to remember to change back.
 *
 * Two guards keep it from spinning:
 *   - Only chain on `pushed > 0`. A push that moved nothing cannot have made
 *     progress, so chaining on it would busy-loop against D1 forever if
 *     anything ever left rows permanently dirty.
 *   - Only chain on success. A failure blocks the loop until `backoff` elapses,
 *     and the backoff owns the retry timing.
 */
export function createPushLoop(deps: PushLoopDeps): () => void {
  let running = false;
  let failures = 0;
  let blockedUntil = 0;

  const runPush = (): void => {
    if (running || deps.now() < blockedUntil) return;
    running = true;
    let drainMore = false;
    deps
      .push()
      .then((result) => {
        if (result.error) {
          failures++;
          blockedUntil = deps.now() + deps.backoff(failures);
          console.error(`[Proxy] Ingest push failed (${failures}): ${result.error}`);
          return;
        }
        failures = 0;
        if (result.pushed > 0) console.log(`[Proxy] Ingest pushed ${result.pushed} item(s)`);
        drainMore = result.hasMore && result.pushed > 0;
      })
      .catch((error) => {
        console.error('[Proxy] Ingest push error:', error);
        deps.onError?.(error);
      })
      .finally(() => {
        running = false;
        if (drainMore) deps.schedule(runPush, deps.chainDelayMs);
      });
  };
  return runPush;
}

export function selectDirtyRows(db: Database, limit: number): DirtyRow[] {
  return db.query<DirtyRow, [number]>(DIRTY_ROWS_SQL).all(limit);
}

export function countDirtyRows(db: Database): number {
  return db.query<{ count: number }, []>(DIRTY_COUNT_SQL).get()?.count ?? 0;
}

function feedMetadata(db: Database, urlHashes: string[]): FeedMetaRow[] {
  if (urlHashes.length === 0) return [];
  const placeholders = urlHashes.map(() => '?').join(',');
  return db
    .query<FeedMetaRow, string[]>(
      `SELECT url_hash, url,
			        json_extract(parsed_json, '$.title')       AS title,
			        json_extract(parsed_json, '$.siteUrl')     AS site_url,
			        json_extract(parsed_json, '$.description') AS description,
			        json_extract(parsed_json, '$.imageUrl')    AS image_url
			   FROM cache
			  WHERE url_hash IN (${placeholders})`
    )
    .all(...urlHashes);
}

function ackPushed(db: Database, rows: DirtyRow[]): void {
  const upsert = db.query(
    `INSERT INTO push_state (seq, pushed_hash) VALUES (?, ?)
		 ON CONFLICT(seq) DO UPDATE SET pushed_hash = excluded.pushed_hash`
  );
  // Ack the hash we actually PUSHED, not the row's hash right now: if the item
  // was edited mid-flight the two differ and the row stays dirty for the next
  // cycle, which is exactly what we want.
  db.transaction(() => {
    for (const row of rows) upsert.run(row.seq, row.content_hash);
  })();
}

/**
 * Drain one batch of dirty rows to the paired Worker. Rows go in seq order, so
 * within-feed order in D1 matches proxy first-seen order — all the cursor
 * semantics need. On any failure nothing is acked and the same rows retry.
 */
export async function pushDirtyItems(db: Database, config: IngestConfig): Promise<PushResult> {
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const rows = selectDirtyRows(db, batchSize);
  if (rows.length === 0) return { pushed: 0, hasMore: false };

  const urlHashes = [...new Set(rows.map((r) => r.url_hash))];
  const feeds = feedMetadata(db, urlHashes).map((meta) => ({
    feedUrl: meta.url,
    title: meta.title,
    siteUrl: meta.site_url,
    description: meta.description,
    imageUrl: meta.image_url,
  }));

  const items = rows.map((row) => {
    const item = JSON.parse(row.item_json) as FeedItem;
    return {
      // ALWAYS the registered/requested URL (cache.url), never a post-redirect
      // one: D1 joins subscriptions on this exact string.
      feedUrl: row.feed_url,
      guid: row.guid,
      item,
      publishedAt: row.published_at,
      firstSeenAt: row.first_seen_at,
      // A pre-hash legacy row still needs a hash for D1's NOT NULL column.
      contentHash: row.content_hash || itemContentHash(item),
    };
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.secret) headers['X-Proxy-Secret'] = config.secret;

  try {
    const response = await fetch(`${config.ingestUrl}/api/internal/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ feeds, items }),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        pushed: 0,
        hasMore: true,
        error: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      };
    }

    ackPushed(db, rows);
    return { pushed: rows.length, hasMore: rows.length >= batchSize };
  } catch (error) {
    return {
      pushed: 0,
      hasMore: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Register a feed in the crawl set: create its cache row if missing and stamp
 * `last_requested_at`. That single stamp is the whole trick — the existing warm
 * loop, active window and eviction machinery then work unchanged, with the
 * Worker's subscription table (rather than read traffic) driving warmth.
 *
 * A newly created row starts with parser_version 0 and fetched_at 0 so the warm
 * loop treats it as due immediately.
 */
export function registerCrawlFeeds(db: Database, feedUrls: string[], now: number): number {
  if (feedUrls.length === 0) return 0;
  const upsert = db.query(
    `INSERT INTO cache (url_hash, url, parsed_json, parser_version, parser_upgrade_attempted_version,
		                    cached_at, fetched_at, error_count, last_requested_at)
		 VALUES (?, ?, '{"title":"","items":[],"fetchedAt":0}', 0, 0, 0, 0, 0, ?)
		 ON CONFLICT(url_hash) DO UPDATE SET last_requested_at = excluded.last_requested_at`
  );
  let registered = 0;
  db.transaction(() => {
    for (const url of feedUrls) {
      if (!url) continue;
      upsert.run(hashUrl(url), url, now);
      registered++;
    }
  })();
  return registered;
}

export interface CrawlSetResult {
  registered: number;
  error?: string;
}

/**
 * One broken feed, as reported to the Worker. Timestamps are unix SECONDS on the
 * wire — the cache stores milliseconds (everything here compares against
 * `Date.now()`), and the Worker's `feeds` table is in seconds like the rest of
 * the backend, so the conversion happens once, here.
 */
export interface FeedHealthReport {
  feedUrl: string;
  errorCount: number;
  lastError: string | null;
  lastErrorAt: number | null;
  nextRetryAt: number | null;
  lastFetchAt: number | null;
  // In the crawl set but not fetched in CRAWL_STALE_MS — starved by a saturated
  // warm loop rather than failing. `errorCount` can be 0 while this is true.
  crawlStale: boolean;
}

// How long a crawl-set feed may go unfetched before it counts as starved. The
// warm loop works on a minutes-long cadence (a 300s cache TTL refreshed at
// ~180s), so hours without a fetch means this feed is losing its turn every
// tick — the failure mode a capped warm batch produces.
export const CRAWL_STALE_MS = 2 * 60 * 60 * 1000;

function toSeconds(ms: number | null | undefined): number | null {
  return ms ? Math.floor(ms / 1000) : null;
}

/**
 * Every crawl-set feed with something wrong with it: failing to fetch, starved
 * of fetches, or both.
 *
 * Deliberately the whole trouble set rather than a delta: the Worker infers
 * recovery from a feed's ABSENCE here, so a feed that starts working again needs
 * no message of its own. Only rows still in the crawl set count — a feed evicted
 * by `cleanupCache` is nobody's problem any more.
 */
export function selectFeedHealth(db: Database, now = Date.now()): FeedHealthReport[] {
  const staleBefore = now - CRAWL_STALE_MS;
  const all = db
    .query<
      {
        url: string;
        error_count: number;
        last_error: string | null;
        last_error_at: number | null;
        next_retry_at: number | null;
        fetched_at: number | null;
      },
      [number]
    >(
      `SELECT url, error_count, last_error, last_error_at, next_retry_at, fetched_at
			   FROM cache
			  WHERE last_requested_at IS NOT NULL
			    AND (error_count > 0 OR fetched_at < ?)`
    )
    .all(staleBefore)
    .map((row) => ({
      feedUrl: row.url,
      errorCount: row.error_count,
      lastError: row.last_error,
      lastErrorAt: toSeconds(row.last_error_at),
      nextRetryAt: toSeconds(row.next_retry_at),
      // 0 means never fetched — an error placeholder from a first-crawl failure,
      // or a row the crawl set just registered. Not a timestamp.
      lastFetchAt: toSeconds(row.fetched_at),
      crawlStale: (row.fetched_at ?? 0) < staleBefore,
    }));

  return boundHealthReport(all);
}

/**
 * Keep the report under the Worker's `MAX_HEALTH_FEEDS` (2000), which rejects an
 * oversized body outright with `400 Too many feeds` — turning "some feeds are
 * stale" into "feed health stops updating at all, in both directions, forever".
 *
 * Whole-set-not-a-delta is the invariant here: the Worker infers recovery from a
 * feed's ABSENCE, so anything dropped is marked healthy. That makes WHAT gets
 * dropped a correctness question, not a preference:
 *
 * - `error_count > 0` entries are ALWAYS kept. They drive the reader's per-feed
 *   error badges, so dropping one silently clears a real error. This set is small
 *   by construction (a few hundred) — it has never approached the cap.
 * - `crawlStale`-only entries fill whatever budget is left. Dropping one is
 *   survivable: `crawl_stale` is an operator signal, deliberately excluded from
 *   `feed_health_rev`, and invisible to readers.
 *
 * The stale set is what actually balloons — a full warm cycle longer than
 * CRAWL_STALE_MS marks every unvisited feed stale at once, and with ~5,600 feeds
 * registered that is three times the cap. Never truncate silently: the log line
 * is the only thing that would tell an operator the crawler is falling behind.
 */
export const MAX_HEALTH_REPORT_FEEDS = 1500;

function boundHealthReport(reports: FeedHealthReport[]): FeedHealthReport[] {
  if (reports.length <= MAX_HEALTH_REPORT_FEEDS) return reports;

  const erroring = reports.filter((r) => r.errorCount > 0);
  const staleOnly = reports.filter((r) => r.errorCount === 0);
  const budget = Math.max(0, MAX_HEALTH_REPORT_FEEDS - erroring.length);
  const dropped = staleOnly.length - Math.min(staleOnly.length, budget);

  if (dropped > 0) {
    console.warn(
      `[Proxy] Feed health: ${reports.length} feeds in trouble exceeds the ${MAX_HEALTH_REPORT_FEEDS} cap; ` +
        `reporting ${erroring.length} erroring + ${Math.min(staleOnly.length, budget)} stale, ` +
        `dropping ${dropped} stale-only. The warm loop is not keeping up with the crawl set.`
    );
  }

  // Erroring feeds first so they survive even if they alone were to exceed the
  // cap — an over-cap body is rejected wholesale, so a truncated report always
  // beats no report.
  return [...erroring, ...staleOnly.slice(0, budget)].slice(0, MAX_HEALTH_REPORT_FEEDS);
}

export interface FeedHealthResult {
  reported: number;
  error?: string;
}

/**
 * Push the trouble set to the paired Worker: the erroring feeds it serves to
 * readers, and the starved ones the admin alarms on. An empty list is a
 * meaningful report — it is how "everything recovered" is communicated — so this
 * always posts.
 */
export async function reportFeedHealth(
  db: Database,
  config: IngestConfig
): Promise<FeedHealthResult> {
  const feeds = selectFeedHealth(db);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.secret) headers['X-Proxy-Secret'] = config.secret;

  try {
    const response = await fetch(`${config.ingestUrl}/api/internal/feed-health`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ feeds }),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return { reported: 0, error: `HTTP ${response.status}` };
    return { reported: feeds.length };
  } catch (error) {
    return {
      reported: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Pull the crawl set from the paired Worker and stamp every feed in it.
 */
export async function pullCrawlSet(db: Database, config: IngestConfig): Promise<CrawlSetResult> {
  const headers: Record<string, string> = {};
  if (config.secret) headers['X-Proxy-Secret'] = config.secret;

  try {
    const response = await fetch(`${config.ingestUrl}/api/internal/crawl-set`, {
      headers,
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { registered: 0, error: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as { feeds?: Array<{ feedUrl: string }> };
    const urls = (body.feeds ?? []).map((f) => f.feedUrl).filter(Boolean);
    return { registered: registerCrawlFeeds(db, urls, Date.now()) };
  } catch (error) {
    return {
      registered: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
