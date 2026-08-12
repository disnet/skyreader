import type { MetricDefinition } from '$lib/types';

// A subscribed feed whose last ingest is older than this isn't being crawled any
// more — the headline failure mode of the ingest architecture (nothing stamps
// the crawl set, so feeds silently age out of the proxy's warm loop). The warm
// loop refreshes on the order of minutes, so an hour is a real alarm, not noise.
const STALE_INGEST_SECONDS = 60 * 60;

// D1's hard ceiling is 10 GB. Alert well before it, so there's time to act
// (lower the ingest content cap → tier old bodies to R2 → revisit retention).
const ARCHIVE_ALERT_BYTES = 6 * 1024 * 1024 * 1024;

// The per-feed sanity cap is 5,000 items (backend/src/routes/ingest.ts). A feed
// approaching it is a GUID-churn bug signal, not steady state.
const CHURN_WARN_ITEMS = 3000;

export const feedMetrics: MetricDefinition[] = [
  {
    id: 'total_feeds',
    category: 'Feeds',
    query: async (db) => {
      const r = await db.prepare('SELECT COUNT(*) as count FROM feeds').first<{ count: number }>();
      return { label: 'Crawled Feeds', value: r?.count ?? 0 };
    },
  },
  {
    id: 'stale_ingest_feeds',
    category: 'Feeds',
    query: async (db) => {
      const cutoff = Math.floor(Date.now() / 1000) - STALE_INGEST_SECONDS;
      const r = await db
        .prepare(
          `SELECT COUNT(*) as count FROM feeds f
            WHERE (f.last_ingest_at IS NULL OR f.last_ingest_at < ?)
              AND EXISTS (SELECT 1 FROM subscriptions_cache sc
                           WHERE sc.feed_url = f.feed_url AND sc.active = 1)`
        )
        .bind(cutoff)
        .first<{ count: number }>();
      const count = r?.count ?? 0;
      return {
        label: 'Subscribed Feeds Not Ingesting',
        value: count,
        status: count > 0 ? 'warning' : 'healthy',
      };
    },
  },
  {
    id: 'archive_items',
    category: 'Feeds',
    query: async (db) => {
      const r = await db
        .prepare('SELECT COUNT(*) as count FROM feed_items')
        .first<{ count: number }>();
      return { label: 'Archived Items', value: r?.count ?? 0 };
    },
  },
  {
    id: 'archive_size',
    category: 'Feeds',
    query: async (db) => {
      // Estimated, not exact: summing LENGTH(item_json) across the whole archive
      // is a full scan that only grows. Average the newest 1,000 rows (written
      // under the current content cap) and multiply by the row count.
      const [countRow, avgRow] = await Promise.all([
        db.prepare('SELECT COUNT(*) as count FROM feed_items').first<{ count: number }>(),
        db
          .prepare(
            `SELECT AVG(LENGTH(item_json)) as avg
               FROM (SELECT item_json FROM feed_items ORDER BY seq DESC LIMIT 1000)`
          )
          .first<{ avg: number | null }>(),
      ]);
      const bytes = Math.round((countRow?.count ?? 0) * (avgRow?.avg ?? 0));
      return {
        label: 'Archive Size (est.)',
        value: (bytes / (1024 * 1024 * 1024)).toFixed(2),
        unit: 'GB',
        status: bytes > ARCHIVE_ALERT_BYTES ? 'warning' : 'healthy',
      };
    },
  },
  {
    id: 'churn_feeds',
    category: 'Feeds',
    query: async (db) => {
      const r = await db
        .prepare(
          `SELECT COUNT(*) as count FROM (
             SELECT feed_url FROM feed_items GROUP BY feed_url HAVING COUNT(*) > ?
           )`
        )
        .bind(CHURN_WARN_ITEMS)
        .first<{ count: number }>();
      const count = r?.count ?? 0;
      return {
        label: 'Feeds Near Sanity Cap',
        value: count,
        status: count > 0 ? 'warning' : 'healthy',
      };
    },
  },
  {
    id: 'avg_subscribers',
    category: 'Feeds',
    query: async (db) => {
      const r = await db
        .prepare(
          `SELECT ROUND(AVG(subs), 1) as avg FROM (
             SELECT COUNT(*) as subs FROM subscriptions_cache
              WHERE active = 1 GROUP BY feed_url
           )`
        )
        .first<{ avg: number }>();
      return { label: 'Avg Subscribers/Feed', value: r?.avg ?? 0 };
    },
  },
];
