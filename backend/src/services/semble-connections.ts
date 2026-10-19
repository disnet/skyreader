import type { Env } from '../types';
import { normalizeArticleUrl } from '../utils/url-normalize';

/**
 * Semble connections drawn off a reader's saves — Skyreader's take on Semble's
 * notification feed (docs/plans/SEMBLE_CONNECTIONS.md).
 *
 * Semble notifies you when someone connects something to one of your cards. That
 * feed lives behind Semble's own login, but the edges themselves are public
 * `network.cosmik.connection` records, so the JetstreamPoller watches them
 * network-wide and keeps the ones with an end someone here has saved. The reader
 * then gets a "new connections" mark on the save, whether or not it is on Semble.
 */

export const SEMBLE_CONNECTION_COLLECTION = 'network.cosmik.connection';

const MAX_NOTE = 1000;
const MAX_TYPE = 64;

/** The fields of a connection record this reads; Semble owns the shape. */
export interface SembleConnectionRecord {
  source?: unknown;
  target?: unknown;
  connectionType?: unknown;
  note?: unknown;
  createdAt?: unknown;
}

export interface SembleConnectionCommit {
  operation: 'create' | 'update' | 'delete';
  rkey: string;
  record?: SembleConnectionRecord;
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * Apply one firehose commit. Returns true when it changed a row.
 *
 * One statement either way: an edge is written only when one of its ends is
 * already in someone's saves (`EXISTS` against saved_articles.url_normalized),
 * so the table holds the slice of Semble's graph that touches a Library. Ends
 * that are AT URIs (a card rather than a URL) normalize to null and are skipped.
 */
export async function applySembleConnectionCommit(
  env: Env,
  did: string,
  commit: SembleConnectionCommit,
  now = Date.now()
): Promise<boolean> {
  const uri = `at://${did}/${SEMBLE_CONNECTION_COLLECTION}/${commit.rkey}`;

  if (commit.operation === 'delete') {
    const result = await env.DB.prepare('DELETE FROM semble_connections WHERE uri = ?')
      .bind(uri)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  const record = commit.record;
  if (!record) return false;
  const sourceUrl = str(record.source, 2048);
  const targetUrl = str(record.target, 2048);
  const source = sourceUrl ? normalizeArticleUrl(sourceUrl) : null;
  const target = targetUrl ? normalizeArticleUrl(targetUrl) : null;
  if (!sourceUrl || !targetUrl || !source || !target || source === target) return false;

  const parsed = typeof record.createdAt === 'string' ? Date.parse(record.createdAt) : NaN;
  // A record can claim any time; a future one would read as new forever.
  const createdAt = Number.isFinite(parsed) ? Math.min(parsed, now) : now;
  const type = str(record.connectionType, MAX_TYPE);
  const note = str(record.note, MAX_NOTE);

  // An update keeps its first `indexed_at`: editing a note isn't a new edge.
  const result = await env.DB.prepare(
    `INSERT INTO semble_connections
       (uri, curator_did, source_url, source_normalized, target_url, target_normalized,
        connection_type, note, created_at, indexed_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM saved_articles WHERE url_normalized IN (?, ?))
     ON CONFLICT(uri) DO UPDATE SET
       source_url = excluded.source_url,
       source_normalized = excluded.source_normalized,
       target_url = excluded.target_url,
       target_normalized = excluded.target_normalized,
       connection_type = excluded.connection_type,
       note = excluded.note`
  )
    .bind(
      uri,
      did,
      sourceUrl,
      source,
      targetUrl,
      target,
      type,
      note,
      createdAt,
      now,
      source,
      target
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export interface SavedConnectionActivity {
  rkey: string;
  /** Connections by other people since the reader last looked (or saved it). */
  unseen: number;
  /** When the newest connection by someone else arrived (ms). */
  latestAt: number;
  /** When the reader last looked, or null if never — what "new" is measured from. */
  seenAt: number | null;
}

/**
 * Per-save connection activity for one reader: every save with at least one
 * connection by someone else. The reader's own edges never count — Semble
 * doesn't notify you of your own connections either.
 */
export async function listSavedConnectionActivity(
  env: Env,
  userDid: string
): Promise<SavedConnectionActivity[]> {
  // Two joins rather than one with an OR, so each side uses its own index.
  const rows = await env.DB.prepare(
    `WITH edges AS (
       SELECT s.rkey, s.saved_at, s.url_normalized, c.indexed_at
       FROM saved_articles s
       JOIN semble_connections c ON c.source_normalized = s.url_normalized
       WHERE s.user_did = ?1 AND c.curator_did != ?1
       UNION ALL
       SELECT s.rkey, s.saved_at, s.url_normalized, c.indexed_at
       FROM saved_articles s
       JOIN semble_connections c ON c.target_normalized = s.url_normalized
       WHERE s.user_did = ?1 AND c.curator_did != ?1
     )
     SELECT e.rkey,
            SUM(CASE WHEN e.indexed_at > COALESCE(seen.seen_at, e.saved_at) THEN 1 ELSE 0 END)
              AS unseen,
            MAX(e.indexed_at) AS latest_at,
            seen.seen_at AS seen_at
     FROM edges e
     LEFT JOIN semble_connection_seen seen
       ON seen.user_did = ?1 AND seen.url_normalized = e.url_normalized
     GROUP BY e.rkey`
  )
    .bind(userDid)
    .all<{ rkey: string; unseen: number; latest_at: number; seen_at: number | null }>();

  return rows.results.map((row) => ({
    rkey: row.rkey,
    unseen: row.unseen,
    latestAt: row.latest_at,
    seenAt: row.seen_at,
  }));
}

/** Mark a save's connections as looked at. False when the reader has no such save. */
export async function markSavedConnectionsSeen(
  env: Env,
  userDid: string,
  rkey: string,
  now = Date.now()
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO semble_connection_seen (user_did, url_normalized, seen_at)
     SELECT user_did, url_normalized, ?
     FROM saved_articles
     WHERE user_did = ? AND rkey = ? AND url_normalized IS NOT NULL
     ON CONFLICT(user_did, url_normalized) DO UPDATE SET seen_at = excluded.seen_at`
  )
    .bind(now, userDid, rkey)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
