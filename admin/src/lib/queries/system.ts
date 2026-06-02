export interface TableCount {
  name: string;
  count: number;
}

export async function getTableRowCounts(db: D1Database): Promise<TableCount[]> {
  const tables = [
    'users',
    'sessions',
    'subscriptions_cache',
    'item_labels_cache',
    'documents',
    'feed_metadata',
    'feed_items',
    'feed_cache',
    'follows_cache',
    'inapp_follows',
    'sync_state',
  ];

  return Promise.all(
    tables.map(async (name) => {
      const r = await db
        .prepare(`SELECT COUNT(*) as count FROM ${name}`)
        .first<{ count: number }>();
      return { name, count: r?.count ?? 0 };
    })
  );
}
