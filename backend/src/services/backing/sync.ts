/**
 * External-backed saves — Phase 2 read path wiring.
 *
 * Two stores (see docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md):
 *  - MEMBERSHIP SNAPSHOT (backed_collection_members): kept in step with the
 *    collection by each poll, incrementally (see pollBackedMembership). Rows only
 *    leave on a provably-whole listing, so an incomplete poll can't empty it.
 *  - ENRICHMENT (saved_articles, keyed by url_normalized): reading work. A poll only
 *    ever MERGE-upserts here (stub rows for new URLs); it NEVER deletes enrichment.
 *
 * The Saved set when backing is on = membership ⋈ enrichment (join on url_normalized)
 * ∪ native-only items (uploads / un-migrated legacy saves). A botched poll can only
 * stale the displayed membership (recovered next good poll), never lose reading work.
 */

import type { Env, Session } from '../../types';
import { generateTid } from '../../utils/tid';
import { snapshotBackedCollection, TRANSIENT_SKIP, type BackedMember } from './read';
import { removeMember } from './write';
import { createPDSClient } from '../pds-client';
import { FeedProxyClient, FeedProxyError } from '../feed-proxy-client';
import { fillExtractedContent } from '../saved-content';
import { isEdited, type EditableColumn } from '../saved-metadata';
import { log, serializeError } from '../../utils/logger';
import type { SaveBacking } from '../../routes/settings';

// Open-driven poll cadence: skip a fresh snapshot if we polled within this window.
const POLL_GATE_MS = 60_000;
// Stored links re-resolved on each poll anyway, picked at random, so a card edited
// or deleted upstream (its link still listed) is eventually noticed. Each poll
// re-checks a given link with odds 25/N: in a collection of 400, a change is
// usually seen within a few dozen polls. Small next to the snapshot's budget.
export const POLL_REFRESH_SLICE = 25;
// Tombstone backstop: a suppression older than this is force-cleared so a
// permanently-stuck foreign delete can't hide a URL forever (Phase 4).
export const TOMBSTONE_TTL_MS = 10 * 60_000;

interface MemberMetadata {
  title?: string;
  author?: string;
  description?: string;
  image?: string;
  domain?: string;
  canonicalAtUri?: string;
}

/**
 * Poll the backed collection and bring the membership snapshot up to date,
 * merge-upserting stub enrichment rows for new URLs, all in one atomic D1 batch.
 * Gated to POLL_GATE_MS unless `force`.
 *
 * Incremental: links already stored are passed to the snapshot as `skipLinks`, so a
 * poll resolves only what is new, plus a small random slice of stored links
 * (POLL_REFRESH_SLICE) so an edited or deleted card is still noticed in time. It
 * used to re-resolve every card on every poll, one getRecord each, which a
 * collection of a few hundred cards ran out of the snapshot's subrequest budget on:
 * the poll never completed, so the collection never synced again, and every open
 * paid ~900 fetches for nothing.
 *
 * What a poll may change, and when:
 *  - A stored link the listing no longer names is removed, only when the listing is
 *    provably whole (`listingComplete`). A tombstoned URL is removed regardless.
 *  - A newly resolved member is added even when the snapshot is incomplete: it is a
 *    real member, and keeping it is what lets a collection too big for one poll's
 *    budget fill in across polls instead of starting over each time.
 *  - The poll counts as successful (`last_successful_backing_poll`) only when the
 *    snapshot is complete. An incomplete one never empties the table.
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

  // What we already hold: member rows, and links known to hold no article. All are
  // skipped, except a random slice re-checked.
  const [storedRes, nonArticleRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT url_normalized, external_link_uri FROM backed_collection_members
       WHERE user_did = ? AND external_collection = ?`
    ).bind(userDid, collectionUri),
    env.DB.prepare(
      `SELECT link_uri FROM backed_skipped_links WHERE user_did = ? AND external_collection = ?`
    ).bind(userDid, collectionUri),
  ]);
  const stored = storedRes.results as { url_normalized: string; external_link_uri: string }[];
  const nonArticle = (nonArticleRes.results as { link_uri: string }[]).map((r) => r.link_uri);
  const knownLinks = [...stored.map((r) => r.external_link_uri), ...nonArticle];
  const refreshing = new Set(pickRandom(knownLinks, POLL_REFRESH_SLICE));
  const skipLinks = new Set(knownLinks.filter((link) => !refreshing.has(link)));

  const snapshot = await snapshotBackedCollection(backing.provider, userDid, collectionUri, {
    skipLinks,
  });
  const now = Date.now();
  if (!snapshot.listingComplete && snapshot.members.length === 0 && snapshot.skipped.length === 0) {
    // No information — do NOT touch membership (Phase 2 invariant 1). Still record
    // the attempt so we don't re-hammer a failing PDS every single open.
    await env.DB.prepare(`UPDATE user_settings SET last_backing_poll = ? WHERE user_did = ?`)
      .bind(now, userDid)
      .run();
    return { polled: true, complete: false, memberCount: 0 };
  }

  // Tombstones: URLs just-unsaved locally whose foreign membership-delete may not
  // have propagated. Exclude them so a stale snapshot can't resurrect an unsave.
  // Drop expired tombstones up front (TTL backstop).
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

  const listed = new Set(snapshot.listed);
  const resolvedLinks = new Set(snapshot.members.map((m) => m.linkUri));
  // A re-checked link that came back as "not an article / gone" leaves; one that
  // failed transiently stays as it was.
  const unresolvable = new Set(
    snapshot.skipped.filter((s) => s.reason !== TRANSIENT_SKIP).map((s) => s.linkUri)
  );

  const batch: D1PreparedStatement[] = [];
  const drop = (link: string) =>
    batch.push(
      env.DB.prepare(
        `DELETE FROM backed_collection_members
         WHERE user_did = ? AND external_collection = ? AND external_link_uri = ?`
      ).bind(userDid, collectionUri, link)
    );

  // (1) Stored rows that leave: no longer listed (whole listing only), tombstoned,
  //     unresolvable on re-check, or re-resolved (rewritten below, possibly under a
  //     new URL).
  const kept = new Set<string>(); // url_normalized of stored rows that stay
  for (const r of stored) {
    const link = r.external_link_uri;
    const gone = snapshot.listingComplete && !listed.has(link);
    if (
      gone ||
      tombstoned.has(r.url_normalized) ||
      unresolvable.has(link) ||
      resolvedLinks.has(link)
    ) {
      drop(link);
    } else {
      kept.add(r.url_normalized);
    }
  }

  // (2) New and re-resolved members, deduped by the join key (the same article via
  //     two records collapses to one; a row already kept wins).
  const byKey = new Map<string, BackedMember>();
  for (const m of snapshot.members) {
    if (tombstoned.has(m.urlNormalized) || kept.has(m.urlNormalized)) continue;
    if (!byKey.has(m.urlNormalized)) byKey.set(m.urlNormalized, m);
  }
  const added = [...byKey.values()];
  for (const m of added) {
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_did, external_collection, url_normalized) DO UPDATE SET
           url = excluded.url, external_provider = excluded.external_provider,
           external_item_uri = excluded.external_item_uri,
           external_link_uri = excluded.external_link_uri, metadata = excluded.metadata`
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

  // (3) Merge-upsert a STUB enrichment row for each added member URL, seeded with
  //     whatever metadata the foreign record carried (title/author/etc) so the list
  //     shows a real title immediately. Never clobbers an existing row's body/labels
  //     (ON CONFLICT DO NOTHING); the body is filled by extractMissingBackedContent.
  for (const m of added) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO saved_articles
           (user_did, rkey, record_uri, url, url_normalized, url_key, title, author, description,
            image, content_type, source, item_guid, saved_at, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'webpage', 'url', ?, ?, ?)
         ON CONFLICT(user_did, url_normalized) DO NOTHING`
      ).bind(
        userDid,
        generateTid(),
        m.url,
        m.urlNormalized,
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

  // (4) Links that hold no article: remember new ones, so later polls skip them;
  //     forget one the whole listing no longer names, or that now resolved.
  for (const link of unresolvable) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO backed_skipped_links (user_did, external_collection, link_uri)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`
      ).bind(userDid, collectionUri, link)
    );
  }
  for (const link of nonArticle) {
    if ((snapshot.listingComplete && !listed.has(link)) || resolvedLinks.has(link)) {
      batch.push(
        env.DB.prepare(
          `DELETE FROM backed_skipped_links
           WHERE user_did = ? AND external_collection = ? AND link_uri = ?`
        ).bind(userDid, collectionUri, link)
      );
    }
  }

  // (5) Clear tombstones the snapshot confirms are gone upstream (the foreign delete
  //     landed); keep those still present (delete not yet propagated; the
  //     tombstone's TTL is the backstop). Only a complete snapshot can confirm absence.
  const complete = snapshot.complete;
  if (complete) {
    const present = new Set<string>([...kept, ...snapshot.members.map((m) => m.urlNormalized)]);
    for (const r of stored) {
      if (listed.has(r.external_link_uri)) present.add(r.url_normalized);
    }
    for (const key of tombstoned) {
      if (!present.has(key)) {
        batch.push(
          env.DB.prepare(
            `DELETE FROM backed_unsave_tombstones
             WHERE user_did = ? AND external_collection = ? AND url_normalized = ?`
          ).bind(userDid, collectionUri, key)
        );
      }
    }
  }

  // (6) Stamp the attempt time (the retry gate) and, on a complete snapshot, the
  //     successful-snapshot marker. The latter lets the read route distinguish a
  //     valid empty snapshot from an account whose first complete snapshot has
  //     never landed.
  batch.push(
    complete
      ? env.DB.prepare(
          `UPDATE user_settings
           SET last_backing_poll = ?, last_successful_backing_poll = ?
           WHERE user_did = ?`
        ).bind(now, now, userDid)
      : env.DB.prepare(`UPDATE user_settings SET last_backing_poll = ? WHERE user_did = ?`).bind(
          now,
          userDid
        )
  );

  await env.DB.batch(batch);
  return { polled: true, complete, memberCount: kept.size + added.length };
}

/** Up to `n` items picked at random, without replacement. */
function pickRandom<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const pool = [...items];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

interface MissingRow {
  id: number;
  url: string;
  url_normalized: string;
  title: string | null;
  /** Background failures so far (saved_extract_backoff). */
  attempts: number;
}

// How long a save whose page failed to extract waits before the next try, by
// failures so far. Past the last, it isn't tried again in the background.
const EXTRACT_BACKOFF_MS = [
  60 * 60 * 1000, // 1 hour
  6 * 60 * 60 * 1000, // 6 hours
  24 * 60 * 60 * 1000, // 1 day
  3 * 24 * 60 * 60 * 1000, // 3 days
];
const EXTRACT_GIVE_UP_AT = Number.MAX_SAFE_INTEGER;

// How long a pass holds a save it's extracting, so another pass (two Saved-list
// opens at once) leaves it be. It's also the wait after a failure that said
// nothing about the page (the proxy busy, a timeout), not counted against it:
// without one, every open retried the same failing pages straight away.
const EXTRACT_CLAIM_MS = 10 * 60 * 1000;

/** When to try a save's extraction again after its `attempts`-th failure. */
export function extractRetryAt(attempts: number, now = Date.now()): number {
  const wait = EXTRACT_BACKOFF_MS[attempts - 1];
  return wait === undefined ? EXTRACT_GIVE_UP_AT : now + wait;
}

/** A failure that says nothing about the page: the proxy busy, unreachable, timed out. */
function isTransientExtractFailure(err: unknown): boolean {
  return !(err instanceof FeedProxyError) || err.transient === true;
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
  // `background: false` when a reader is waiting on it (the eager fill at enable).
  opts: { limit?: number; background?: boolean } = {}
): Promise<number> {
  const limit = opts.limit ?? 20;
  const background = opts.background ?? true;
  // Backed enrichment rows still missing a body; content IS NULL = not yet extracted.
  // Scope to article-like saves only: a 'document' save's url is a resolved blogs URL
  // (not an extractable article) and a 'share' has no article body — extracting either
  // would fetch the wrong content AND hard-flip content_type to 'article' below.
  const rows = await env.DB.prepare(
    `SELECT s.id, s.url, s.url_normalized, s.title, COALESCE(b.attempts, 0) AS attempts
     FROM saved_articles s
     LEFT JOIN saved_extract_backoff b
       ON b.user_did = s.user_did AND b.url_normalized = s.url_normalized
     WHERE s.user_did = ? AND s.content IS NULL AND s.url != '' AND s.url_normalized IS NOT NULL
       AND s.source IN ('url', 'feed')
       AND (b.retry_at IS NULL OR b.retry_at <= ? OR (? AND b.attempts = 0))
     ORDER BY s.saved_at DESC LIMIT ?`
  )
    .bind(userDid, Date.now(), background ? 0 : 1, limit)
    .all<MissingRow>();
  if (rows.results.length === 0) return 0;

  const proxy = new FeedProxyClient(env);
  let filled = 0;
  // Small concurrency; the proxy itself caps and caches per URL. In the background
  // the proxy runs one at a time with two waiting, so two here keeps within that.
  const CONCURRENCY = background ? 2 : 4;
  // Set when the proxy sheds or can't be reached: the rest of the pass would
  // only be shed too, so it stops and a later pass picks up from here.
  let busy = false;
  const queue = [...rows.results];
  async function worker() {
    for (;;) {
      if (busy) return;
      const row = queue.shift();
      if (!row) return;
      // Claim it, unless another pass did since the read above. A reader
      // waiting on it (the fill at enable) takes it from a background pass, or
      // from a wait the proxy's trouble left; never from the page's own backoff.
      const now = Date.now();
      let claimed;
      try {
        claimed = await env.DB.prepare(
          `INSERT INTO saved_extract_backoff (user_did, url_normalized, attempts, retry_at)
           VALUES (?, ?, 0, ?)
           ON CONFLICT(user_did, url_normalized) DO UPDATE SET retry_at = excluded.retry_at
             WHERE saved_extract_backoff.retry_at <= ? OR (? AND saved_extract_backoff.attempts = 0)`
        )
          .bind(userDid, row.url_normalized, now + EXTRACT_CLAIM_MS, now, background ? 0 : 1)
          .run();
      } catch (err) {
        // D1 trouble: leave the rest for a later pass rather than fail the caller.
        log.warn('backed_extract_claim_failed', serializeError(err));
        busy = true;
        return;
      }
      if (!claimed.meta.changes) continue;
      let filledRow = false;
      try {
        const a = await proxy.extract(row.url, { userDid, background });
        // Set the body, COALESCE-fill metadata only where the stub lacked it (keep the
        // foreign-record title/author we already captured), and hard-set the type to
        // 'article' — these rows are only ever article-like saves (source IN url/feed).
        await fillExtractedContent(env, a, { id: row.id }, { url: row.url, setArticleType: true });
        filled++;
        filledRow = true;
      } catch (err) {
        const transient = isTransientExtractFailure(err);
        // With its message: the bare stack console.error printed for it named
        // the call site but never why the page failed.
        log.warn('backed_extract_failed', { url: row.url, transient, ...serializeError(err) });
        // Leave the row as-is (title + empty body). A failure that was ours (the
        // proxy busy or unreachable) keeps the claim's short wait, uncounted; one
        // that was the page's backs off, and after the last try it stops.
        if (!(err instanceof FeedProxyError) || err.unavailable) busy = true;
        if (!transient) {
          await env.DB.prepare(
            `INSERT INTO saved_extract_backoff (user_did, url_normalized, attempts, retry_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_did, url_normalized) DO UPDATE SET
               attempts = excluded.attempts, retry_at = excluded.retry_at`
          )
            .bind(userDid, row.url_normalized, row.attempts + 1, extractRetryAt(row.attempts + 1))
            .run()
            .catch((e) =>
              log.warn('backed_extract_backoff_write_failed', {
                url: row.url,
                ...serializeError(e),
              })
            );
        }
      }
      if (filledRow) {
        // Filled: nothing left to hold against the page. A row left by a failed
        // delete is harmless (the save has a body, so it's never selected).
        await env.DB.prepare(
          'DELETE FROM saved_extract_backoff WHERE user_did = ? AND url_normalized = ?'
        )
          .bind(userDid, row.url_normalized)
          .run()
          .catch(() => {});
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return filled;
}

/**
 * Unsave a backed save (Phase 4): remove the membership snapshot row AND write a
 * tombstone in one D1 step, then fire-and-forget the foreign membership delete. The
 * tombstone keeps the URL out of membership on later polls until a complete
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
  updatedAt: string | null;
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
  updated_at: number | null;
  edited_fields: string | null;
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
  // The card's metadata fills what the row lacks, except where the reader
  // cleared a field by hand: their empty is the answer.
  const fill = <T>(column: EditableColumn, own: T | null, card: T | undefined): T | null =>
    own ?? (isEdited(row.edited_fields, column) ? null : (card ?? null));
  return {
    rkey: row.rkey,
    // For a backed save there's no app.skyreader.feed.saved export — surface the
    // foreign item at-uri as the record handle instead of a synthesized one.
    uri: row.record_uri ?? row.external_item_uri,
    url,
    title: fill('title', row.title, meta.title),
    author: fill('author', row.author, meta.author),
    description: fill('description', row.description, meta.description),
    content: row.content,
    contentType: row.content_type || 'webpage',
    domain: row.domain ?? meta.domain ?? null,
    image: row.image ?? meta.image ?? null,
    wordCount: row.word_count,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    savedAt: new Date(row.saved_at ?? Date.now()).toISOString(),
    source: row.source || 'url',
    itemGuid: row.item_guid ?? meta.canonicalAtUri ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
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

  // (A) Every current member, joined to its enrichment row. Deliberately NOT
  // s.content: the only caller (GET /api/saved) strips the body before
  // responding — clients hydrate bodies via /api/saved/bodies — and selecting
  // it made D1 read every row's article-body blob just to discard it.
  const membersQ = env.DB.prepare(
    `SELECT m.url AS m_url, m.metadata AS m_metadata, m.external_item_uri,
            s.rkey, s.record_uri, s.url, s.title, s.author, s.description, NULL AS content,
            s.content_type, s.domain, s.image, s.word_count, s.published_at, s.saved_at,
            s.source, s.item_guid, s.updated_at, s.edited_fields
     FROM backed_collection_members m
     LEFT JOIN saved_articles s
       ON s.user_did = m.user_did AND s.url_normalized = m.url_normalized
     WHERE m.user_did = ? AND m.external_collection = ?`
  ).bind(userDid, collectionUri);

  // (B) Native-only enrichment rows not represented in this collection's membership
  //     (uploads, legacy saves yet to be exported). url_normalized NULL = legacy.
  const nativeQ = env.DB.prepare(
    `SELECT NULL AS m_url, NULL AS m_metadata, NULL AS external_item_uri,
            s.rkey, s.record_uri, s.url, s.title, s.author, s.description, NULL AS content,
            s.content_type, s.domain, s.image, s.word_count, s.published_at, s.saved_at,
            s.source, s.item_guid, s.updated_at, s.edited_fields
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
