import type { MetricDefinition, MetricValue } from '$lib/types';
import { userMetrics } from './users';
import { feedMetrics } from './feeds';
import { systemMetrics } from './system';

const allMetrics: MetricDefinition[] = [...userMetrics, ...feedMetrics, ...systemMetrics];

export interface MetricGroup {
  category: string;
  metrics: MetricValue[];
}

export async function loadAllMetrics(db: D1Database): Promise<MetricGroup[]> {
  const results = await Promise.all(
    allMetrics.map(async (m) => {
      try {
        const value = await m.query(db);
        return { category: m.category, value };
      } catch {
        return {
          category: m.category,
          value: { label: m.id, value: 'Error', status: 'error' as const },
        };
      }
    })
  );

  const grouped = new Map<string, MetricValue[]>();
  for (const r of results) {
    const list = grouped.get(r.category) ?? [];
    list.push(r.value);
    grouped.set(r.category, list);
  }

  const categoryOrder = ['Users', 'Feeds', 'System'];
  return categoryOrder
    .filter((c) => grouped.has(c))
    .map((c) => ({ category: c, metrics: grouped.get(c)! }));
}
