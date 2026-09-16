/**
 * Reading Rooms — the materialized room list (D1) and the poll that keeps it.
 *
 * A room IS a Semble/Margin collection, read through the same auth-free path as
 * backed saves (`snapshotBackedCollection`, with everyone's contributions via
 * `includeForeign`). That read costs one or two fetches per article, which is
 * fine once and ruinous on every open: the room endpoint answers signed-out
 * visitors, and a Worker invocation caps outbound fetches at 1000, so a busy
 * room could not be read at all. This module gives the room the shape backed
 * saves already have — serve the last snapshot from D1, refresh behind the
 * response — with one addition: the refresh is INCREMENTAL.
 *
 * `room_members` keeps one row per membership record, keyed by the record's own
 * at-uri. A poll lists the membership (a few pages, cheap), hands the stored
 * link uris to the snapshot as `skipLinks`, and only resolves what it has not
 * seen; links the listing no longer names are deleted, but only when the
 * listing is provably whole. A room too big for one poll's budget fills in over
 * several: each stores what it resolved, and `complete` stays false until every
 * listed link has a row.
 *
 * Reads counts (`room_reads`) are untouched: still private, still aggregate.
 * See docs/plans/READING_ROOMS_SPIKE.md ("Materialized rooms").
 */

import type { Env } from '../../types';
import { parseAtUri } from '../../utils/canonical-url';
import { resolvePdsUrl } from '../../utils/did-resolver';
import {
  getRecordPublicWithCid,
  snapshotBackedCollection,
  sortByAddedAt,
  TRANSIENT_SKIP,
  type BackedMember,
  type BackingProviderName,
} from './read';

/**
 * A poll's fetch budget. Small on purpose: a poll resolves only what changed, so
 * the allowance is for the FIRST look at a room (or a burst of additions), and
 * whatever does not fit is picked up by the next poll a few seconds later. It
 * also runs inside a reader's request (in `waitUntil`, or inline for a room we
 * have never seen), which has its own D1 work to fit under the cap.
 */
export const ROOM_SNAPSHOT_SUBREQUESTS = 400;

/** A complete room is refreshed at most this often. Rooms change on the scale of
 *  someone adding an article, not minute to minute; the page paints from its own
 *  cache first anyway. */
export const ROOM_POLL_GATE_MS = 60_000;

/** An incomplete room (a first look that ran out of budget, a member that failed
 *  transiently) is retried this soon, so a big room fills in across the reader's
 *  next few opens rather than one a minute. The gate then grows with how long the
 *  room has stayed incomplete (see `roomNeedsPoll`), because some rooms never
 *  finish: a contributor whose repo is gone leaves a listed link that no poll
 *  can ever give a row. */
export const ROOM_CONTINUE_GATE_MS = 5_000;

/** How fast the incomplete gate grows: one tenth of the time the room has been
 *  incomplete, so a room still filling in after ten minutes polls like a complete
 *  one, and never slower than that. */
const ROOM_CONTINUE_BACKOFF_DIVISOR = 10;

/**
 * A row written this recently is not deleted for being absent from the listing.
 *
 * `POST /api/rooms/items` writes a contributor's new article straight into the
 * table, and the only way that link reaches a later listing is through
 * Constellation, which indexes on its own schedule. A poll landing in that gap
 * would see a whole listing that does not name the row and take the article
 * back out — until Constellation caught up and a poll re-resolved it from
 * scratch. Rows older than this have had every chance to be indexed, so an
 * absence then is a departure.
 */
export const ROOM_DELETE_GRACE_MS = 10 * 60_000;

/**
 * Stored item metadata goes stale — a Semble card's title can be edited — so
 * rows older than this are re-resolved, a slice per poll, so a large room's
 * rows ageing out together cost a bounded amount per poll rather than the whole
 * budget at once.
 */
export const ROOM_MEMBER_TTL_MS = 7 * 24 * 60 * 60_000;
export const ROOM_REFRESH_SLICE = 25;

/** D1 batches are chunked so a big first snapshot does not become one enormous
 *  transaction. The order inside a poll is what keeps this safe: member rows land
 *  first, the room's own row (with `complete`) last. */
const BATCH_CHUNK = 100;

export function providerForCollection(nsid: string): BackingProviderName | null {
  if (nsid === 'network.cosmik.collection') return 'semble';
  if (nsid === 'at.margin.collection') return 'margin';
  return null;
}

export interface ResolvedCollection {
  ref: { did: string; collection: string; rkey: string };
  provider: BackingProviderName;
  record: Record<string, unknown>;
  cid: string;
}

export type CollectionLookup =
  | { ok: true; collection: ResolvedCollection }
  | { ok: false; reason: 'invalid' | 'unsupported' | 'unresolvable' | 'not-found' };

/** Fetch a room's collection record from its owner's PDS (auth-free). Throws on
 *  a transient PDS failure, like the read path it sits on. */
export async function lookupCollection(uri: string): Promise<CollectionLookup> {
  const ref = parseAtUri(uri);
  if (!ref) return { ok: false, reason: 'invalid' };
  const provider = providerForCollection(ref.collection);
  if (!provider) return { ok: false, reason: 'unsupported' };
  const pds = await resolvePdsUrl(ref.did);
  if (!pds) return { ok: false, reason: 'unresolvable' };
  const record = await getRecordPublicWithCid(pds, ref.did, ref.collection, ref.rkey);
  if (!record) return { ok: false, reason: 'not-found' };
  return { ok: true, collection: { ref, provider, record: record.value, cid: record.cid } };
}

export interface RoomRow {
  collectionUri: string;
  provider: BackingProviderName;
  ownerDid: string;
  name?: string;
  description?: string;
  record: Record<string, unknown>;
  cid: string;
  complete: boolean;
  lastPollAt: number;
  lastCompleteAt: number | null;
  createdAt: number;
}

interface RoomDbRow {
  collection_uri: string;
  provider: string;
  owner_did: string;
  name: string | null;
  description: string | null;
  record: string;
  cid: string;
  complete: number;
  last_poll_at: number;
  last_complete_at: number | null;
  created_at: number;
}

function toRoomRow(r: RoomDbRow): RoomRow {
  let record: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.record) as unknown;
    if (parsed && typeof parsed === 'object') record = parsed as Record<string, unknown>;
  } catch {
    // A row we wrote ourselves; an unparseable record reads as an empty one.
  }
  return {
    collectionUri: r.collection_uri,
    provider: r.provider as BackingProviderName,
    ownerDid: r.owner_did,
    name: r.name ?? undefined,
    description: r.description ?? undefined,
    record,
    cid: r.cid,
    complete: r.complete === 1,
    lastPollAt: r.last_poll_at,
    lastCompleteAt: r.last_complete_at,
    createdAt: r.created_at,
  };
}

export async function readRoomRow(env: Env, uri: string): Promise<RoomRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM room_snapshots WHERE collection_uri = ?`)
    .bind(uri)
    .first<RoomDbRow>();
  return row ? toRoomRow(row) : null;
}

/** A trimmed non-empty string, or undefined — blank and absent are the same thing. */
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * Record a room we are seeing for the first time. Idempotent: two visitors
 * arriving together both call this, one row results, and each then tries to
 * claim the first poll (see `pollRoom`'s lock).
 */
export async function ensureRoomRow(env: Env, collection: ResolvedCollection): Promise<void> {
  const uri = `at://${collection.ref.did}/${collection.ref.collection}/${collection.ref.rkey}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO room_snapshots
       (collection_uri, provider, owner_did, name, description, record, cid, complete,
        last_poll_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  )
    .bind(
      uri,
      collection.provider,
      collection.ref.did,
      str(collection.record.name) ?? null,
      str(collection.record.description) ?? null,
      JSON.stringify(collection.record),
      collection.cid,
      Date.now()
    )
    .run();
}

/**
 * Is this room due a refresh? A complete room waits the full gate. An incomplete
 * one is retried fast at first — that is how a big room fills in across a
 * reader's next few opens — and then progressively slower, measured from the
 * last time it WAS complete (or from when we first saw it), up to the complete
 * gate. So a room that can never finish, because one listed link points into a
 * repo that no longer answers, settles at one poll a minute rather than one
 * every five seconds for as long as anyone keeps opening it.
 */
export function roomNeedsPoll(row: RoomRow, now = Date.now()): boolean {
  let gate = ROOM_POLL_GATE_MS;
  if (!row.complete) {
    const incompleteFor = now - (row.lastCompleteAt ?? row.createdAt);
    gate = Math.min(
      ROOM_POLL_GATE_MS,
      Math.max(ROOM_CONTINUE_GATE_MS, incompleteFor / ROOM_CONTINUE_BACKOFF_DIVISOR)
    );
  }
  return now - row.lastPollAt >= gate;
}

/** One stored member, as the room renders it. */
export interface StoredRoomMember {
  linkUri: string;
  itemUri: string;
  url: string;
  urlNormalized: string;
  itemType: string;
  title?: string;
  author?: string;
  description?: string;
  image?: string;
  addedAt?: string;
}

interface MemberMetadata {
  title?: string;
  author?: string;
  description?: string;
  image?: string;
}

interface MemberDbRow {
  link_uri: string;
  item_uri: string;
  url: string;
  url_normalized: string;
  item_type: string | null;
  metadata: string | null;
  added_at: string | null;
}

/** The room's articles, oldest addition first (see `sortByAddedAt`). Rows that
 *  resolved to something other than an article are not returned. */
export async function listRoomMembers(env: Env, uri: string): Promise<StoredRoomMember[]> {
  const rows = await env.DB.prepare(
    `SELECT link_uri, item_uri, url, url_normalized, item_type, metadata, added_at
       FROM room_members WHERE collection_uri = ? AND url_normalized IS NOT NULL`
  )
    .bind(uri)
    .all<MemberDbRow>();
  const members = rows.results.map((r) => {
    let metadata: MemberMetadata = {};
    try {
      metadata = r.metadata ? (JSON.parse(r.metadata) as MemberMetadata) : {};
    } catch {
      // ours to write; unreadable metadata is just no metadata
    }
    return {
      linkUri: r.link_uri,
      itemUri: r.item_uri,
      url: r.url,
      urlNormalized: r.url_normalized,
      itemType: r.item_type ?? 'unknown',
      title: metadata.title,
      author: metadata.author,
      description: metadata.description,
      image: metadata.image,
      addedAt: r.added_at ?? undefined,
    };
  });
  return sortByAddedAt(members);
}

function memberInsert(
  env: Env,
  uri: string,
  m: StoredRoomMember,
  now: number
): D1PreparedStatement {
  const metadata: MemberMetadata = {
    title: m.title,
    author: m.author,
    description: m.description,
    image: m.image,
  };
  return env.DB.prepare(
    `INSERT OR REPLACE INTO room_members
       (collection_uri, link_uri, item_uri, url, url_normalized, item_type, metadata, added_at,
        resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    uri,
    m.linkUri,
    m.itemUri,
    m.url,
    m.urlNormalized,
    m.itemType,
    JSON.stringify(metadata),
    m.addedAt ?? null,
    now
  );
}

/** A link that resolved to something the room will never show (a free-text
 *  card, a deleted item, an unparseable pointer). Stored so it is not fetched again. */
function nonArticleInsert(
  env: Env,
  uri: string,
  linkUri: string,
  itemUri: string | undefined,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR REPLACE INTO room_members
       (collection_uri, link_uri, item_uri, url, url_normalized, item_type, metadata, added_at,
        resolved_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`
  ).bind(uri, linkUri, itemUri ?? '', now);
}

async function runChunked(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await env.DB.batch(statements.slice(i, i + BATCH_CHUNK));
  }
}

/**
 * An article this reader just added through the room surface: it is in their
 * repo now, and the room should show it on the next open without waiting for a
 * poll to notice. Only written for a room we hold (the add came from its page).
 */
export async function noteRoomMember(env: Env, uri: string, m: StoredRoomMember): Promise<void> {
  const metadata: MemberMetadata = {
    title: m.title,
    author: m.author,
    description: m.description,
    image: m.image,
  };
  await env.DB.prepare(
    `INSERT OR REPLACE INTO room_members
       (collection_uri, link_uri, item_uri, url, url_normalized, item_type, metadata, added_at,
        resolved_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM room_snapshots WHERE collection_uri = ?)`
  )
    .bind(
      uri,
      m.linkUri,
      m.itemUri,
      m.url,
      m.urlNormalized,
      m.itemType,
      JSON.stringify(metadata),
      m.addedAt ?? null,
      Date.now(),
      uri
    )
    .run();
}

export interface PollRoomOptions {
  /** Poll even inside the gate (a room's first look). The lock still applies. */
  force?: boolean;
  /** The collection record, when the caller has just fetched it — saves the poll
   *  fetching it again. */
  collection?: ResolvedCollection;
  /** Override the fetch budget (tests). */
  maxSubrequests?: number;
}

export type PollRoomResult =
  | { polled: false; reason: 'unknown-room' | 'gated' | 'locked' }
  | { polled: true; complete: boolean; gone?: true };

/**
 * Refresh one room's materialized list. Safe to call from `waitUntil` (auth-free
 * throughout) and from several requests at once: the room's `last_poll_at` is
 * advanced with a compare-and-set, so only one caller proceeds.
 *
 * Order of operations, and why:
 *  1. Claim the poll (the CAS). A claim that fails means someone else is on it.
 *  2. Re-read the collection record. Gone means the room is gone: drop its rows,
 *     so the next open answers 404 like a room we never knew. A transient
 *     failure leaves everything as it was; the claim already stamped the attempt.
 *  3. Snapshot with every stored link in `skipLinks`, minus a slice of the
 *     least-recently-tried rows so metadata refreshes over time. Every row in
 *     the slice is stamped as tried, so one that cannot refresh (its repo is
 *     gone) rotates to the back instead of sitting in every poll's slice.
 *  4. Store what resolved (articles as rows, non-articles as NULL rows), delete
 *     what the listing no longer names — only when the listing is provably
 *     whole, and never a row written inside `ROOM_DELETE_GRACE_MS` — and mark
 *     the room complete only if every listed link now has a row.
 */
export async function pollRoom(
  env: Env,
  uri: string,
  opts: PollRoomOptions = {}
): Promise<PollRoomResult> {
  const now = Date.now();
  const row = await readRoomRow(env, uri);
  if (!row) return { polled: false, reason: 'unknown-room' };
  if (!opts.force && !roomNeedsPoll(row, now)) return { polled: false, reason: 'gated' };

  const claim = await env.DB.prepare(
    `UPDATE room_snapshots SET last_poll_at = ? WHERE collection_uri = ? AND last_poll_at = ?`
  )
    .bind(now, uri, row.lastPollAt)
    .run();
  if (!claim.meta.changes) return { polled: false, reason: 'locked' };

  // (2) The collection record itself: name, description, and the access rule
  // canAdd reads. Its absence is the one thing that un-rooms a room.
  let collection = opts.collection;
  if (!collection) {
    let lookup: CollectionLookup;
    try {
      lookup = await lookupCollection(uri);
    } catch (err) {
      console.error('[rooms] poll could not re-read the collection:', err);
      return { polled: true, complete: row.complete };
    }
    if (!lookup.ok) {
      if (lookup.reason === 'not-found') {
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM room_members WHERE collection_uri = ?`).bind(uri),
          env.DB.prepare(`DELETE FROM room_snapshots WHERE collection_uri = ?`).bind(uri),
        ]);
        return { polled: true, complete: false, gone: true };
      }
      return { polled: true, complete: row.complete };
    }
    collection = lookup.collection;
  }

  // (3) What we already hold, and which of it is due a refresh: the rows least
  // recently tried, oldest first, up to a slice. `attempted_at` is the last time
  // the slice picked a row; NULL means never since it was written.
  const stored = await env.DB.prepare(
    `SELECT link_uri, resolved_at, COALESCE(attempted_at, resolved_at) AS tried_at
       FROM room_members WHERE collection_uri = ?
      ORDER BY tried_at ASC`
  )
    .bind(uri)
    .all<{ link_uri: string; resolved_at: number; tried_at: number }>();
  const known = new Set(stored.results.map((r) => r.link_uri));
  const writtenAt = new Map(stored.results.map((r) => [r.link_uri, r.resolved_at]));
  const skipLinks = new Set(known);
  const refreshing: string[] = [];
  for (const r of stored.results) {
    if (refreshing.length >= ROOM_REFRESH_SLICE || now - r.tried_at < ROOM_MEMBER_TTL_MS) break;
    skipLinks.delete(r.link_uri);
    refreshing.push(r.link_uri);
  }

  const snapshot = await snapshotBackedCollection(collection.provider, collection.ref.did, uri, {
    includeForeign: true,
    skipLinks,
    maxSubrequests: opts.maxSubrequests ?? ROOM_SNAPSHOT_SUBREQUESTS,
  });

  // (4) Apply. `after` is what the members table will hold once this lands,
  // which is what decides `complete`: not the snapshot's own verdict (a stale
  // row that failed to refresh is still a row) but whether every listed link
  // has one.
  const statements: D1PreparedStatement[] = [];
  const after = new Set(known);
  const listed = new Set(snapshot.listed);

  // Stamp the slice as tried before anything else lands: a row that resolves is
  // rewritten below (which clears the stamp), and one that did not rotates to the
  // back of the next slice instead of being the oldest row forever.
  if (refreshing.length > 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE room_members SET attempted_at = ? WHERE collection_uri = ?
            AND link_uri IN (${refreshing.map(() => '?').join(', ')})`
      ).bind(now, uri, ...refreshing)
    );
  }

  if (snapshot.listingComplete) {
    for (const linkUri of known) {
      if (listed.has(linkUri)) continue;
      // Written too recently for its absence to mean anything: see ROOM_DELETE_GRACE_MS.
      if (now - (writtenAt.get(linkUri) ?? 0) < ROOM_DELETE_GRACE_MS) continue;
      after.delete(linkUri);
      statements.push(
        env.DB.prepare(`DELETE FROM room_members WHERE collection_uri = ? AND link_uri = ?`).bind(
          uri,
          linkUri
        )
      );
    }
  }
  for (const m of snapshot.members) {
    after.add(m.linkUri);
    statements.push(memberInsert(env, uri, toStored(m), now));
  }
  for (const s of snapshot.skipped) {
    if (s.reason === TRANSIENT_SKIP) continue;
    after.add(s.linkUri);
    statements.push(nonArticleInsert(env, uri, s.linkUri, s.itemUri, now));
  }

  const complete = snapshot.listingComplete && snapshot.listed.every((l) => after.has(l));
  if (!complete) {
    console.warn('[rooms] poll left the room incomplete', {
      uri,
      listingComplete: snapshot.listingComplete,
      listed: snapshot.listed.length,
      stored: after.size,
      resolved: snapshot.members.length,
      transient: snapshot.skipped.filter((s) => s.reason === TRANSIENT_SKIP).length,
    });
  }
  statements.push(
    env.DB.prepare(
      `UPDATE room_snapshots
          SET name = ?, description = ?, record = ?, cid = ?, complete = ?,
              last_complete_at = COALESCE(?, last_complete_at)
        WHERE collection_uri = ?`
    ).bind(
      str(collection.record.name) ?? null,
      str(collection.record.description) ?? null,
      JSON.stringify(collection.record),
      collection.cid,
      complete ? 1 : 0,
      complete ? now : null,
      uri
    )
  );
  await runChunked(env, statements);
  return { polled: true, complete };
}

function toStored(m: BackedMember): StoredRoomMember {
  return {
    linkUri: m.linkUri,
    itemUri: m.itemUri,
    url: m.url,
    urlNormalized: m.urlNormalized,
    itemType: m.itemType,
    title: m.title,
    author: m.author,
    description: m.description,
    image: m.image,
    addedAt: m.addedAt,
  };
}
