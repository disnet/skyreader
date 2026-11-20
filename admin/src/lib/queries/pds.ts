import { summarizePdsHosts, type PdsHostSummary, type PdsTraitsRow } from '$lib/metrics/pds';

/** Readers per PDS host, and what each host has been seen doing (pds_host_traits). */
export async function listPdsHosts(db: D1Database): Promise<PdsHostSummary[]> {
  const [readers, traits] = await Promise.all([
    db
      .prepare('SELECT pds_url, COUNT(*) AS readers FROM users GROUP BY pds_url')
      .all<{ pds_url: string; readers: number }>(),
    db.prepare('SELECT * FROM pds_host_traits').all<PdsTraitsRow>(),
  ]);
  return summarizePdsHosts(readers.results, traits.results);
}
