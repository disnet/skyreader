export interface TableCount {
  name: string;
  count: number;
}

// Only tables something still writes. An orphaned one (`documents`,
// `publications_cache`, `shares`) shows a frozen number next to live ones, which
// reads as a working subsystem during an incident.
export async function getTableRowCounts(db: D1Database): Promise<TableCount[]> {
  const tables = [
    'users',
    'sessions',
    'subscriptions_cache',
    'item_labels_cache',
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
