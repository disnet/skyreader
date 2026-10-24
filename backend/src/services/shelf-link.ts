/**
 * Linked Shelf collections — a Shelf collection kept in step with one of the
 * reader's own Semble or Margin collections, both ways.
 *
 * This is the backed-saves machinery (services/backing/) scoped to one Shelf
 * collection instead of the whole Saved list, with one difference in shape. A
 * backed Saved list IS its foreign collection, so its membership is replaced
 * wholesale from each snapshot. A Shelf collection can't be: it has an order the
 * foreign side doesn't keep, and members the foreign side can't hold (uploads).
 * So the Shelf collection stays canonical and the two are reconciled by DIFF,
 * against a baseline of the membership records seen last time
 * (`shelf_link_members`):
 *
 *  - a record the listing names that isn't in the baseline was added over there:
 *    its article becomes a save (a stub, filled in by extraction) and joins the
 *    Shelf collection at the end;
 *  - a baseline record the listing no longer names was removed over there: its
 *    article leaves the Shelf collection (the save itself stays);
 *  - a baseline record still listed whose article is no longer in the Shelf
 *    collection was removed here: the membership record is deleted (never the
 *    card or note, which may sit in other collections);
 *  - a linkable member with no record at all was added here: one is written.
 *
 * The baseline row for a record we delete or write changes only once the PDS has
 * answered, so a failed write is simply tried again next time and no tombstones
 * are needed. Every foreign write goes through `reconcileShelfLink`, which holds
 * a per-collection lock, so two reconciles can't both write the same article.
 *
 * Reads are auth-free (the snapshot); writes use the reader's session. See
 * docs/plans/SHELF_PLAN.md ("Linked collections").
 */

import type { Env, Session } from '../types';
import { createPDSClient } from './pds-client';
import { snapshotBackedCollection, TRANSIENT_SKIP, type BackingProviderName } from './backing/read';
import { createMember, removeMember } from './backing/write';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { parseAtUri } from '../utils/canonical-url';
import { generateTid } from '../utils/tid';
import { lookupCollection } from './backing/room-sync';
import { backfillUrlNormalized } from './backing/enable';
import { MAX_ITEMS_PER_COLLECTION } from '../routes/shelf';

/** An unchanged, settled link is reconciled at most this often. */
export const LINK_SYNC_GATE_MS = 60_000;
/** A reconcile that dies holding the lock lets go after this. */
const LINK_LOCK_MS = 5 * 60_000;
/** How many times one reconcile goes round for changes made while it ran. Two
 *  keeps a reconcile, run in another request's `waitUntil`, inside that
 *  request's 1,000-subrequest cap. */
const MAX_ROUNDS = 2;
/**
 * A reconcile's fetch budget for the snapshot. Like a room's, small: the
 * baseline's records are listed but not resolved again, so a reconcile pays for
 * what changed, and a big first link fills in over a few.
 */
export const LINK_SNAPSHOT_SUBREQUESTS = 350;
/** Records written per reconcile (two writes each); the rest wait for the next. */
export const LINK_PUSH_LIMIT = 20;
/** Membership records deleted per reconcile. */
export const LINK_DELETE_LIMIT = 25;

export const SEMBLE_COLLECTION_NSID = 'network.cosmik.collection';
export const MARGIN_COLLECTION_NSID = 'at.margin.collection';

export function collectionNsidFor(provider: BackingProviderName): string {
  return provider === 'semble' ? SEMBLE_COLLECTION_NSID : MARGIN_COLLECTION_NSID;
}

export interface ShelfLink {
  provider: BackingProviderName;
  uri: string;
}

interface LinkRow {
  link_provider: string | null;
  link_uri: string | null;
  link_synced_at: number | null;
  link_dirty: number;
}

export async function readShelfLink(
  env: Env,
  did: string,
  collectionId: string
): Promise<(ShelfLink & { syncedAt: number | null; dirty: boolean }) | null> {
  const row = await env.DB.prepare(
    `SELECT link_provider, link_uri, link_synced_at, link_dirty
       FROM shelf_collections WHERE user_did = ? AND id = ?`
  )
    .bind(did, collectionId)
    .first<LinkRow>();
  if (!row?.link_uri || (row.link_provider !== 'semble' && row.link_provider !== 'margin')) {
    return null;
  }
  return {
    provider: row.link_provider,
    uri: row.link_uri,
    syncedAt: row.link_synced_at,
    dirty: row.link_dirty === 1,
  };
}

/** Take a collection's link off. Both sides keep what they hold. */
export async function unlinkShelfCollection(
  env: Env,
  did: string,
  collectionId: string
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shelf_link_members WHERE user_did = ? AND collection_id = ?').bind(
      did,
      collectionId
    ),
    env.DB.prepare(
      `UPDATE shelf_collections
          SET link_provider = NULL, link_uri = NULL, link_synced_at = NULL, link_dirty = 0,
              link_lock_until = NULL
        WHERE user_did = ? AND id = ?`
    ).bind(did, collectionId),
  ]);
}

export interface ReconcileStats {
  /** rkeys of saves that joined the Shelf collection from the other side */
  imported: string[];
  /** Shelf members taken out because they left the foreign collection */
  removed: number;
  /** membership records written for members added here */
  pushed: number;
  /** membership records deleted for members removed here */
  deleted: number;
  /** linkable members still without a record (left for the next reconcile) */
  pending: number;
  /** the snapshot saw the whole foreign collection */
  complete: boolean;
  /** the foreign collection was deleted, so the link was taken off */
  unlinked?: boolean;
}

export type ReconcileResult =
  | { synced: false; reason: 'not-linked' | 'gated' | 'locked' }
  | ({ synced: true } & ReconcileStats);

export interface ReconcileOptions {
  /** Run inside the gate (an explicit sync, a fresh link). The lock still applies. */
  force?: boolean;
  /** Override the snapshot's fetch budget (tests). */
  maxSubrequests?: number;
}

/**
 * Note a local change to a linked collection, so the next reconcile runs past
 * the gate and one already running goes round again. A no-op when unlinked.
 */
export async function markShelfLinkDirty(
  env: Env,
  did: string,
  collectionIds: string[]
): Promise<string[]> {
  if (collectionIds.length === 0) return [];
  const res = await env.DB.prepare(
    `UPDATE shelf_collections SET link_dirty = 1
      WHERE user_did = ? AND link_uri IS NOT NULL
        AND id IN (${collectionIds.map(() => '?').join(', ')})
      RETURNING id`
  )
    .bind(did, ...collectionIds)
    .all<{ id: string }>();
  return res.results.map((r) => r.id);
}

/**
 * Bring a linked Shelf collection and its foreign collection into step. Safe to
 * call from `waitUntil` and from several requests at once: a compare-and-set on
 * `link_lock_until` lets one through, and a change landing while it runs (which
 * sets `link_dirty`) sends it round again rather than being lost.
 */
export async function reconcileShelfLink(
  env: Env,
  session: Session,
  collectionId: string,
  opts: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const did = session.did;
  const link = await readShelfLink(env, did, collectionId);
  if (!link) return { synced: false, reason: 'not-linked' };
  const now = Date.now();
  if (!opts.force && !link.dirty && now - (link.syncedAt ?? 0) < LINK_SYNC_GATE_MS) {
    return { synced: false, reason: 'gated' };
  }

  // The lock's expiry doubles as this run's token: every later update is
  // conditional on it, so a run that outlived its lock can't let go of (or
  // carry on under) someone else's.
  let token = now + LINK_LOCK_MS + Math.floor(Math.random() * 1000);
  const claim = await env.DB.prepare(
    `UPDATE shelf_collections SET link_lock_until = ?, link_dirty = 0
      WHERE user_did = ? AND id = ? AND link_uri = ?
        AND (link_lock_until IS NULL OR link_lock_until < ?)`
  )
    .bind(token, did, collectionId, link.uri, now)
    .run();
  if (!claim.meta.changes) return { synced: false, reason: 'locked' };

  const total: ReconcileStats = {
    imported: [],
    removed: 0,
    pushed: 0,
    deleted: 0,
    pending: 0,
    complete: false,
  };
  const stillOurs = () => holdsLock(env, did, collectionId, link.uri, token);
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const stats = await reconcileOnce(env, session, collectionId, link, opts, stillOurs);
      total.imported.push(...stats.imported);
      total.removed += stats.removed;
      total.pushed += stats.pushed;
      total.deleted += stats.deleted;
      total.pending = stats.pending;
      total.complete = stats.complete;
      if (stats.unlinked) return { synced: true, ...total, unlinked: true };
      // Let go only if nothing changed while we ran; otherwise go round again.
      // Work left over that this run made progress on (more than one
      // reconcile's share) stays owed, so the next runs past the gate. Work
      // that made none (a write the PDS keeps refusing) waits for the gate.
      const owed = stats.pending > 0 && stats.pushed > 0 ? 1 : 0;
      const release = await env.DB.prepare(
        `UPDATE shelf_collections SET link_lock_until = NULL, link_synced_at = ?, link_dirty = ?
          WHERE user_did = ? AND id = ? AND link_lock_until = ? AND link_dirty = 0`
      )
        .bind(Date.now(), owed, did, collectionId, token)
        .run();
      if (release.meta.changes) return { synced: true, ...total };
      const next = Date.now() + LINK_LOCK_MS + Math.floor(Math.random() * 1000);
      const renew = await env.DB.prepare(
        `UPDATE shelf_collections SET link_dirty = 0, link_lock_until = ?
          WHERE user_did = ? AND id = ? AND link_uri = ? AND link_lock_until = ?`
      )
        .bind(next, did, collectionId, link.uri, token)
        .run();
      // Lost the lock (it expired, or the link changed): someone else owns it now.
      if (!renew.meta.changes) return { synced: true, ...total };
      token = next;
    }
    // Still changing after a few rounds: leave it dirty for the next reconcile.
    await letGo(env, did, collectionId, token);
    return { synced: true, ...total };
  } catch (err) {
    // Let go, and keep the change owed so the next reconcile picks it up.
    await letGo(env, did, collectionId, token);
    throw err;
  }
}

async function letGo(env: Env, did: string, collectionId: string, token: number) {
  await env.DB.prepare(
    `UPDATE shelf_collections SET link_lock_until = NULL, link_dirty = 1
      WHERE user_did = ? AND id = ? AND link_lock_until = ?`
  )
    .bind(did, collectionId, token)
    .run();
}

/** Whether this run still holds the lock on the same link — checked before
 *  each phase that writes, so an unlink, relink or delete stops it there. */
async function holdsLock(
  env: Env,
  did: string,
  collectionId: string,
  uri: string,
  token: number
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM shelf_collections
      WHERE user_did = ? AND id = ? AND link_uri = ? AND link_lock_until = ?`
  )
    .bind(did, collectionId, uri, token)
    .first();
  return row !== null;
}

interface BaselineRow {
  link_uri: string;
  item_uri: string;
  url_normalized: string | null;
}

interface MemberRow {
  saved_rkey: string;
  url: string | null;
  url_normalized: string | null;
  source: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  published_at: number | null;
  item_guid: string | null;
  id: number | null;
}

/** The join key for a Shelf member's save, or null if it can't go over there. */
function linkableKey(m: MemberRow): string | null {
  if (m.id === null || !m.url || m.source === 'upload') return null;
  return m.url_normalized ?? normalizeArticleUrl(m.url);
}

async function reconcileOnce(
  env: Env,
  session: Session,
  collectionId: string,
  link: ShelfLink,
  opts: ReconcileOptions,
  stillOurs: () => Promise<boolean>
): Promise<ReconcileStats> {
  const did = session.did;
  const now = Date.now();
  const stats: ReconcileStats = {
    imported: [],
    removed: 0,
    pushed: 0,
    deleted: 0,
    pending: 0,
    complete: false,
  };

  const baselineRes = await env.DB.prepare(
    `SELECT link_uri, item_uri, url_normalized FROM shelf_link_members
      WHERE user_did = ? AND collection_id = ? AND external_collection = ?`
  )
    .bind(did, collectionId, link.uri)
    .all<BaselineRow>();
  const baseline = baselineRes.results;

  const snapshot = await snapshotBackedCollection(link.provider, did, link.uri, {
    skipLinks: new Set(baseline.map((b) => b.link_uri)),
    maxSubrequests: opts.maxSubrequests ?? LINK_SNAPSHOT_SUBREQUESTS,
  });
  stats.complete = snapshot.complete;
  const listed = new Set(snapshot.listed);
  // Nothing listed and the listing is short: the PDS didn't answer. No information.
  if (!snapshot.listingComplete && listed.size === 0) return stats;

  // Everything we knew of is gone at once. That is either a reader who emptied
  // the collection, or a collection that was deleted, and only the second
  // should not empty the Shelf collection: a deleted one unlinks instead.
  if (listed.size === 0 && baseline.some((b) => b.url_normalized)) {
    let lookup;
    try {
      lookup = await lookupCollection(link.uri);
    } catch (err) {
      console.error('[shelf-link] could not check the linked collection:', err);
      return stats;
    }
    if (!lookup.ok) {
      if (lookup.reason === 'not-found' && (await stillOurs())) {
        await unlinkShelfCollection(env, did, collectionId);
        stats.unlinked = true;
      }
      return stats;
    }
  }

  // Saves made since the link was set up may not be keyed yet; key them before
  // anything new comes in, or an article already saved would be saved twice.
  if (snapshot.members.length > 0) await backfillUrlNormalized(env, did);

  // What the foreign collection holds now, by article: baseline records it still
  // lists (all of them when the listing is short, since an unlisted one may only
  // be past where it stopped), plus what the snapshot resolved afresh.
  const stillThere = baseline.filter((b) => !snapshot.listingComplete || listed.has(b.link_uri));
  const leftThere = snapshot.listingComplete ? baseline.filter((b) => !listed.has(b.link_uri)) : [];
  const upstream = new Set<string>();
  for (const b of stillThere) if (b.url_normalized) upstream.add(b.url_normalized);
  for (const m of snapshot.members) upstream.add(m.urlNormalized);

  const membersRes = await env.DB.prepare(
    `SELECT i.saved_rkey, s.id, s.url, s.url_normalized, s.source, s.title, s.author,
            s.description, s.published_at, s.item_guid
       FROM shelf_collection_items i
       LEFT JOIN saved_articles s ON s.user_did = i.user_did AND s.rkey = i.saved_rkey
      WHERE i.user_did = ? AND i.collection_id = ?
      ORDER BY i.position ASC, i.added_at ASC`
  )
    .bind(did, collectionId)
    .all<MemberRow>();
  const members = membersRes.results;
  const here = new Map<string, MemberRow[]>();
  for (const m of members) {
    const key = linkableKey(m);
    if (!key) continue;
    const list = here.get(key);
    if (list) list.push(m);
    else here.set(key, [m]);
  }

  const statements: D1PreparedStatement[] = [];

  // (1) Removed over there: an article whose every record has left takes its
  // Shelf members with it. One still held by another record stays.
  const goneKeys = new Set<string>();
  for (const b of leftThere) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM shelf_link_members WHERE user_did = ? AND collection_id = ? AND link_uri = ?`
      ).bind(did, collectionId, b.link_uri)
    );
    if (b.url_normalized && !upstream.has(b.url_normalized)) goneKeys.add(b.url_normalized);
  }
  const goneRkeys: string[] = [];
  for (const key of goneKeys) {
    for (const m of here.get(key) ?? []) goneRkeys.push(m.saved_rkey);
    here.delete(key);
  }
  if (goneRkeys.length > 0) {
    stats.removed = goneRkeys.length;
    statements.push(
      env.DB.prepare(
        `DELETE FROM shelf_collection_items
          WHERE user_did = ?1 AND collection_id = ?2
            AND saved_rkey IN (SELECT value FROM json_each(?3))`
      ).bind(did, collectionId, JSON.stringify(goneRkeys))
    );
  }

  // (2) Added over there: each new record joins the baseline, and an article not
  // already in the Shelf collection becomes a save (a stub, if new to the reader)
  // and a member at the end, oldest addition first. Past the collection's cap a
  // record is left out of the baseline too, so it isn't then read as removed here.
  let room = Math.max(0, MAX_ITEMS_PER_COLLECTION - (members.length - goneRkeys.length));
  const importing = new Set<string>();
  const nextPosition = await env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM shelf_collection_items
      WHERE user_did = ? AND collection_id = ?`
  )
    .bind(did, collectionId)
    .first<{ next: number }>();
  let position = nextPosition?.next ?? 0;
  const importedKeys: string[] = [];
  for (const m of snapshot.members) {
    const key = m.urlNormalized;
    const inShelf = here.has(key) || importing.has(key);
    if (!inShelf) {
      if (room <= 0) {
        console.warn('[shelf-link] collection full; left a foreign member out', {
          collectionId,
          linkUri: m.linkUri,
        });
        continue;
      }
      room--;
      importing.add(key);
      importedKeys.push(key);
      statements.push(
        env.DB.prepare(
          `INSERT INTO saved_articles
             (user_did, rkey, record_uri, url, url_normalized, url_key, title, author, description,
              image, content_type, source, item_guid, saved_at, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'webpage', 'url', ?, ?, ?)
           ON CONFLICT(user_did, url_normalized) DO NOTHING`
        ).bind(
          did,
          generateTid(),
          m.url,
          key,
          key,
          m.title ?? null,
          m.author ?? null,
          m.description ?? null,
          m.image ?? null,
          m.canonicalAtUri ?? null,
          now,
          now
        ),
        env.DB.prepare(
          `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
           SELECT ?1, ?2, rkey, ?3, ?4 FROM saved_articles
            WHERE user_did = ?1 AND url_normalized = ?5
           ON CONFLICT(user_did, collection_id, saved_rkey) DO NOTHING`
        ).bind(did, collectionId, position++, Math.floor(now / 1000), key)
      );
    }
    statements.push(
      baselineInsert(env, did, collectionId, link.uri, m.linkUri, m.itemUri, key, now)
    );
  }
  // Records that resolved to something that isn't an article: remembered so
  // they aren't fetched again, never shown.
  for (const s of snapshot.skipped) {
    if (s.reason === TRANSIENT_SKIP) continue;
    statements.push(
      baselineInsert(env, did, collectionId, link.uri, s.linkUri, s.itemUri ?? '', null, now)
    );
  }
  if (!(await stillOurs())) return stats;
  if (statements.length > 0) await runChunked(env, statements);

  if (importedKeys.length > 0) {
    const rows = await env.DB.prepare(
      `SELECT rkey FROM saved_articles
        WHERE user_did = ? AND url_normalized IN (SELECT value FROM json_each(?))`
    )
      .bind(did, JSON.stringify(importedKeys))
      .all<{ rkey: string }>();
    stats.imported = rows.results.map((r) => r.rkey);
  }

  // From here on, writes to the reader's repo.
  const pds = createPDSClient(session);

  // (3) Removed here: a record still listed for an article no longer in the
  // Shelf collection. Delete the membership record only; its baseline row goes
  // once the PDS says so, so a failed delete is retried next time.
  const toDelete = stillThere.filter(
    (b) => b.url_normalized && !here.has(b.url_normalized) && listed.has(b.link_uri)
  );
  if (toDelete.length > 0 && !(await stillOurs())) return stats;
  for (const b of toDelete.slice(0, LINK_DELETE_LIMIT)) {
    try {
      await removeMember(pds, link.provider, { linkUri: b.link_uri });
    } catch (err) {
      console.error('[shelf-link] membership delete failed (retried next time):', err);
      continue;
    }
    await env.DB.prepare(
      `DELETE FROM shelf_link_members WHERE user_did = ? AND collection_id = ? AND link_uri = ?`
    )
      .bind(did, collectionId, b.link_uri)
      .run();
    stats.deleted++;
  }

  // (4) Added here: a linkable member the foreign collection has no record of.
  // Only on a complete snapshot: a record we couldn't resolve this time might be
  // this very article, and writing it again would duplicate it there.
  const toPush: MemberRow[] = [];
  for (const [key, list] of here) {
    if (!upstream.has(key)) toPush.push(list[0]);
  }
  if (!snapshot.complete) {
    stats.pending = toPush.length;
    return stats;
  }
  if (toPush.length > 0 && !(await stillOurs())) return stats;
  let collectionCid: string | undefined;
  if (link.provider === 'semble' && toPush.length > 0) {
    const ref = parseAtUri(link.uri);
    const res = ref ? await pds.getRecord(ref.collection, ref.rkey) : null;
    if (!res?.success) {
      console.error('[shelf-link] could not read the linked collection; pushes wait');
      stats.pending = toPush.length;
      return stats;
    }
    collectionCid = res.data.cid;
  }
  for (const m of toPush.slice(0, LINK_PUSH_LIMIT)) {
    const key = linkableKey(m)!;
    let handles;
    try {
      handles = await createMember(
        pds,
        did,
        link.provider,
        link.uri,
        {
          url: m.url!,
          title: m.title || undefined,
          description: m.description || undefined,
          author: m.author || undefined,
          publishedAt: m.published_at ? new Date(m.published_at).toISOString() : undefined,
          canonicalAtUri: m.source === 'document' ? m.item_guid || undefined : undefined,
        },
        { collectionCid }
      );
    } catch (err) {
      console.error(`[shelf-link] write failed for ${m.url} (retried next time):`, err);
      continue;
    }
    await env.DB.batch([
      baselineInsert(env, did, collectionId, link.uri, handles.linkUri, handles.itemUri, key, now),
      // Key the save for the next join, as the backing export does: only if unset,
      // and never onto a key another save already holds.
      env.DB.prepare(
        `UPDATE saved_articles SET url_normalized = ?1 WHERE id = ?2 AND url_normalized IS NULL
           AND NOT EXISTS (SELECT 1 FROM saved_articles WHERE user_did = ?3 AND url_normalized = ?1)`
      ).bind(key, m.id, did),
    ]);
    stats.pushed++;
  }
  stats.pending = toPush.length - stats.pushed;
  return stats;
}

function baselineInsert(
  env: Env,
  did: string,
  collectionId: string,
  externalCollection: string,
  linkUri: string,
  itemUri: string,
  urlNormalized: string | null,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR REPLACE INTO shelf_link_members
       (user_did, collection_id, external_collection, link_uri, item_uri, url_normalized, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(did, collectionId, externalCollection, linkUri, itemUri, urlNormalized, now);
}

const BATCH_CHUNK = 100;

async function runChunked(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await env.DB.batch(statements.slice(i, i + BATCH_CHUNK));
  }
}
