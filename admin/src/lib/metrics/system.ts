import type { MetricDefinition } from '$lib/types';

const rowCountTables = [
	{ table: 'users', label: 'Users' },
	{ table: 'shares', label: 'Shares' },
	{ table: 'feed_metadata', label: 'Feeds' },
	{ table: 'feed_items', label: 'Feed Items' },
	{ table: 'subscriptions_cache', label: 'Subscriptions' }
];

export const systemMetrics: MetricDefinition[] = [
	{
		id: 'active_sessions',
		category: 'System',
		query: async (db) => {
			const now = Math.floor(Date.now() / 1000);
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM sessions WHERE expires_at > ?')
				.bind(now)
				.first<{ count: number }>();
			return { label: 'Active Sessions', value: r?.count ?? 0 };
		}
	},
	...rowCountTables.map(
		({ table, label }): MetricDefinition => ({
			id: `rows_${table}`,
			category: 'System',
			query: async (db) => {
				const r = await db
					.prepare(`SELECT COUNT(*) as count FROM ${table}`)
					.first<{ count: number }>();
				return { label: `${label} Rows`, value: r?.count ?? 0 };
			}
		})
	)
];
