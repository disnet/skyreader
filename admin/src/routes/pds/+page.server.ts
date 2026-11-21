import { listPdsHosts } from '$lib/queries/pds';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
  return { hosts: await listPdsHosts(platform!.env.DB) };
};
