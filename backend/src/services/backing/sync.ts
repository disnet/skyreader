/**
 * External-backed saves — Phase 2 read path wiring.
 *
 * Two stores (see docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md):
 *  - MEMBERSHIP SNAPSHOT (backed_collection_members): replaced WHOLESALE from each
 *    provably-complete poll. Never row-diffed.
 *  - ENRICHMENT (saved_articles, keyed by url_normalized): reading work. A poll only
 *    ever MERGE-upserts here (stub rows for new URLs); it NEVER deletes enrichment.
 *
 * The Saved set when backing is on = membership ⋈ enrichment (join on url_normalized)
 * ∪ native-only items (uploads / un-migrated legacy saves). A botched poll can only
 * stale the displayed membership (recovered next good poll), never lose reading work.
 */

import type { Env, Session } from '../../types';
import { generateTid } from '../../utils/tid';
import { snapshotBackedCollection, type BackedMember } from './read';
import { removeMember } from './write';
import { createPDSClient } from '../pds-client';
import { FeedProxyClient } from '../feed-proxy-client';
import { fillExtractedContent } from '../saved-content';
import type { SaveBacking } from '../../routes/settings';

// Open-driven poll cadence: skip a fresh snapshot if we polled within this window.
const POLL_GATE_MS = 60_000;
// Tombstone backstop: a suppression older than this is force-cleared so a
// permanently-stuck foreign delete can't hide a URL forever (Phase 4).
const TOMBSTONE_TTL_MS = 10 * 60_000;

interface MemberMetadata {
  title?: string;
  author?: string;
  description?: string;
  image?: string;
  domain?: string;
  canonicalAtUri?: string;
}

/**
 * Poll the backed collection and, IF the snapshot is provably complete, replace the
 * membership snapshot wholesale (excluding tombstoned URLs) and merge-upsert stub
 * enrichment rows for new URLs — all in one atomic D1 batch. Gated to POLL_GATE_MS
 * unless `force`. A non-complete snapshot leaves the last good membership in place.
 *
 * Reads are auth-free, so this works without a live session (background-safe).
 */
export async function pollBackedMembership(
  env: Env,
  userDid: string,
  backing: SaveBacking,
  opts: { force?: boolean } = {}
): Promise<{ polled: boolean; complete: boolean; memberCount: number }> {
  if (backing.provider === 'skyreader') return { polled: false, complete: false, memberCount: 0 };
  const collectionUri = backing.collectionUri;

  if (!opts.force) {
    const row = await env.DB.prepare(
      `SELECT last_backing_poll FROM user_settings WHERE user_did = ?`
    )
      .bind(userDid)
      .first<{ last_backing_poll: number | null }>();
    const last = row?.last_backing_poll ?? 0;
    if (Date.now() - last < POLL_GATE_MS) {
      return { polled: false, complete: false, memberCount: 0 };
    }
  }

  const snapshot = await snapshotBackedCollection(backing.provider, userDid, collectionUri);
  if (!snapshot.complete) {
    // No information — do NOT replace membership (Phase 2 invariant 1). Still record
    // the attempt so we don't re-hammer a failing PDS every single open.
    await env.DB.prepare(`UPDATE user_settings SET last_backing_poll = ? WHERE user_did = ?`)
      .bind(Date.now(), userDid)
      .run();
    return { polled: true, complete: false, memberCount: 0 };
  }

  // Tombstones: URLs just-unsaved locally whose foreign membership-delete may not
  // have propagated. Exclude them from the replace so a stale snapshot can't resurrect
  // an unsave. Drop expired tombstones up front (TTL backstop).
  const now = Date.now();
  await env.DB.prepare(
    `DELETE FROM backed_unsave_tombstones
     WHERE user_did = ? AND external_collection = ? AND created_at < ?`
  )
    .bind(userDid, collectionUri, now - TOMBSTONE_TTL_MS)
    .run();
  const tombRows = await env.DB.prepare(
    `SELECT url_normalized FROM backed_unsave_tombstones
     WHERE user_did = ? AND external_collection = ?`
  )
    .bind(userDid, collectionUri)
    .all<{ url_normalized: string }>();
  const tombstoned = new Set(tombRows.results.map((r) => r.url_normalized));

  // Dedup members by the join key (same article via two records collapses to one).
  const byKey = new Map<string, BackedMember>();
  for (const m of snapshot.members) {
    if (tombstoned.has(m.urlNormalized)) continue;
    if (!byKey.has(m.urlNormalized)) byKey.set(m.urlNormalized, m);
  }
  const members = [...byKey.values()];
  const snapshotKeys = new Set(snapshot.members.map((m) => m.urlNormalized));

  const batch: D1PreparedStatement[] = [];

  // (1) Wholesale replace membership for THIS collection.
  batch.push(
    env.DB.prepare(
      `DELETE FROM backed_collection_members WHERE user_did = ? AND external_collection = ?`
    ).bind(userDid, collectionUri)
  );
  for (const m of members) {
    const metadata: MemberMetadata = {
      canonicalAtUri: m.canonicalAtUri,
      title: m.title,
      author: m.author,
      description: m.description,
      image: m.image,
    };
    batch.push(
      env.DB.prepare(
        `INSERT INTO backed_collection_members
           (user_did, external_collection, url_normalized, url, external_provider,
            external_item_uri, external_link_uri, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        userDid,
        collectionUri,
        m.urlNormalized,
        m.url,
        backing.provider,
        m.itemUri,
        m.linkUri,
        JSON.stringify(metadata)
      )
    );
  }

  // (2) Merge-upsert a STUB enrichment row for each member URL, seeded with whatever
  //     metadata the foreign record carried (title/author/etc) so the list shows a
  //     real title immediately. Never clobbers an existing row's body/labels
  //     (ON CONFLICT DO NOTHING); the body is filled by extractMissingBackedContent.
  for (const m of members) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO saved_articles
           (user_did, rkey, record_uri, url, url_normalized, title, author, description, image,
            content_type, source, item_guid, saved_at, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'webpage', 'url', ?, ?, ?)
         ON CONFLICT(user_did, url_normalized) DO NOTHING`
      ).bind(
        userDid,
        generateTid(),
        m.url,
        m.urlNormalized,
        m.title ?? null,
        m.author ?? null,
        m.description ?? null,
        m.image ?? null,
        m.canonicalAtUri ?? null,
        now,
        now
      )
    );
  }

  // (3) Clear tombstones the snapshot confirms are gone upstream (the foreign delete
  //     landed); keep those still present (delete not yet propagated — re-fired by
  //     the unsave path / next poll).
  for (const key of tombstoned) {
    if (!snapshotKeys.has(key)) {
      batch.push(
        env.DB.prepare(
          `DELETE FROM backed_unsave_tombstones
           WHERE user_did = ? AND external_collection = ? AND url_normalized = ?`
        ).bind(userDid, collectionUri, key)
      );
    }
  }

  // (4) Stamp the poll time.
  batch.push(
    env.DB.prepare(`UPDATE user_settings SET last_backing_poll = ? WHERE user_did = ?`).bind(
      now,
      userDid
    )
  );

  await env.DB.batch(batch);
  return { polled: true, complete: true, memberCount: members.length };
}

interface MissingRow {
  id: number;
  url: string;
  title: string | null;
}

/**
 * Fill in the body (and any missing title/author/etc) for backed saves that were
 * imported as stubs. Extraction is server-side via the feed-proxy /extract (auth-free,
 * secret-gated, per-URL cached), so this runs background-safe with no user session.
 *
 * Bounded to `limit` rows per call and run from the Saved-list open (via ctx.waitUntil),
 * so a large import fills in progressively across opens and self-heals — a botched or
 * un-extractable URL just keeps its title and an empty body. Extraction NEVER touches
 * membership; it only enriches the saved_articles row, keyed by url_normalized.
 */
export async function extractMissingBackedContent(
  env: Env,
  userDid: string,
  opts: { limit?: number } = {}
): Promise<number> {
  const limit = opts.limit ?? 20;
  // Backed enrichment rows still missing a body; content IS NULL = not yet extracted.
  // Scope to article-like saves only: a 'document' save's url is a resolved blogs URL
  // (not an extractable article) and a 'share' has no article body — extracting either
  // would fetch the wrong content AND hard-flip content_type to 'article' below.
  const rows = await env.DB.prepare(
    `SELECT id, url, title FROM saved_articles
     WHERE user_did = ? AND content IS NULL AND url != '' AND url_normalized IS NOT NULL
       AND source IN ('url', 'feed')
     ORDER BY saved_at DESC LIMIT ?`
  )
    .bind(userDid, limit)
    .all<MissingRow>();
  if (rows.results.length === 0) return 0;

  const proxy = new FeedProxyClient(env);
  let filled = 0;
  // Small concurrency; the proxy itself caps and caches per URL.
  const CONCURRENCY = 4;
  const queue = [...rows.results];
  async function worker() {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      try {
        const a = await proxy.extract(row.url);
        // Set the body, COALESCE-fill metadata only where the stub lacked it (keep the
        // foreign-record title/author we already captured), and hard-set the type to
        // 'article' — these rows are only ever article-like saves (source IN url/feed).
        await fillExtractedContent(env, a, { id: row.id }, { setArticleType: true });
        filled++;
      } catch (err) {
        console.error(`[backing] extract failed for ${row.url}:`, err);
        // Leave the row as-is (title + empty body); a later pass can retry.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return filled;
}

/**
 * Unsave a backed save (Phase 4): remove the membership snapshot row AND write a
 * tombstone in one D1 step, then fire-and-forget the foreign membership delete. The
 * tombstone suppresses the URL from the next wholesale-replace poll until a complete
 * snapshot confirms the foreign delete propagated (the self-healing read path would
 * otherwise resurrect the unsave). The item record (card/note) is NEVER deleted — it
 * may belong to other collections; unsave = leave the collection, not delete the item.
 *
 * No-op when there's no membership row for the URL (native-only / already gone).
 */
export async function backedUnsave(
  env: Env,
  session: Session,
  backing: Extract<SaveBacking, { provider: 'semble' | 'margin' }>,
  urlNormalized: string,
  ctx: ExecutionContext
): Promise<void> {
  const collectionUri = backing.collectionUri;
  const member = await env.DB.prepare(
    `SELECT external_link_uri FROM backed_collection_members
     WHERE user_did = ? AND external_collection = ? AND url_normalized = ?`
  )
    .bind(session.did, collectionUri, urlNormalized)
    .first<{ external_link_uri: string }>();
  if (!member) return; // nothing backed for this URL

  // Remove membership + tombstone atomically (immediate UI removal + resurrection guard).
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM backed_collection_members
       WHERE user_did = ? AND external_collection = ? AND url_normalized = ?`
    ).bind(session.did, collectionUri, urlNormalized),
    env.DB.prepare(
      `INSERT INTO backed_unsave_tombstones (user_did, external_collection, url_normalized, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_did, external_collection, url_normalized) DO UPDATE SET created_at = excluded.created_at`
    ).bind(session.did, collectionUri, urlNormalized, Date.now()),
  ]);

  // Fire-and-forget the foreign membership delete (the link/item record only).
  const pds = createPDSClient(session);
  ctx.waitUntil(
    removeMember(pds, backing.provider, { linkUri: member.external_link_uri }).catch((err) => {
      console.error('[backing] foreign membership delete failed (tombstone will re-fire):', err);
    })
  );
}

/** The unified saved-item shape returned by GET /api/saved. */
export interface SavedArticleView {
  rkey: string | null;
  uri: string | null;
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  contentType: string;
  domain: string | null;
  image: string | null;
  wordCount: number | null;
  publishedAt: string | null;
  savedAt: string;
  source: string;
  itemGuid: string | null;
}

interface JoinedRow {
  m_url: string | null;
  m_metadata: string | null;
  external_item_uri: string | null;
  rkey: string | null;
  record_uri: string | null;
  url: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  content_type: string | null;
  domain: string | null;
  image: string | null;
  word_count: number | null;
  published_at: number | null;
  saved_at: number | null;
  source: string | null;
  item_guid: string | null;
}

function rowToView(row: JoinedRow): SavedArticleView {
  let meta: MemberMetadata = {};
  if (row.m_metadata) {
    try {
      meta = JSON.parse(row.m_metadata) as MemberMetadata;
    } catch {
      meta = {};
    }
  }
  const url = row.url ?? row.m_url ?? '';
  return {
    rkey: row.rkey,
    // For a backed save there's no app.skyreader.feed.saved export — surface the
    // foreign item at-uri as the record handle instead of a synthesized one.
    uri: row.record_uri ?? row.external_item_uri,
    url,
    title: row.title ?? meta.title ?? null,
    author: row.author ?? meta.author ?? null,
    description: row.description ?? meta.description ?? null,
    content: row.content,
    contentType: row.content_type || 'webpage',
    domain: row.domain ?? meta.domain ?? null,
    image: row.image ?? meta.image ?? null,
    wordCount: row.word_count,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    savedAt: new Date(row.saved_at ?? Date.now()).toISOString(),
    source: row.source || 'url',
    itemGuid: row.item_guid ?? meta.canonicalAtUri ?? null,
  };
}

/**
 * The backed Saved list: membership ⋈ enrichment (scoped to the backing collection)
 * UNION native-only items (uploads / un-migrated legacy saves not in the collection).
 * Sorted newest-first.
 */
export async function listBackedSaved(
  env: Env,
  userDid: string,
  backing: Extract<SaveBacking, { provider: 'semble' | 'margin' }>
): Promise<SavedArticleView[]> {
  const collectionUri = backing.collectionUri;

  // (A) Every current member, joined to its enrichment row (body/word count/labels).
  const membersQ = env.DB.prepare(
    `SELECT m.url AS m_url, m.metadata AS m_metadata, m.external_item_uri,
            s.rkey, s.record_uri, s.url, s.title, s.author, s.description, s.content,
            s.content_type, s.domain, s.image, s.word_count, s.published_at, s.saved_at,
            s.source, s.item_guid
     FROM backed_collection_members m
     LEFT JOIN saved_articles s
       ON s.user_did = m.user_did AND s.url_normalized = m.url_normalized
     WHERE m.user_did = ? AND m.external_collection = ?`
  ).bind(userDid, collectionUri);

  // (B) Native-only enrichment rows not represented in this collection's membership
  //     (uploads, legacy saves yet to be exported). url_normalized NULL = legacy.
  const nativeQ = env.DB.prepare(
    `SELECT NULL AS m_url, NULL AS m_metadata, NULL AS external_item_uri,
            s.rkey, s.record_uri, s.url, s.title, s.author, s.description, s.content,
            s.content_type, s.domain, s.image, s.word_count, s.published_at, s.saved_at,
            s.source, s.item_guid
     FROM saved_articles s
     WHERE s.user_did = ?
       AND (s.url_normalized IS NULL OR NOT EXISTS (
         SELECT 1 FROM backed_collection_members m
         WHERE m.user_did = s.user_did AND m.external_collection = ?
           AND m.url_normalized = s.url_normalized
       ))`
  ).bind(userDid, collectionUri);

  const [membersRes, nativeRes] = await env.DB.batch<JoinedRow>([membersQ, nativeQ]);
  const views = [...membersRes.results, ...nativeRes.results].map(rowToView);
  views.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  return views;
}
