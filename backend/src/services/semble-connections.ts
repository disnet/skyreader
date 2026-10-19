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
 * A save's `url_key`: its normalized URL, or '' when it has no web URL (an
 * upload). Set on every insert so the ingest can match it straight away.
 */
export function savedUrlKey(url: string | null | undefined): string {
  return (url && normalizeArticleUrl(url)) || '';
}

/** Rows backfilled per call, so one call stays well inside the statement budget. */
const BACKFILL_BATCH = 400;

/**
 * Give this reader's older saves a `url_key`, a batch at a time. Saves made
 * before url_key existed have none, and until they do no connection can match
 * them. Runs when the reader asks for their connections; a later call finishes
 * a large Library.
 */
export async function backfillSavedUrlKeys(env: Env, userDid: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, url FROM saved_articles WHERE url_key IS NULL AND user_did = ? LIMIT ?`
  )
    .bind(userDid, BACKFILL_BATCH)
    .all<{ id: number; url: string | null }>();
  if (rows.results.length === 0) return 0;
  await env.DB.batch(
    rows.results.map((row) =>
      env.DB.prepare('UPDATE saved_articles SET url_key = ? WHERE id = ?').bind(
        savedUrlKey(row.url),
        row.id
      )
    )
  );
  return rows.results.length;
}

/**
 * Apply one firehose commit. Returns true when it changed a row.
 *
 * An edge is written only when one of its ends is already in someone's saves
 * (`EXISTS` against saved_articles.url_key), so the table holds the slice of
 * Semble's graph that touches a Library. Ends that are AT URIs (a card rather
 * than a URL) normalize to null and are skipped.
 */
export async function applySembleConnectionCommit(
  env: Env,
  did: string,
  commit: SembleConnectionCommit,
  now = Date.now()
): Promise<boolean> {
  const uri = `at://${did}/${SEMBLE_CONNECTION_COLLECTION}/${commit.rkey}`;

  if (commit.operation === 'delete') return dropConnection(env, uri);

  const record = commit.record;
  if (!record) return false;
  const sourceUrl = str(record.source, 2048);
  const targetUrl = str(record.target, 2048);
  const source = sourceUrl ? normalizeArticleUrl(sourceUrl) : null;
  const target = targetUrl ? normalizeArticleUrl(targetUrl) : null;
  if (!sourceUrl || !targetUrl || !source || !target || source === target) {
    // An edit that turned an end into something we can't match is gone for us.
    if (commit.operation === 'update') return dropConnection(env, uri);
    return false;
  }

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
     WHERE EXISTS (SELECT 1 FROM saved_articles WHERE url_key IN (?, ?))
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
  if ((result.meta.changes ?? 0) > 0) return true;
  // The gate above writes nothing when neither end is saved, so an edit that
  // moved the edge off a saved URL would leave the old row badging that save.
  if (commit.operation === 'update') return dropConnection(env, uri);
  return false;
}

async function dropConnection(env: Env, uri: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM semble_connections WHERE uri = ?')
    .bind(uri)
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
       SELECT s.rkey, s.saved_at, s.url_key, c.indexed_at
       FROM saved_articles s
       JOIN semble_connections c ON c.source_normalized = s.url_key
       WHERE s.user_did = ?1 AND c.curator_did != ?1
       UNION ALL
       SELECT s.rkey, s.saved_at, s.url_key, c.indexed_at
       FROM saved_articles s
       JOIN semble_connections c ON c.target_normalized = s.url_key
       WHERE s.user_did = ?1 AND c.curator_did != ?1
     )
     SELECT e.rkey,
            SUM(CASE WHEN e.indexed_at > COALESCE(seen.seen_at, e.saved_at) THEN 1 ELSE 0 END)
              AS unseen,
            MAX(e.indexed_at) AS latest_at,
            seen.seen_at AS seen_at
     FROM edges e
     LEFT JOIN semble_connection_seen seen
       ON seen.user_did = ?1 AND seen.url_key = e.url_key
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
    `INSERT INTO semble_connection_seen (user_did, url_key, seen_at)
     SELECT user_did, url_key, ?
     FROM saved_articles
     WHERE user_did = ? AND rkey = ? AND url_key IS NOT NULL AND url_key != ''
     ON CONFLICT(user_did, url_key) DO UPDATE SET seen_at = excluded.seen_at`
  )
    .bind(now, userDid, rkey)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
