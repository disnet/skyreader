import type { FeedRow, PaginatedResult } from '$lib/types';

export type FeedFilter = 'all' | 'erroring' | 'starved' | 'ok';

/**
 * Feed health from the D1 archive.
 *
 * The crawler reports which feeds it can't fetch (`error_count`) and which it
 * isn't reaching at all (`crawl_stale`), so health is now the crawler's own
 * verdict rather than an inference. It used to be inferred from `last_ingest_at`,
 * which only moves when a fetch yields a NEW item — that flagged every
 * low-frequency feed in the archive as broken, so the page's alarm meant nothing.
 * `last_ingest_at` stays on the table as what it actually is: publishing cadence.
 */
export async function listFeeds(
  db: D1Database,
  opts: {
    filter?: FeedFilter;
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

  const allowedSorts = [
    'feed_url',
    'title',
    'subscriber_count',
    'item_count',
    'last_ingest_at',
    'error_count',
  ];
  const sortCol = allowedSorts.includes(sort) ? sort : 'subscriber_count';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  let where = '';
  if (filter === 'erroring') where = 'WHERE f.error_count > 0';
  else if (filter === 'starved') where = 'WHERE f.crawl_stale = 1 AND f.error_count = 0';
  else if (filter === 'ok') where = 'WHERE f.error_count = 0 AND f.crawl_stale = 0';

  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM feeds f ${where}`)
    .first<{ count: number }>();

  const rows = await db
    .prepare(
      `SELECT f.feed_url, f.title, f.site_url, f.last_ingest_at,
			        f.error_count, f.last_error, f.last_error_at, f.next_retry_at,
			        f.last_fetch_at, f.crawl_stale,
			        (SELECT COUNT(*) FROM subscriptions_cache sc
			          WHERE sc.feed_url = f.feed_url AND sc.active = 1) AS subscriber_count,
			        (SELECT COUNT(*) FROM feed_items fi
			          WHERE fi.feed_url = f.feed_url) AS item_count
			   FROM feeds f
			   ${where}
			  ORDER BY ${sortCol} ${sortDir}
			  LIMIT ? OFFSET ?`
    )
    .bind(perPage, offset)
    .all<FeedRow>();

  return {
    rows: rows.results,
    total: countResult?.count ?? 0,
    page,
    perPage,
  };
}
