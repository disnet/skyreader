import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { createApp, initDatabase, cleanupCache } from './app';
import { DocumentFirehose } from './jetstream';

// Config
const PROXY_SECRET = process.env.PROXY_SECRET;
const DATA_DIR = process.env.DATA_DIR || './data';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '900', 10) * 1000; // 15 min default
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_SECONDS || '3600', 10) * 1000; // 1 hour default
const DEFAULT_LIMIT = 100;

// Self-warming loop: proactively refresh active feeds before they go stale so
// user requests are (nearly) always cache hits instead of blocking on upstream.
const WARM_ENABLED = (process.env.WARM_ENABLED ?? 'true') !== 'false';
const WARM_INTERVAL_MS = parseInt(process.env.WARM_INTERVAL_SECONDS || '60', 10) * 1000;
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

// /extract is the heaviest request (fetch + Defuddle DOM build). Cap concurrent
// extractions so a burst of distinct heavy articles can't OOM the 512MB machine;
// excess callers queue, then are shed with a 503 once the queue fills.
const EXTRACT_CONCURRENCY = parseInt(process.env.EXTRACT_CONCURRENCY || '4', 10);
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
  extractConcurrency: EXTRACT_CONCURRENCY,
  extractQueueMax: EXTRACT_QUEUE_MAX,
  getFirehoseStatus: () => firehose?.status() ?? { healthy: false, isSubscribed: () => false },
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
      })
      .catch((err) => console.error('[Proxy] Warmer error:', err))
      .finally(() => {
        warmRunning = false;
      });
  }, WARM_INTERVAL_MS);
} else {
  console.log('[Proxy] Warmer: disabled');
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
