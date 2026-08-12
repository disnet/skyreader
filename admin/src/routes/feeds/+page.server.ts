import { listFeeds } from '$lib/queries/feeds';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, url }) => {
  const db = platform!.env.DB;
  const filter = (url.searchParams.get('filter') as 'all' | 'healthy' | 'stale') ?? 'all';
  const sort = url.searchParams.get('sort') ?? undefined;
  const order = (url.searchParams.get('order') as 'asc' | 'desc') ?? undefined;
  const page = parseInt(url.searchParams.get('page') ?? '1', 10);

  const result = await listFeeds(db, { filter, sort, order, page });
  return {
    ...result,
    currentFilter: filter,
    currentSort: sort ?? 'subscriber_count',
    currentOrder: order ?? 'desc',
  };
};
