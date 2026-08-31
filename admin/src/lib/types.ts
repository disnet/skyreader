export interface MetricValue {
  label: string;
  value: number | string;
  unit?: string;
  status?: 'healthy' | 'warning' | 'error';
}

export interface MetricDefinition {
  id: string;
  category: string;
  query: (db: D1Database) => Promise<MetricValue>;
}

export interface UserRow {
  did: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  pds_url: string;
  last_active_at: number | null;
  registered_at: number | null;
  created_at: number;
  subscription_count?: number;
  tier: string;
  /** Who last set `tier`: 'admin', 'polar_order', 'polar_subscription', or null (legacy grant). */
  tier_source?: string | null;
  /** Tier the user keeps for free regardless of Polar (migration 0075). */
  granted_tier?: string | null;
}

export interface FeedRow {
  feed_url: string;
  title: string | null;
  site_url: string | null;
  subscriber_count: number;
  // Rows this feed holds in the D1 archive.
  item_count: number;
  // Unix seconds of the last push we received from the crawler for this feed.
  // Moves only when a fetch produced a NEW item, so it measures the feed's
  // publishing cadence, not its health — most healthy feeds sit here for weeks.
  last_ingest_at: number | null;
  // The crawler's verdict, reported every 5 minutes (see
  // `POST /api/internal/feed-health`). Consecutive fetch failures; 0 = fetching
  // fine.
  error_count: number;
  last_error: string | null;
  // Unix seconds.
  last_error_at: number | null;
  next_retry_at: number | null;
  // Unix seconds of the crawler's last successful FETCH — the actual liveness
  // signal, unlike `last_ingest_at`. Only written for feeds in a health report,
  // so a healthy feed leaves it null.
  last_fetch_at: number | null;
  // 1 when the feed is in the crawl set but going unfetched — starved by a
  // saturated warm loop rather than failing. The real "not being crawled" alarm.
  crawl_stale: number;
}

export interface SubscriptionRow {
  feed_url: string;
  title: string | null;
  source: string | null;
  created_at: number;
}

export interface PaginatedResult<T> {
  rows: T[];
  total: number;
  page: number;
  perPage: number;
}
