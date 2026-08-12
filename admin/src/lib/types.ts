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
}

export interface FeedRow {
  feed_url: string;
  title: string | null;
  site_url: string | null;
  subscriber_count: number;
  // Rows this feed holds in the D1 archive.
  item_count: number;
  // Unix seconds of the last push we received from the crawler for this feed.
  last_ingest_at: number | null;
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
