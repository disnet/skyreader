import type { MetricDefinition } from '$lib/types';

export const feedMetrics: MetricDefinition[] = [
	{
		id: 'total_feeds',
		category: 'Feeds',
		query: async (db) => {
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM feed_metadata')
				.first<{ count: number }>();
			return { label: 'Total Feeds', value: r?.count ?? 0 };
		}
	},
	{
		id: 'feeds_with_errors',
		category: 'Feeds',
		query: async (db) => {
			const r = await db
				.prepare('SELECT COUNT(*) as count FROM feed_metadata WHERE error_count > 0')
				.first<{ count: number }>();
			const count = r?.count ?? 0;
			return {
				label: 'Feeds with Errors',
				value: count,
				status: count > 0 ? 'warning' : 'healthy'
			};
		}
	},
	{
		id: 'avg_subscribers',
		category: 'Feeds',
		query: async (db) => {
			const r = await db
				.prepare('SELECT ROUND(AVG(subscriber_count), 1) as avg FROM feed_metadata')
				.first<{ avg: number }>();
			return { label: 'Avg Subscribers/Feed', value: r?.avg ?? 0 };
		}
	}
];
