import type { Env, FeedItem } from '../types';

/**
 * Internal (proxy → Worker) endpoints for the D1-served feed timeline.
 *
 * The Fly proxy is the crawler; it pushes deltas from its durable log here and
 * pulls the set of feeds it should crawl. Neither endpoint has a user session —
 * both are authenticated with the shared `FEED_PROXY_SECRET` (the same value the
 * Worker sends outbound as `X-Proxy-Secret`), so no new secret exists to manage.
 */

// Per-feed sanity cap. D1 is an archive: ordinary ingest never prunes. This trim
// exists only to bound a pathological feed (GUID churn re-minting ids every
// fetch, calendar feeds reposting their whole window). A daily-cadence feed takes
// ~14 years to reach it, so a feed at the cap is a bug signal, not steady state.
export const SANITY_CAP = 5000;

// Stored-content cap per item. Unbounded retention makes this mandatory rather
// than optional: D1 has a hard 10 GB database ceiling, so storage grows with
// ingest velocity × item size × time. Oversized bodies are dropped at ingest
// (summary/title/url/image kept) and `contentTruncated` is set, which the reader
// acts on: ArticleCard auto-extracts the full text via /api/extract when a
// truncated article is opened, so the body the user sees is still the whole
// article (see frontend/src/lib/components/ArticleCard.svelte).
export const MAX_ITEM_CONTENT_BYTES = 8 * 1024;

// How long a crawler heartbeat stays "fresh". The proxy pulls the crawl set every
// 5 minutes whenever INGEST_URL is set, so a stamp older than this means this
// environment has no crawler pushing into its D1 — the timeline says so and
// clients stay on the legacy batch path instead of serving an empty archive.
export const CRAWLER_HEARTBEAT_KEY = 'crawler_heartbeat_at';
export const CRAWLER_HEARTBEAT_FRESH_SECONDS = 30 * 60;

// Revision token for the set of feeds the crawler currently considers broken.
// The timeline sends the per-feed health payload only when the client's echoed
// revision differs from this, so a steady-state poll costs no extra query.
export const FEED_HEALTH_REV_KEY = 'feed_health_rev';

// Bounds on one ingest call. The pusher chunks to ~100 items; these are abuse
// guards, not tuning knobs.
const MAX_INGEST_ITEMS = 1000;
const MAX_INGEST_BODY_BYTES = 8 * 1024 * 1024;

// D1 caps statements per batch; keep well under it.
const INGEST_BATCH_SIZE = 50;

/**
 * Subscriptions that aren't RSS feeds (standard.site documents, collections)
 * never belong to the crawl set or the timeline — their `feed_url` is an at://
 * URI, and the client skips every `atproto.*` source on the feed path too.
 */
export function rssSubscriptionPredicate(alias = ''): string {
  const column = alias ? `${alias}.source_type` : 'source_type';
  return `(${column} IS NULL OR ${column} NOT LIKE 'atproto.%')`;
}

export interface IngestFeed {
  feedUrl: string;
  title?: string | null;
  siteUrl?: string | null;
  description?: string | null;
  imageUrl?: string | null;
}

export interface IngestItem {
  feedUrl: string;
  guid: string;
  item: FeedItem;
  publishedAt?: number | null;
  firstSeenAt: number;
  contentHash: string;
}

/**
 * Timing-safe secret comparison. Fails closed: an unset `FEED_PROXY_SECRET`
 * rejects every request rather than turning the ingest endpoint into an open
 * write surface (local dev sets the pair explicitly — see scripts/dev-local.sh).
 */
export function isAuthorizedProxyRequest(request: Request, env: Env): boolean {
  const expected = env.FEED_PROXY_SECRET;
  if (!expected) return false;
  const provided = request.headers.get('X-Proxy-Secret');
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badRequest(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Apply the stored-content cap. Returns the item to persist: unchanged when it
 * fits, otherwise the same item with `content` dropped and `contentTruncated`
 * set. `content_hash` is computed by the proxy over the FULL item, so truncation
 * never confuses edit detection.
 */
export function capItemContent(item: FeedItem): FeedItem {
  const content = item.content;
  if (!content) return item;
  // Byte length, not code units — the cap is about stored bytes.
  const bytes = new TextEncoder().encode(content).length;
  if (bytes <= MAX_ITEM_CONTENT_BYTES) return item;
  const { content: _dropped, ...rest } = item;
  return { ...rest, contentTruncated: true };
}

/**
 * Stable hash of an item's mutable content — byte-for-byte the same function the
 * proxy applies before pushing (`itemContentHash` in feed-proxy/src/app.ts), so
 * an item ingested by the subscribe-time pull-through and later pushed by the
 * crawler hashes identically and doesn't register as a spurious edit.
 */
export async function computeContentHash(item: FeedItem): Promise<string> {
  const payload = `${item.title}|${item.url}|${item.content ?? ''}|${item.summary ?? ''}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * The write itself, shared by the pushed-batch endpoint and the subscribe-time
 * pull-through in feeds-v2.ts. Idempotent: a re-pushed item with the same content
 * hash is a no-op, a changed one updates in place (seq unchanged → not
 * re-delivered to clients that already saw it). That makes the proxy's
 * at-least-once delivery safe.
 *
 * Throws on a D1 write failure so callers can surface a 5xx (which leaves the
 * pusher's outbox state untouched, so it retries).
 */
export async function ingestBatch(
  env: Env,
  feeds: IngestFeed[],
  items: IngestItem[]
): Promise<{ inserted: number; updated: number }> {
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];

  for (const feed of feeds) {
    if (!feed?.feedUrl) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO feeds (feed_url, title, site_url, description, image_url, last_ingest_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(feed_url) DO UPDATE SET
           title          = COALESCE(excluded.title, feeds.title),
           site_url       = COALESCE(excluded.site_url, feeds.site_url),
           description    = COALESCE(excluded.description, feeds.description),
           image_url      = COALESCE(excluded.image_url, feeds.image_url),
           last_ingest_at = excluded.last_ingest_at`
      ).bind(
        feed.feedUrl,
        feed.title ?? null,
        feed.siteUrl ?? null,
        feed.description ?? null,
        feed.imageUrl ?? null,
        now
      )
    );
  }

  // Max seq before this batch: everything above it in the RETURNING rows below is
  // a fresh insert, everything at or below is an edit-in-place. Purely for the
  // response's counters — no correctness depends on it.
  const before = await env.DB.prepare('SELECT MAX(seq) AS max_seq FROM feed_items').first<{
    max_seq: number | null;
  }>();
  const maxSeqBefore = before?.max_seq ?? 0;

  const touchedFeeds = new Set<string>();
  for (const entry of items) {
    if (!entry?.feedUrl || !entry.guid || !entry.item || !entry.contentHash) continue;
    touchedFeeds.add(entry.feedUrl);
    statements.push(
      env.DB.prepare(
        `INSERT INTO feed_items (feed_url, guid, item_json, published_at, first_seen_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(feed_url, guid) DO UPDATE SET
           item_json    = excluded.item_json,
           content_hash = excluded.content_hash
         WHERE feed_items.content_hash <> excluded.content_hash
         RETURNING seq`
      ).bind(
        entry.feedUrl,
        entry.guid,
        JSON.stringify(capItemContent(entry.item)),
        entry.publishedAt ?? null,
        entry.firstSeenAt || Date.now(),
        entry.contentHash
      )
    );
  }

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < statements.length; i += INGEST_BATCH_SIZE) {
    const results = await env.DB.batch<{ seq: number }>(statements.slice(i, i + INGEST_BATCH_SIZE));
    for (const result of results) {
      for (const row of result.results ?? []) {
        if (row.seq > maxSeqBefore) inserted++;
        else updated++;
      }
    }
  }

  await trimFeedsToSanityCap(env, [...touchedFeeds]);

  return { inserted, updated };
}

/**
 * The ONLY pruning that happens at ingest. Under the cap the OFFSET subquery
 * yields no row, so `seq <= NULL` matches nothing and the DELETE is a no-op
 * costing a bounded index scan — which is the expected case for every healthy
 * feed. `cap` is a parameter so tests can exercise the trim without writing
 * 5,000 rows.
 */
export async function trimFeedsToSanityCap(
  env: Env,
  feedUrls: string[],
  cap = SANITY_CAP
): Promise<void> {
  if (feedUrls.length === 0) return;
  const trims = feedUrls.map((feedUrl) =>
    env.DB.prepare(
      `DELETE FROM feed_items
         WHERE feed_url = ?1
           AND seq <= (SELECT seq FROM feed_items WHERE feed_url = ?1
                        ORDER BY seq DESC LIMIT 1 OFFSET ?2)`
    ).bind(feedUrl, cap)
  );
  for (let i = 0; i < trims.length; i += INGEST_BATCH_SIZE) {
    await env.DB.batch(trims.slice(i, i + INGEST_BATCH_SIZE));
  }
}

/**
 * Ingest a feed fetched straight from the proxy (the subscribe-time warm/ingest
 * and the pull-through in feeds-v2.ts). Hashes match what the crawler will push
 * later, so the first real push over these rows is a no-op rather than a phantom
 * edit.
 *
 * Order matters: a proxy feed is newest-first, and `seq` is assigned in insert
 * order, so we walk the array BACKWARDS — oldest first — exactly as the proxy's
 * own `writeFeedItems` does. Ingesting forward would give the newest item the
 * lowest seq, and since a re-push of an unchanged item is a no-op, that
 * inversion would never heal: every later per-feed cold start (`ORDER BY seq
 * DESC`) would serve the feed's OLDEST items, and the sanity-cap trim (deletes
 * the lowest seqs) would delete its newest.
 */
export async function ingestProxyFeed(
  env: Env,
  feedUrl: string,
  feed: {
    title?: string;
    description?: string;
    siteUrl?: string;
    imageUrl?: string;
    items: FeedItem[];
  }
): Promise<void> {
  const nowMs = Date.now();
  const oldestFirst = [...feed.items].reverse();
  const items: IngestItem[] = await Promise.all(
    oldestFirst.map(async (item) => {
      const publishedMs = new Date(item.publishedAt).getTime();
      return {
        feedUrl,
        guid: item.guid,
        item,
        publishedAt: Number.isNaN(publishedMs) ? null : publishedMs,
        firstSeenAt: nowMs,
        contentHash: await computeContentHash(item),
      };
    })
  );

  await ingestBatch(
    env,
    [
      {
        feedUrl,
        title: feed.title ?? null,
        siteUrl: feed.siteUrl ?? null,
        description: feed.description ?? null,
        imageUrl: feed.imageUrl ?? null,
      },
    ],
    items
  );
}

/**
 * Record that this environment's crawler just talked to us. Both internal
 * endpoints stamp it, so the signal survives a quiet period with no new items
 * (the crawl-set pull runs every 5 minutes regardless of what the feeds do).
 *
 * This is what makes "is ingest live here?" server-authoritative instead of
 * inferred from an empty archive: a Worker whose proxy has no INGEST_URL never
 * gets a stamp, so `/api/v2/timeline` reports `ingestActive: false` and clients
 * keep using the legacy batch path rather than committing a cursor against an
 * archive nothing is filling.
 */
export async function stampCrawlerHeartbeat(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(CRAWLER_HEARTBEAT_KEY, String(Math.floor(Date.now() / 1000)))
      .run();
  } catch (error) {
    // Observability only — never fail an ingest because the stamp didn't land.
    console.error('[ingest] Failed to stamp crawler heartbeat:', error);
  }
}

/**
 * Per-feed crawl health, as the crawler reports it. Unix SECONDS on this wire
 * (the proxy keeps milliseconds internally and converts on send); the timeline
 * converts back to milliseconds for the client.
 */
export interface FeedHealthReport {
  feedUrl: string;
  errorCount: number;
  lastError?: string | null;
  lastErrorAt?: number | null;
  nextRetryAt?: number | null;
  lastFetchAt?: number | null;
  // In the crawl set but going unfetched — starved, not failing. Independent of
  // `errorCount`, which can be 0 while this is true.
  crawlStale?: boolean;
}

// A report carries only the unhealthy feeds, so this is far above any plausible
// real number — an abuse guard, not a tuning knob.
const MAX_HEALTH_FEEDS = 2000;
// Error strings are rendered in a popover and matched against substrings; the
// crawler's messages are short, so anything longer is a runaway.
const MAX_HEALTH_ERROR_CHARS = 500;
// Feed URLs per recovery statement. Well under D1's per-statement bind limit,
// and the recovered set is normally a handful anyway.
const HEALTH_CLEAR_CHUNK = 50;

/**
 * A cheap fingerprint of the whole unhealthy set, used as the `feed_health_rev`
 * token. Clients echo the revision they last saw and the timeline re-sends the
 * health payload only when it differs, which keeps a steady-state poll at the
 * one query the architecture promises.
 *
 * Aggregates rather than a real hash: the partial index makes this a scan of the
 * handful of broken feeds, not of the archive. Two genuinely different sets can
 * alias only if they share a count, an error-count sum, and both timestamps — and
 * the cost of that is one poll showing yesterday's error, self-healing on the
 * next change.
 */
async function readFeedHealthRev(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(error_count), 0) AS errors,
            COALESCE(MAX(last_error_at), 0) AS newest, COALESCE(MAX(next_retry_at), 0) AS retry
       FROM feeds WHERE error_count > 0`
  ).first<{ n: number; errors: number; newest: number; retry: number }>();
  return `${row?.n ?? 0}:${row?.errors ?? 0}:${row?.newest ?? 0}:${row?.retry ?? 0}`;
}

/**
 * Clear one feed's error state because we just fetched it successfully.
 *
 * The pull-through in `/api/v2/feeds/fetch` is the user's explicit "retry this
 * feed" action, and it is proof the feed works — but the crawler's next health
 * report is up to five minutes away, so without this the reader would keep
 * showing the error the user just cleared. Refreshes the revision so every other
 * client picks the recovery up too.
 */
export async function clearFeedHealth(env: Env, feedUrl: string): Promise<void> {
  try {
    const result = await env.DB.prepare(
      `UPDATE feeds
          SET error_count = 0, last_error = NULL, last_error_at = NULL, next_retry_at = NULL,
              crawl_stale = 0, last_fetch_at = ?
        WHERE feed_url = ? AND (error_count > 0 OR crawl_stale = 1)`
    )
      .bind(Math.floor(Date.now() / 1000), feedUrl)
      .run();
    if (!result.meta?.changes) return;

    await env.DB.prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(FEED_HEALTH_REV_KEY, await readFeedHealthRev(env))
      .run();
  } catch (error) {
    // Health is observability, not the read itself — never fail a fetch over it.
    console.error('[ingest] Failed to clear feed health:', error);
  }
}

/**
 * POST /api/internal/feed-health
 *
 * The crawler's periodic report of every feed it currently considers broken.
 *
 * This is the timeline path's replacement for what the legacy batch response
 * carried inline: on `/api/v2/feeds/batch` a failing feed came back with
 * `status: 'error'` plus its error, count and retry time, which is what fed the
 * reader's per-feed error badge and popover. Reads no longer touch the proxy, and
 * a feed that fails to crawl pushes no items, so without this a broken feed is
 * indistinguishable from a quiet one and the user gets no signal at all.
 *
 * The payload is the COMPLETE unhealthy set, not a delta: recovery is inferred
 * from absence (see the sweep below), so a feed that starts working again clears
 * without the crawler having to say anything about it.
 */
export async function handleFeedHealth(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return badRequest('Method not allowed', 405);
  if (!isAuthorizedProxyRequest(request, env)) return unauthorized();

  const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
  if (declaredLength > MAX_INGEST_BODY_BYTES) return badRequest('Payload too large', 413);

  let body: { feeds?: FeedHealthReport[] };
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  // A report entry means "something is wrong with this feed" — it is erroring,
  // or the crawler isn't reaching it, or both. An entry claiming neither is
  // noise and would keep the feed flagged forever.
  const reports = (Array.isArray(body.feeds) ? body.feeds : []).filter(
    (f) => f?.feedUrl && ((Number.isFinite(f.errorCount) && f.errorCount > 0) || f.crawlStale)
  );
  if (reports.length > MAX_HEALTH_FEEDS) return badRequest('Too many feeds');

  try {
    const before = await readFeedHealthRev(env);

    // Which feeds are flagged right now. Read BEFORE the upserts so the
    // difference against this report is exactly "was in trouble, isn't any more".
    // Small by construction (the partial index covers only flagged feeds), so the
    // chunked IN list below can never approach the bound-parameter limit.
    const flagged = await env.DB.prepare(
      `SELECT feed_url FROM feeds WHERE error_count > 0 OR crawl_stale = 1`
    ).all<{ feed_url: string }>();

    const stillTroubled = new Set(reports.map((r) => r.feedUrl));
    const recovered = flagged.results
      .map((r) => r.feed_url)
      .filter((url) => !stillTroubled.has(url));

    // A feed can be broken from its very first crawl, in which case it has never
    // been ingested and has no `feeds` row at all — so this inserts rather than
    // assuming one exists. Such a row carries health only (NULL title/site_url),
    // which the metadata backfill already skips.
    const upserts = reports.map((report) =>
      env.DB.prepare(
        `INSERT INTO feeds (feed_url, error_count, last_error, last_error_at, next_retry_at,
                            last_fetch_at, crawl_stale)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(feed_url) DO UPDATE SET
           error_count   = excluded.error_count,
           last_error    = excluded.last_error,
           last_error_at = excluded.last_error_at,
           next_retry_at = excluded.next_retry_at,
           last_fetch_at = COALESCE(excluded.last_fetch_at, feeds.last_fetch_at),
           crawl_stale   = excluded.crawl_stale`
      ).bind(
        report.feedUrl,
        Number.isFinite(report.errorCount) ? Math.max(report.errorCount, 0) : 0,
        report.lastError ? report.lastError.slice(0, MAX_HEALTH_ERROR_CHARS) : null,
        report.lastErrorAt ?? null,
        report.nextRetryAt ?? null,
        report.lastFetchAt ?? null,
        report.crawlStale ? 1 : 0
      )
    );
    for (let i = 0; i < upserts.length; i += INGEST_BATCH_SIZE) {
      await env.DB.batch(upserts.slice(i, i + INGEST_BATCH_SIZE));
    }

    // Recovery: a feed the crawler stopped listing is fine again. Absence is the
    // entire signal, which is why the report has to be the complete set.
    // Chunked well under D1's per-statement bind limit — the same limit a
    // subscription-sized IN list walked into once already.
    for (let i = 0; i < recovered.length; i += HEALTH_CLEAR_CHUNK) {
      const chunk = recovered.slice(i, i + HEALTH_CLEAR_CHUNK);
      await env.DB.prepare(
        `UPDATE feeds
            SET error_count = 0, last_error = NULL, last_error_at = NULL, next_retry_at = NULL,
                crawl_stale = 0
          WHERE feed_url IN (${chunk.map(() => '?').join(',')})`
      )
        .bind(...chunk)
        .run();
    }

    const after = await readFeedHealthRev(env);
    if (after !== before) {
      await env.DB.prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
        .bind(FEED_HEALTH_REV_KEY, after)
        .run();
    }

    await stampCrawlerHeartbeat(env);
    return new Response(JSON.stringify({ ok: true, unhealthy: reports.length, rev: after }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ingest] Feed-health write error:', error);
    return new Response(JSON.stringify({ error: 'Feed health update failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/internal/ingest
 *
 * Upsert a batch of feed metadata + items pushed by the crawler. Any 5xx leaves
 * the proxy's outbox state untouched — the idempotent upsert above makes
 * at-least-once delivery safe.
 */
export async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return badRequest('Method not allowed', 405);
  if (!isAuthorizedProxyRequest(request, env)) return unauthorized();

  const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
  if (declaredLength > MAX_INGEST_BODY_BYTES) return badRequest('Payload too large', 413);

  let body: { feeds?: IngestFeed[]; items?: IngestItem[] };
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const feeds = Array.isArray(body.feeds) ? body.feeds : [];
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > MAX_INGEST_ITEMS) return badRequest('Too many items');

  try {
    const { inserted, updated } = await ingestBatch(env, feeds, items);
    await stampCrawlerHeartbeat(env);
    return new Response(JSON.stringify({ ok: true, inserted, updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ingest] D1 WRITE ERROR:', error);
    return new Response(JSON.stringify({ error: 'Ingest failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * GET /api/internal/crawl-set
 *
 * The feeds this environment wants crawled. Replaces the proxy's request-driven
 * warmth: once clients stop reading through Fly, nothing stamps
 * `last_requested_at`, so every feed would silently age out of the warm loop.
 * The proxy polls this and stamps the rows itself.
 */
export async function handleCrawlSet(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return badRequest('Method not allowed', 405);
  if (!isAuthorizedProxyRequest(request, env)) return unauthorized();

  // The crawl-set pull is the crawler's liveness signal (it runs every 5 minutes
  // whether or not any feed produced an item).
  await stampCrawlerHeartbeat(env);

  const rows = await env.DB.prepare(
    `SELECT feed_url, COUNT(*) AS subscribers
       FROM subscriptions_cache
      WHERE active = 1
        AND feed_url IS NOT NULL AND feed_url <> ''
        AND ${rssSubscriptionPredicate()}
      GROUP BY feed_url`
  ).all<{ feed_url: string; subscribers: number }>();

  const feeds = rows.results.map((row) => ({
    feedUrl: row.feed_url,
    subscribers: row.subscribers,
  }));

  return new Response(JSON.stringify({ feeds, count: feeds.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
