import { listFeeds, type FeedFilter } from '$lib/queries/feeds';
import type { PageServerLoad } from './$types';

const FILTERS: FeedFilter[] = ['all', 'erroring', 'starved', 'ok'];

export const load: PageServerLoad = async ({ platform, url }) => {
  const db = platform!.env.DB;
  const requested = url.searchParams.get('filter') as FeedFilter | null;
  const filter: FeedFilter = requested && FILTERS.includes(requested) ? requested : 'all';
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
