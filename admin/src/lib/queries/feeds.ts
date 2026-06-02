import type { FeedRow, PaginatedResult } from '$lib/types';

export async function listFeeds(
  db: D1Database,
  opts: {
    filter?: 'all' | 'healthy' | 'erroring';
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

  const allowedSorts = ['feed_url', 'title', 'subscriber_count', 'error_count', 'last_fetched_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'subscriber_count';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  let where = '';
  if (filter === 'healthy') where = 'WHERE error_count = 0';
  else if (filter === 'erroring') where = 'WHERE error_count > 0';

  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM feed_metadata ${where}`)
    .first<{ count: number }>();

  const rows = await db
    .prepare(
      `SELECT feed_url, title, site_url, subscriber_count, error_count, fetch_error, last_fetched_at
			FROM feed_metadata
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
