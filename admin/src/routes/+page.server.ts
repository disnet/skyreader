import { loadAllMetrics } from '$lib/metrics';
import { loadOps } from '$lib/metrics/ops';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
  const db = platform!.env.DB;
  const [groups, ops] = await Promise.all([loadAllMetrics(db), loadOps(db)]);
  return { groups, ops };
};
