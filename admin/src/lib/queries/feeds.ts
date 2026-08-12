import type { FeedRow, PaginatedResult } from '$lib/types';

// Matches the dashboard's stale-ingest metric: a subscribed feed that hasn't
// been ingested within an hour isn't being crawled.
const STALE_INGEST_SECONDS = 60 * 60;

/**
 * Feed health from the D1 archive. Fetch errors and backoff now live with the
 * crawler (the Fly proxy), so "healthy" here means "still ingesting": the last
 * push we received for the feed is recent.
 */
export async function listFeeds(
  db: D1Database,
  opts: {
    filter?: 'all' | 'healthy' | 'stale';
    sort?: string;
    order?: 'asc' | 'desc';
    page?: number;
    perPage?: number;
  } = {}
): Promise<PaginatedResult<FeedRow>> {
  const {
    filter = 'all',
    sort = 'subscriber_count',
    order = 'desc',
    page = 1,
    perPage = 50,
  } = opts;
  const offset = (page - 1) * perPage;

  const allowedSorts = ['feed_url', 'title', 'subscriber_count', 'item_count', 'last_ingest_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'subscriber_count';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  const cutoff = Math.floor(Date.now() / 1000) - STALE_INGEST_SECONDS;
  let where = '';
  if (filter === 'healthy') where = 'WHERE f.last_ingest_at IS NOT NULL AND f.last_ingest_at >= ?';
  else if (filter === 'stale') where = 'WHERE f.last_ingest_at IS NULL OR f.last_ingest_at < ?';
  const filterBindings = filter === 'all' ? [] : [cutoff];

  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM feeds f ${where}`)
    .bind(...filterBindings)
    .first<{ count: number }>();

  const rows = await db
    .prepare(
      `SELECT f.feed_url, f.title, f.site_url, f.last_ingest_at,
			        (SELECT COUNT(*) FROM subscriptions_cache sc
			          WHERE sc.feed_url = f.feed_url AND sc.active = 1) AS subscriber_count,
			        (SELECT COUNT(*) FROM feed_items fi
			          WHERE fi.feed_url = f.feed_url) AS item_count
			   FROM feeds f
			   ${where}
			  ORDER BY ${sortCol} ${sortDir}
			  LIMIT ? OFFSET ?`
    )
    .bind(...filterBindings, perPage, offset)
    .all<FeedRow>();

  return {
    rows: rows.results,
    total: countResult?.count ?? 0,
    page,
    perPage,
  };
}
