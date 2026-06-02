import { listUsers } from '$lib/queries/users';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, url }) => {
  const db = platform!.env.DB;
  const search = url.searchParams.get('search') ?? undefined;
  const sort = url.searchParams.get('sort') ?? undefined;
  const order = (url.searchParams.get('order') as 'asc' | 'desc') ?? undefined;
  const page = parseInt(url.searchParams.get('page') ?? '1', 10);

  const result = await listUsers(db, { search, sort, order, page });
  return {
    ...result,
    search: search ?? '',
    currentSort: sort ?? 'registered_at',
    currentOrder: order ?? 'desc',
  };
};
