import { error } from '@sveltejs/kit';
import { getUser, getUserSubscriptions } from '$lib/queries/users';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, params }) => {
  const db = platform!.env.DB;
  const did = decodeURIComponent(params.did);

  const user = await getUser(db, did);
  if (!user) throw error(404, 'User not found');

  const subscriptions = await getUserSubscriptions(db, did);

  return { user, subscriptions };
};
