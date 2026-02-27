import type { MetricDefinition } from '$lib/types';

export const userMetrics: MetricDefinition[] = [
	{
		id: 'total_users',
		category: 'Users',
		query: async (db) => {
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM users WHERE registered_at IS NOT NULL')
				.first<{ count: number }>();
			const cap = 500;
			const count = r?.count ?? 0;
			const pct = (count / cap) * 100;
			return {
				label: 'Registered Users',
				value: count,
				unit: `/ ${cap}`,
				status: pct >= 90 ? 'error' : pct >= 80 ? 'warning' : 'healthy'
			};
		}
	},
	{
		id: 'active_24h',
		category: 'Users',
		query: async (db) => {
			const since = Math.floor(Date.now() / 1000) - 86400;
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM users WHERE last_active_at > ?')
				.bind(since)
				.first<{ count: number }>();
			return { label: 'Active (24h)', value: r?.count ?? 0 };
		}
	},
	{
		id: 'active_7d',
		category: 'Users',
		query: async (db) => {
			const since = Math.floor(Date.now() / 1000) - 7 * 86400;
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM users WHERE last_active_at > ?')
				.bind(since)
				.first<{ count: number }>();
			return { label: 'Active (7d)', value: r?.count ?? 0 };
		}
	},
	{
		id: 'active_30d',
		category: 'Users',
		query: async (db) => {
			const since = Math.floor(Date.now() / 1000) - 30 * 86400;
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM users WHERE last_active_at > ?')
				.bind(since)
				.first<{ count: number }>();
			return { label: 'Active (30d)', value: r?.count ?? 0 };
		}
	}
];
