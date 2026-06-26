/**
 * External-backed saves — Phase 5 enable/disable + one-time export of existing
 * native saves. See docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md (Phase 5).
 *
 * Enable = pick (or create) a foreign collection, write the `backing` setting,
 * backfill the membership snapshot, and (optionally) export existing native saves
 * into the collection so the Saved list is whole from day one. Disable = revert to
 * the native engine; the foreign records are the user's data and are LEFT IN PLACE.
 */

import type { Env, Session } from '../../types';
import { createPDSClient } from '../pds-client';
import { normalizeArticleUrl } from '../../utils/url-normalize';
import { serializeBacking, type SaveBacking } from '../../routes/settings';
import { createCollection, createMember, listCollectionNames } from './write';
import { pollBackedMembership, extractMissingBackedContent } from './sync';
import type { BackingProviderName } from './read';

const DEFAULT_COLLECTION_NAME = 'Skyreader Saves';

/**
 * Pick a collection name that doesn't collide (case-insensitively) with any the user
 * already has. Returns `base` if it's free, else `base 2`, `base 3`, … The cap is a
 * safety backstop against a pathological repo — it won't be hit in practice.
 */
export function uniqueCollectionName(base: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${existing.length + 1}`;
}

export interface EnableResult {
  backing: SaveBacking;
  /** number of existing native saves exported into the collection (0 if not requested) */
  exported: number;
}

/**
 * Turn on backing. If `collectionUri` is omitted, create a default "Skyreader Saves"
 * collection. Writes the setting, backfills membership, and optionally exports the
 * user's existing native saves into the collection (idempotent — dedups by URL).
 */
export async function enableBacking(
  env: Env,
  session: Session,
  opts: { provider: BackingProviderName; collectionUri?: string; exportExisting?: boolean }
): Promise<EnableResult> {
  const pds = createPDSClient(session);

  // Reuse an existing collection, or create a fresh one. When creating, dedup the
  // name against the user's existing collections so toggling backing off then on (or
  // any prior "Skyreader Saves") doesn't pile up identically-named collections —
  // suffix " 2", " 3", … until it's unique.
  let collectionUri = opts.collectionUri;
  if (!collectionUri) {
    const existing = await listCollectionNames(pds, opts.provider);
    const name = uniqueCollectionName(DEFAULT_COLLECTION_NAME, existing);
    const created = await createCollection(pds, opts.provider, name);
    collectionUri = created.uri;
  }

  const backing: Extract<SaveBacking, { provider: 'semble' | 'margin' }> = {
    provider: opts.provider,
    collectionUri,
  };

  // Persist the setting first so the poll/export paths see backing as on. Reset the
  // poll gate so the immediate backfill isn't skipped.
  await env.DB.prepare(
    `INSERT INTO user_settings (user_did, backing, last_backing_poll, updated_at)
     VALUES (?, ?, NULL, unixepoch())
     ON CONFLICT(user_did) DO UPDATE SET backing = excluded.backing, last_backing_poll = NULL, updated_at = unixepoch()`
  )
    .bind(session.did, serializeBacking(backing))
    .run();

  // Key the existing native saves on url_normalized BEFORE the poll. Otherwise a
  // legacy save (url_normalized NULL) and the same URL arriving from the collection
  // key differently: the poll's stub upsert can't collapse onto the legacy row, so it
  // creates a second enrichment row and the Saved list shows the article twice.
  await backfillUrlNormalized(env, session.did);

  // Backfill the membership snapshot from the collection's current contents.
  const poll = await pollBackedMembership(env, session.did, backing, { force: true });

  // Eagerly extract bodies/titles for the freshly imported stubs BEFORE returning.
  // On a normal Saved-list open this fills in post-response via ctx.waitUntil, but at
  // enable the frontend reloads the Saved list immediately — so the empty stubs (a
  // community-bookmark record carries no metadata at all) would render and get cached
  // in IndexedDB before the deferred extraction ran, showing wrong titles/content until
  // a manual refresh. Bounded so a large collection still returns promptly; the tail
  // fills progressively across later opens, as designed.
  if (poll.complete && poll.memberCount > 0) {
    await extractMissingBackedContent(env, session.did, {
      limit: Math.min(poll.memberCount, 50),
    });
  }

  let exported = 0;
  if (opts.exportExisting) {
    exported = (await exportNativeSaves(env, session, backing)).exported;
  }

  return { backing, exported };
}

/**
 * Turn off backing. Reverts to the native engine and CLEARS the local membership
 * snapshot + tombstones (the saved_articles enrichment rows remain — they're the
 * canonical saves and the native read path serves them). The foreign collection and
 * its cards/notes are the user's data and are never touched.
 */
export async function disableBacking(env: Env, session: Session): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE user_settings SET backing = 'skyreader', last_backing_poll = NULL, updated_at = unixepoch()
       WHERE user_did = ?`
    ).bind(session.did),
    env.DB.prepare(`DELETE FROM backed_collection_members WHERE user_did = ?`).bind(session.did),
    env.DB.prepare(`DELETE FROM backed_unsave_tombstones WHERE user_did = ?`).bind(session.did),
  ]);
}

/**
 * Backfill `url_normalized` on the user's native saves so the dedup index
 * (user_did, url_normalized) can collapse a legacy save with the same URL arriving
 * from the backing collection. Runs at enable time, before the first poll.
 *
 * Collision-safe: the unique index forbids two rows sharing a key, so if two legacy
 * rows normalize to the SAME url (e.g. the same article saved twice with different
 * tracking params) only the first is keyed — the other stays a pre-existing native
 * duplicate, left untouched rather than failing the whole backfill.
 */
export async function backfillUrlNormalized(env: Env, did: string): Promise<number> {
  const rows = await env.DB.prepare(
    // ORDER BY id so which of two same-URL duplicates gets keyed is deterministic
    // (the lowest id wins) rather than depending on the query planner's index choice.
    `SELECT id, url, url_normalized FROM saved_articles WHERE user_did = ? AND url != '' ORDER BY id`
  )
    .bind(did)
    .all<{ id: number; url: string; url_normalized: string | null }>();

  // Keys already taken (rows previously keyed) — never collide with them.
  const taken = new Set<string>();
  for (const r of rows.results) {
    if (r.url_normalized) taken.add(r.url_normalized);
  }

  const updates: D1PreparedStatement[] = [];
  for (const r of rows.results) {
    if (r.url_normalized) continue;
    const normalized = normalizeArticleUrl(r.url);
    if (!normalized || taken.has(normalized)) continue;
    taken.add(normalized);
    updates.push(
      env.DB.prepare(
        `UPDATE saved_articles SET url_normalized = ? WHERE id = ? AND url_normalized IS NULL`
      ).bind(normalized, r.id)
    );
  }
  if (updates.length > 0) await env.DB.batch(updates);
  return updates.length;
}

interface NativeSaveRow {
  id: number;
  rkey: string;
  url: string;
  url_normalized: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  published_at: number | null;
  source: string;
  item_guid: string | null;
}

/** Count the user's native saves eligible for export (the export progress denominator). */
export async function countExportableSaves(env: Env, did: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM saved_articles WHERE user_did = ? AND url IS NOT NULL AND url != ''`
  )
    .bind(did)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface ExportBatchResult {
  /** newly-created foreign records in this call (skips/dups not counted) */
  exported: number;
  /** candidate rows examined in this call — the offset advances by this, always */
  scanned: number;
}

/**
 * Export existing native saves into the backing collection. Idempotent: dedups
 * against the collection's CURRENT membership (so a save already there — from this
 * app, another app, or a prior run — is not re-created). Each export creates the
 * foreign records and records the membership; the enrichment row stays canonical.
 *
 * Pass `{ offset, limit }` to process one stable slice of the candidate list (ordered
 * by id) so the frontend can drive the export in batches and show progress. The offset
 * advances by `scanned` (rows examined), never by `exported`, so a save that fails or
 * is already backed still moves the cursor forward — no batch can loop forever. Omit
 * the slice to export everything in one pass (the enable-time inline path).
 */
export async function exportNativeSaves(
  env: Env,
  session: Session,
  backing: Extract<SaveBacking, { provider: 'semble' | 'margin' }>,
  opts: { offset?: number; limit?: number } = {}
): Promise<ExportBatchResult> {
  const pds = createPDSClient(session);

  // What's already in the collection (membership was just backfilled by the caller).
  const existing = await env.DB.prepare(
    `SELECT url_normalized FROM backed_collection_members WHERE user_did = ? AND external_collection = ?`
  )
    .bind(session.did, backing.collectionUri)
    .all<{ url_normalized: string }>();
  const alreadyBacked = new Set(existing.results.map((r) => r.url_normalized));

  // Candidate native saves: anything with a real web URL (url/feed/document). Ordered
  // by id so an offset slice is stable across batch calls (exporting writes membership,
  // not saved_articles, so this set and its order don't shift between batches).
  const slice =
    opts.limit !== undefined
      ? ` LIMIT ${Math.max(0, opts.limit)} OFFSET ${Math.max(0, opts.offset ?? 0)}`
      : '';
  const rows = await env.DB.prepare(
    `SELECT id, rkey, url, url_normalized, title, author, description, published_at, source, item_guid
     FROM saved_articles
     WHERE user_did = ? AND url IS NOT NULL AND url != ''
     ORDER BY id${slice}`
  )
    .bind(session.did)
    .all<NativeSaveRow>();

  let exported = 0;
  for (const row of rows.results) {
    const normalized = row.url_normalized ?? normalizeArticleUrl(row.url);
    if (!normalized || alreadyBacked.has(normalized)) continue;
    alreadyBacked.add(normalized); // guard against dup URLs within this batch

    const canonicalAtUri = row.source === 'document' ? row.item_guid || undefined : undefined;
    let handles;
    try {
      handles = await createMember(pds, session.did, backing.provider, backing.collectionUri, {
        url: row.url,
        title: row.title || undefined,
        description: row.description || undefined,
        author: row.author || undefined,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : undefined,
        canonicalAtUri,
      });
    } catch (err) {
      console.error(`[backing] export failed for ${row.url}:`, err);
      continue; // best-effort — one failure doesn't abort the whole export
    }

    const metadata = JSON.stringify({
      title: row.title,
      author: row.author,
      description: row.description,
      canonicalAtUri,
    });
    await env.DB.batch([
      // Backfill the join key on the enrichment row. No-op if already set, and
      // collision-safe: if a DIFFERENT same-URL row already holds this key (a
      // pre-existing native duplicate), leave this row untouched rather than
      // tripping the unique (user_did, url_normalized) index. The loop's
      // alreadyBacked guard still collapses the duplicate to a single member.
      env.DB.prepare(
        `UPDATE saved_articles SET url_normalized = ? WHERE id = ? AND url_normalized IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM saved_articles WHERE user_did = ? AND url_normalized = ?
           )`
      ).bind(normalized, row.id, session.did, normalized),
      env.DB.prepare(
        `INSERT INTO backed_collection_members
           (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_did, external_collection, url_normalized) DO UPDATE SET
           external_item_uri = excluded.external_item_uri,
           external_link_uri = excluded.external_link_uri,
           metadata = excluded.metadata`
      ).bind(
        session.did,
        backing.collectionUri,
        normalized,
        row.url,
        backing.provider,
        handles.itemUri,
        handles.linkUri,
        metadata
      ),
    ]);
    exported++;
  }

  return { exported, scanned: rows.results.length };
}
