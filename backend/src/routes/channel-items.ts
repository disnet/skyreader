/**
 * GET /api/channels/:uuid/items — what a saved search has matched, newest
 * first. The channel itself stays a client blob; this reads the matches the
 * Percolator wrote for it (docs/plans/SAVED_SEARCH_CHANNELS.md).
 */

import type { Env, FeedItem, Session } from '../types';
import { splitSnippet } from '../durable-objects/search-index';
import { getSavedSearchAccess, type LinkCard, type Sharer } from '../services/saved-search';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const UNREAD_COUNT_CAP = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface MatchRow {
  dedup_key: string;
  item_key: string;
  source_kind: 'feed' | 'document' | 'follows';
  source_ref: string;
  feed_seq: number | null;
  snippet: string;
  published_at: number;
  matched_at: number;
  read: number;
  item_json: string | null;
  doc_site_uri: string | null;
  doc_url: string | null;
  doc_title: string | null;
  doc_description: string | null;
  body_skipped: number;
  link_json: string | null;
}

/** Sharers shown per story; the rest are a count. */
const SHARERS_SHOWN = 3;

interface SharerRow {
  dedup_key: string;
  source_ref: string;
  item_key: string;
  meta_json: string | null;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// A match is read when its item carries the reader's read label, under the
// item type the timeline and the document reader file it under.
const READ_SQL = `EXISTS (
    SELECT 1 FROM item_labels_cache il
     WHERE il.user_did = m.user_did AND il.item_key = m.item_key
       AND il.item_type = CASE m.source_kind WHEN 'document' THEN 'document' ELSE 'article' END
       AND il.label = 'read' AND il.deleted_at IS NULL)`;

/** `before` is `<publishedAt>:<dedupKey>` from the previous page's `nextCursor`. */
function parseCursor(raw: string | null): { at: number; key: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf(':');
  const at = Number(raw.slice(0, sep));
  if (sep <= 0 || !Number.isFinite(at)) return null;
  return { at, key: raw.slice(sep + 1) };
}

export async function handleChannelItems(
  request: Request,
  env: Env,
  session: Session,
  uuid: string
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!UUID_RE.test(uuid)) return json({ error: 'Invalid UUID format' }, 400);

  const access = await getSavedSearchAccess(env, session.did);
  if (!access.enabled) return json({ error: 'Not found' }, 404);
  if (access.maxSavedSearches === 0) {
    return json({ error: 'Saved searches are a Supporter feature', code: 'upgrade_required' }, 403);
  }

  const query = await env.DB.prepare(
    `SELECT q.query, q.backfill_state, q.created_at,
            (SELECT count(*) FROM saved_queries o
              WHERE o.user_did = q.user_did
                AND (o.created_at < q.created_at
                     OR (o.created_at = q.created_at AND o.channel_uuid < q.channel_uuid))) AS rank
       FROM saved_queries q WHERE q.user_did = ? AND q.channel_uuid = ?`
  )
    .bind(session.did, uuid)
    .first<{ query: string; backfill_state: string; rank: number }>();
  if (!query) return json({ error: 'Not a saved search', code: 'not_saved_search' }, 404);

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get('limit'));
  const limit =
    Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const before = parseCursor(url.searchParams.get('before'));

  const [page, unread] = await env.DB.batch([
    env.DB.prepare(
      `SELECT m.dedup_key, m.item_key, m.source_kind, m.source_ref, m.feed_seq, m.snippet,
              m.published_at, m.matched_at, m.body_skipped, m.link_json, ${READ_SQL} AS read,
              fi.item_json,
              d.site_uri AS doc_site_uri, d.canonical_url AS doc_url,
              json_extract(d.record_json, '$.title') AS doc_title,
              json_extract(d.record_json, '$.description') AS doc_description
         FROM channel_matches m
         LEFT JOIN feed_items fi ON m.source_kind = 'feed' AND fi.seq = m.feed_seq
         LEFT JOIN documents_v2 d ON m.source_kind = 'document' AND d.record_uri = m.item_key
        WHERE m.user_did = ? AND m.channel_uuid = ?
          AND (? IS NULL OR m.published_at < ? OR (m.published_at = ? AND m.dedup_key < ?))
        ORDER BY m.published_at DESC, m.dedup_key DESC
        LIMIT ?`
    ).bind(
      session.did,
      uuid,
      before?.at ?? null,
      before?.at ?? null,
      before?.at ?? null,
      before?.key ?? null,
      limit + 1
    ),
    env.DB.prepare(
      `SELECT count(*) AS n FROM (
         SELECT 1 FROM channel_matches m
          WHERE m.user_did = ? AND m.channel_uuid = ? AND NOT ${READ_SQL}
          LIMIT ?)`
    ).bind(session.did, uuid, UNREAD_COUNT_CAP + 1),
  ]);

  const rows = (page.results ?? []) as MatchRow[];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);

  // Who among the reader's follows shared each story, whichever source matched first.
  const sharers = new Map<string, Sharer[]>();
  if (pageRows.length > 0) {
    const shared = await env.DB.prepare(
      `SELECT dedup_key, source_ref, item_key, meta_json FROM channel_match_sources
        WHERE user_did = ? AND channel_uuid = ? AND source_kind = 'follows'
          AND dedup_key IN (SELECT value FROM json_each(?))
        ORDER BY matched_at, source_ref`
    )
      .bind(session.did, uuid, JSON.stringify(pageRows.map((r) => r.dedup_key)))
      .all<SharerRow>();
    for (const row of shared.results ?? []) {
      const meta = parseJson<Omit<Sharer, 'did' | 'postUri'>>(row.meta_json);
      const list = sharers.get(row.dedup_key) ?? [];
      list.push({
        did: row.source_ref,
        postUri: row.item_key,
        handle: meta?.handle ?? null,
        name: meta?.name ?? null,
        avatar: meta?.avatar ?? null,
      });
      sharers.set(row.dedup_key, list);
    }
  }

  const items = [];
  for (const row of pageRows) {
    const sharedBy = sharers.get(row.dedup_key) ?? [];
    const base = {
      kind: row.source_kind,
      itemKey: row.item_key,
      publishedAt: row.published_at,
      matchedAt: row.matched_at,
      read: row.read === 1,
      snippet: splitSnippet(row.snippet),
      sharedBy: sharedBy.slice(0, SHARERS_SHOWN),
      sharedByCount: sharedBy.length,
    };
    if (row.source_kind === 'feed') {
      // The item can outlive its row only through the archive's sanity trim;
      // a match whose item is gone is skipped rather than served empty.
      if (!row.item_json) continue;
      let item: FeedItem;
      try {
        item = JSON.parse(row.item_json) as FeedItem;
      } catch {
        continue;
      }
      items.push({
        ...base,
        item: { ...item, seq: row.feed_seq, feedUrl: row.source_ref, read: row.read === 1 },
      });
    } else if (row.source_kind === 'follows') {
      const link = parseJson<LinkCard>(row.link_json);
      if (!link?.url) continue;
      items.push({
        ...base,
        // Read state is filed under the normalized URL, as on the follows surface.
        link: { ...link, urlNormalized: row.item_key },
        // Matched on the sharers' words and the card only: the reader's daily
        // article budget was spent before this one could be read.
        bodySkipped: row.body_skipped === 1,
      });
    } else {
      if (row.doc_title === null && row.doc_url === null) continue;
      items.push({
        ...base,
        document: {
          uri: row.item_key,
          authorDid: row.source_ref,
          siteUri: row.doc_site_uri ?? '',
          url: row.doc_url,
          title: row.doc_title ?? '',
          description: row.doc_description ?? '',
        },
      });
    }
  }
  const last = pageRows.at(-1);
  const unreadCount = ((unread.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;

  return json({
    query: query.query,
    // Past the plan's count this query keeps its matches but gets no new ones.
    status: query.rank < access.maxSavedSearches ? 'active' : 'over_limit',
    backfilling: query.backfill_state === 'pending',
    items,
    unread: Math.min(unreadCount, UNREAD_COUNT_CAP),
    unreadCapped: unreadCount > UNREAD_COUNT_CAP,
    nextCursor: hasMore && last ? `${last.published_at}:${last.dedup_key}` : null,
  });
}
