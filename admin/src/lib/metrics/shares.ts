import type { MetricDefinition } from '$lib/types';

export const shareMetrics: MetricDefinition[] = [
	{
		id: 'total_shares',
		category: 'Shares',
		query: async (db) => {
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM shares')
				.first<{ count: number }>();
			return { label: 'Total Shares', value: r?.count ?? 0 };
		}
	},
	{
		id: 'shares_today',
		category: 'Shares',
		query: async (db) => {
			const since = Math.floor(Date.now() / 1000) - 86400;
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM shares WHERE created_at > ?')
				.bind(since)
				.first<{ count: number }>();
			return { label: 'Shares Today', value: r?.count ?? 0 };
		}
	},
	{
		id: 'shares_week',
		category: 'Shares',
		query: async (db) => {
			const since = Math.floor(Date.now() / 1000) - 7 * 86400;
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM shares WHERE created_at > ?')
				.bind(since)
				.first<{ count: number }>();
			return { label: 'Shares (7d)', value: r?.count ?? 0 };
		}
	}
];
