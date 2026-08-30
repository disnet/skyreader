// Must be first: initializes Sentry before any other module loads so its global
// error handlers and instrumentation are in place when the app boots.
import { reportError } from './instrument';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { createApp, initDatabase, cleanupCache } from './app';
import { DocumentFirehose } from './jetstream';
import { pingHeartbeat } from './heartbeat';
import {
  pushDirtyItems,
  pullCrawlSet,
  reportFeedHealth,
  createPushLoop,
  type IngestConfig,
} from './ingest-push';

// Config
const PROXY_SECRET = process.env.PROXY_SECRET;

// Fail closed: every route's auth check is `if (proxySecret && header !== secret)`,
// so a missing secret silently disables auth and turns this into an open SSRF /
// extraction proxy. In production (Fly sets FLY_APP_NAME) refuse to start without it
// rather than booting wide open; locally/CI it's an intentional, loud-warned no-op.
if (!PROXY_SECRET) {
  if (process.env.FLY_APP_NAME) {
    console.error(
      '[Proxy] FATAL: PROXY_SECRET is not set in production. Refusing to start to avoid running as an open proxy.'
    );
    process.exit(1);
  }
  console.warn(
    '[Proxy] WARNING: PROXY_SECRET not set — request authentication is DISABLED (local/dev only).'
  );
}

const DATA_DIR = process.env.DATA_DIR || './data';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '900', 10) * 1000; // 15 min default
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_SECONDS || '3600', 10) * 1000; // 1 hour default
const DEFAULT_LIMIT = 100;

// Self-warming loop: proactively refresh active feeds before they go stale so
// user requests are (nearly) always cache hits instead of blocking on upstream.
const WARM_ENABLED = (process.env.WARM_ENABLED ?? 'true') !== 'false';
const WARM_INTERVAL_MS = parseInt(process.env.WARM_INTERVAL_SECONDS || '60', 10) * 1000;
// Crawl cycle we accept before the warmer says something. See AppConfig — this is
// a warning threshold, not a goal the warmer chases. Unset uses the app default
// (1h, half of CRAWL_STALE_MS).
const WARM_TARGET_CYCLE_MS = process.env.WARM_TARGET_CYCLE_SECONDS
  ? parseInt(process.env.WARM_TARGET_CYCLE_SECONDS, 10) * 1000
  : undefined;
// Refresh feeds older than this. Default leaves a margin below cacheTtl so a feed
// is refreshed (worst case ~threshold + interval old) before it ever expires.
const WARM_REFRESH_THRESHOLD_MS = process.env.WARM_REFRESH_THRESHOLD_SECONDS
  ? parseInt(process.env.WARM_REFRESH_THRESHOLD_SECONDS, 10) * 1000
  : Math.max(CACHE_TTL_MS - 2 * WARM_INTERVAL_MS, Math.floor(CACHE_TTL_MS / 2));
const WARM_ACTIVE_WINDOW_MS =
  parseInt(process.env.WARM_ACTIVE_WINDOW_SECONDS || String(14 * 24 * 60 * 60), 10) * 1000;
const WARM_BATCH_CAP = parseInt(process.env.WARM_BATCH_CAP || '200', 10);
const WARM_CONCURRENCY = parseInt(process.env.WARM_CONCURRENCY || '8', 10);
// Pre-warm Phase 5 article mention counts as feeds are warmed (extra
// Constellation load); on by default in production, disable with WARM_MENTIONS=false.
const WARM_MENTIONS_ENABLED = (process.env.WARM_MENTIONS ?? 'true') !== 'false';
// Dead-man's switch for the warm loop (Healthchecks.io / Better Stack). Unset in
// local dev, so the ping is a no-op there.
const WARM_HEARTBEAT_URL = process.env.WARM_HEARTBEAT_URL;

// This proxy crawls for one Worker/D1 pair. Leaving INGEST_URL unset disables
// both directions, which keeps local development and staged rollout safe.
const INGEST_URL = process.env.INGEST_URL?.replace(/\/$/, '') || '';
const INGEST_ENABLED = INGEST_URL.length > 0;
const INGEST_INTERVAL_MS = parseInt(process.env.INGEST_INTERVAL_SECONDS || '15', 10) * 1000;
// Gap between back-to-back pushes while draining a backlog (see runPush). Small
// on purpose — the work per push is already bounded by INGEST_BATCH_SIZE, so this
// is the dial for how hard the drain leans on the paired Worker's D1, which is
// the SHARED production database. Raise it if ingest writes start showing up in
// user-facing latency.
const INGEST_CHAIN_DELAY_MS = parseInt(process.env.INGEST_CHAIN_DELAY_MS || '1000', 10);
const INGEST_BATCH_SIZE = parseInt(process.env.INGEST_BATCH_SIZE || '100', 10);
const CRAWL_SET_INTERVAL_MS = parseInt(process.env.CRAWL_SET_INTERVAL_SECONDS || '300', 10) * 1000;
const PUSH_BACKOFF_BASE_MS = 30 * 1000;
const PUSH_BACKOFF_MAX_MS = 10 * 60 * 1000;

function pushBackoff(failures: number): number {
  return Math.min(PUSH_BACKOFF_BASE_MS * 2 ** (failures - 1), PUSH_BACKOFF_MAX_MS);
}

// /extract is the heaviest request (fetch + Defuddle DOM build). Cap concurrent
// extractions so a burst of distinct heavy articles can't OOM the 512MB machine;
// excess callers queue, then are shed with a 503 once the queue fills.
const EXTRACT_CONCURRENCY = parseInt(process.env.EXTRACT_CONCURRENCY || '4', 10);
// Governor on demand-driven feed fetches. UNSET = unbounded (historical
// behaviour), so shipping this changes nothing until it is deliberately set.
// Watch `feedFetch`/`inFlight` on /stats to decide. See AppConfig.
const FEED_FETCH_CONCURRENCY = process.env.FEED_FETCH_CONCURRENCY
  ? parseInt(process.env.FEED_FETCH_CONCURRENCY, 10)
  : undefined;
const FEED_FETCH_QUEUE_MAX = process.env.FEED_FETCH_QUEUE_MAX
  ? parseInt(process.env.FEED_FETCH_QUEUE_MAX, 10)
  : undefined;
const EXTRACT_QUEUE_MAX = parseInt(process.env.EXTRACT_QUEUE_MAX || '20', 10);

// Jetstream document firehose: keeps standard.site documents fresh via the AT
// Proto firehose (push) instead of re-listing every active author (pull). The
// pull path stays for cold-start backfill and as the firehose-down fallback.
const JETSTREAM_ENABLED = (process.env.JETSTREAM_ENABLED ?? 'true') !== 'false';
const JETSTREAM_URL = process.env.JETSTREAM_URL || undefined;
const JETSTREAM_RECONCILE_MS = parseInt(process.env.JETSTREAM_RECONCILE_SECONDS || '60', 10) * 1000;

// Ensure data directory exists
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // May already exist
}

// Database setup
const db = new Database(`${DATA_DIR}/cache.db`);
initDatabase(db);

console.log(`[Proxy] Initialized database at ${DATA_DIR}/cache.db`);
console.log(`[Proxy] TTL: ${CACHE_TTL_MS / 1000}s fresh, ${STALE_TTL_MS / 1000}s stale`);

// The document firehose is created just below, but createApp's serve path needs
// its status now — close over the binding so the accessor reads it lazily.
let firehose: DocumentFirehose | null = null;

// Create app
const { app, warmStaleFeeds, warmStaleDocuments } = createApp(db, {
  proxySecret: PROXY_SECRET,
  cacheTtlMs: CACHE_TTL_MS,
  staleTtlMs: STALE_TTL_MS,
  defaultLimit: DEFAULT_LIMIT,
  warmRefreshThresholdMs: WARM_REFRESH_THRESHOLD_MS,
  warmActiveWindowMs: WARM_ACTIVE_WINDOW_MS,
  warmBatchCap: WARM_BATCH_CAP,
  warmConcurrency: WARM_CONCURRENCY,
  warmMentionsEnabled: WARM_MENTIONS_ENABLED,
  warmIntervalMs: WARM_INTERVAL_MS,
  warmTargetCycleMs: WARM_TARGET_CYCLE_MS,
  extractConcurrency: EXTRACT_CONCURRENCY,
  extractQueueMax: EXTRACT_QUEUE_MAX,
  feedFetchConcurrency: FEED_FETCH_CONCURRENCY,
  feedFetchQueueMax: FEED_FETCH_QUEUE_MAX,
  getFirehoseStatus: () =>
    firehose?.status() ?? {
      healthy: false,
      connected: false,
      subscribedDids: 0,
      lastEventAt: null,
      reconnectAttempts: 0,
      cursor: null,
      isSubscribed: () => false,
    },
  ingestEnabled: INGEST_ENABLED,
});

// Document firehose: push-based freshness for standard.site documents.
firehose = new DocumentFirehose(db, {
  enabled: JETSTREAM_ENABLED,
  url: JETSTREAM_URL,
  reconcileMs: JETSTREAM_RECONCILE_MS,
  activeWindowMs: WARM_ACTIVE_WINDOW_MS,
});
firehose.start();

// Run cleanup on startup and every hour
const initialCleanup = cleanupCache(db);
if (initialCleanup > 0) {
  console.log(`[Proxy] Cleaned up ${initialCleanup} old entries`);
}
setInterval(
  () => {
    const cleaned = cleanupCache(db);
    if (cleaned > 0) {
      console.log(`[Proxy] Cleaned up ${cleaned} old entries`);
    }
  },
  60 * 60 * 1000
);

// Self-warming loop: keep the active working set fresh ahead of demand.
if (WARM_ENABLED) {
  console.log(
    `[Proxy] Warmer: every ${WARM_INTERVAL_MS / 1000}s, refresh feeds older than ` +
      `${WARM_REFRESH_THRESHOLD_MS / 1000}s, active window ${WARM_ACTIVE_WINDOW_MS / 1000}s, ` +
      `cap ${WARM_BATCH_CAP}, concurrency ${WARM_CONCURRENCY}`
  );
  let warmRunning = false;
  setInterval(() => {
    // Skip if the previous tick is still draining (slow upstreams) to avoid pile-up.
    if (warmRunning) return;
    warmRunning = true;
    // Documents are kept fresh by the Jetstream firehose; only fall back to the
    // pull-based re-list when the firehose is down (RSS always warms via pull).
    const warmDocs = firehose?.isHealthy() ? Promise.resolve(0) : warmStaleDocuments();
    Promise.all([warmStaleFeeds(), warmDocs])
      .then(([feeds, docs]) => {
        if (feeds > 0) console.log(`[Proxy] Warmer refreshed ${feeds} feed(s)`);
        if (docs > 0) console.log(`[Proxy] Warmer refreshed ${docs} author document set(s)`);
        // Dead-man's switch: only a tick that completed pings. A warmer that
        // wedges without throwing produces no Sentry event and no error log —
        // the missing heartbeat is the only thing that would ever notice.
        void pingHeartbeat(WARM_HEARTBEAT_URL, 'warmer');
      })
      .catch((err) => {
        console.error('[Proxy] Warmer error:', err);
        reportError(err, { tags: { source: 'warmer' } });
      })
      .finally(() => {
        warmRunning = false;
      });
  }, WARM_INTERVAL_MS);
} else {
  console.log('[Proxy] Warmer: disabled');
}

// Push the durable item log into D1 and pull the registered crawl set back.
if (INGEST_ENABLED) {
  const ingestConfig: IngestConfig = {
    ingestUrl: INGEST_URL,
    secret: PROXY_SECRET,
    batchSize: INGEST_BATCH_SIZE,
  };
  // Drain chaining, failure backoff, and the re-entrancy guard live in
  // createPushLoop (ingest-push.ts), where they are unit-tested; this wires in
  // the real clock, timer, pusher, and Sentry.
  const runPush = createPushLoop({
    push: () => pushDirtyItems(db, ingestConfig),
    chainDelayMs: INGEST_CHAIN_DELAY_MS,
    backoff: pushBackoff,
    schedule: (fn, delayMs) => setTimeout(fn, delayMs),
    now: Date.now,
    onError: (error) => reportError(error, { tags: { source: 'ingest-push' } }),
  });
  setInterval(runPush, INGEST_INTERVAL_MS);

  let crawlSetRunning = false;
  const refreshCrawlSet = () => {
    if (crawlSetRunning) return;
    crawlSetRunning = true;
    pullCrawlSet(db, ingestConfig)
      .then((result) => {
        if (result.error) console.error(`[Proxy] Crawl-set pull failed: ${result.error}`);
        else console.log(`[Proxy] Crawl set: ${result.registered} feed(s) registered`);
        // Report health AFTER the pull, so a feed registered for the first time
        // this cycle is already in the crawl set and its errors are reportable.
        // Reads no longer pass through here, so this is the only way a broken
        // feed reaches the reader's error badge.
        return reportFeedHealth(db, ingestConfig).then((health) => {
          if (health.error) console.error(`[Proxy] Feed-health report failed: ${health.error}`);
          else console.log(`[Proxy] Feed health: ${health.reported} feed(s) in error`);
        });
      })
      .catch((error) => {
        console.error('[Proxy] Crawl-set pull error:', error);
        reportError(error, { tags: { source: 'crawl-set' } });
      })
      .finally(() => {
        crawlSetRunning = false;
      });
  };
  refreshCrawlSet();
  setInterval(refreshCrawlSet, CRAWL_SET_INTERVAL_MS);
} else {
  console.log('[Proxy] Ingest push: disabled (INGEST_URL unset)');
}

// Flush the firehose cursor + close its socket cleanly on shutdown so we resume
// where we left off instead of replaying.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    firehose?.stop();
    process.exit(0);
  });
}

const port = parseInt(process.env.PORT || '3000', 10);
console.log(`[Proxy] Starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
