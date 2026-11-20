import { summarizePdsHosts, type PdsHostSummary, type PdsTraitsRow } from '$lib/metrics/pds';

/** Readers per PDS host, and what each host has been seen doing (pds_host_traits). */
export async function listPdsHosts(db: D1Database): Promise<PdsHostSummary[]> {
  const [readers, traits] = await Promise.all([
    db
      .prepare(
        `SELECT pds_url, COUNT(*) AS readers FROM users
          WHERE registered_at IS NOT NULL GROUP BY pds_url`
      )
      .all<{ pds_url: string; readers: number }>(),
    // The admin can deploy before the backend applies the table's migration.
    db
      .prepare('SELECT * FROM pds_host_traits')
      .all<PdsTraitsRow>()
      .catch((error: unknown) => {
        if (/no such table/i.test(String(error))) return { results: [] as PdsTraitsRow[] };
        throw error;
      }),
  ]);
  return summarizePdsHosts(readers.results, traits.results);
}
