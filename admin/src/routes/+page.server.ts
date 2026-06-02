import { loadAllMetrics } from '$lib/metrics';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
  const db = platform!.env.DB;
  const groups = await loadAllMetrics(db);
  return { groups };
};
