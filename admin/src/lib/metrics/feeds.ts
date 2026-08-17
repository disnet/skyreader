import type { FeedRow, MetricDefinition } from '$lib/types';

export interface FeedHealthVerdict {
  status: 'healthy' | 'warning' | 'error';
  label: string;
}

/**
 * How one feed's row reads on the Feeds page.
 *
 * The crawler's verdict, not an inference. Health used to be derived from
 * `last_ingest_at`, which only moves when a fetch produces a NEW item — so every
 * feed that simply hadn't published in an hour showed as broken, and the page's
 * status column carried no information. The two faults are also genuinely
 * different: erroring means the fetch fails (actionable per feed), starved means
 * the crawler never gets to it (actionable on capacity), so they don't collapse
 * into one severity.
 */
export function feedHealth(feed: Pick<FeedRow, 'error_count' | 'crawl_stale'>): FeedHealthVerdict {
  if (feed.error_count > 0) return { status: 'error', label: 'Erroring' };
  if (feed.crawl_stale) return { status: 'warning', label: 'Not crawled' };
  return { status: 'healthy', label: 'OK' };
}

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
    id: 'erroring_feeds',
    category: 'Feeds',
    // Feeds a real user subscribes to that the crawler cannot fetch. This
    // replaces the old "Subscribed Feeds Not Ingesting", which keyed off
    // `last_ingest_at` and therefore counted every feed that simply hadn't
    // published in an hour — it warned permanently and told an operator nothing.
    // The crawler's own error verdict is the actionable number.
    query: async (db) => {
      const r = await db
        .prepare(
          `SELECT COUNT(*) as count FROM feeds f
            WHERE f.error_count > 0
              AND EXISTS (SELECT 1 FROM subscriptions_cache sc
                           WHERE sc.feed_url = f.feed_url AND sc.active = 1)`
        )
        .first<{ count: number }>();
      const count = r?.count ?? 0;
      return {
        label: 'Subscribed Feeds Erroring',
        value: count,
        status: count > 0 ? 'warning' : 'healthy',
      };
    },
  },
  {
    id: 'starved_feeds',
    category: 'Feeds',
    // In the crawl set, not erroring, and still not fetched for hours: the
    // crawler is not keeping up. This is the failure the warm-loop batch cap
    // produces, and the one the old stale-ingest metric was reaching for.
    query: async (db) => {
      const r = await db
        .prepare(
          `SELECT COUNT(*) as count FROM feeds f
            WHERE f.crawl_stale = 1 AND f.error_count = 0
              AND EXISTS (SELECT 1 FROM subscriptions_cache sc
                           WHERE sc.feed_url = f.feed_url AND sc.active = 1)`
        )
        .first<{ count: number }>();
      const count = r?.count ?? 0;
      return {
        label: 'Subscribed Feeds Not Being Crawled',
        value: count,
        status: count > 0 ? 'error' : 'healthy',
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
