import { loadAllMetrics } from '$lib/metrics';
import { loadOps } from '$lib/metrics/ops';
import { loadVitals } from '$lib/metrics/vitals';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
  const db = platform!.env.DB;
  const [groups, ops, vitals] = await Promise.all([
    loadAllMetrics(db),
    loadOps(db),
    loadVitals(db),
  ]);
  return { groups, ops, vitals };
};
