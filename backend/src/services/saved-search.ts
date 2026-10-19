/**
 * The D1 side of saved searches: which channels carry a query, which sources
 * each query covers, and the new items those sources produced. The matching
 * itself happens in the Percolator Durable Object (durable-objects/percolator.ts),
 * against a scratch FTS5 table with the search tokenizer, so a saved search and
 * `/` search agree on what matches. See docs/plans/SAVED_SEARCH_CHANNELS.md.
 *
 * Channels stay a client-owned blob (routes/channels.ts). When one is written,
 * `syncSavedQueries` copies its query and source selection into `saved_queries`
 * — the only part of a channel config the server reads.
 */

import type { Env, FeedItem } from '../types';
import { ALL_TIERS, getLimitsForTier } from '../config/tier-limits';
import { parseSearchQuery } from './search-query';
import { isNewsletterSubscription } from './newsletters';
import { BSKY_BOOKMARKS_SOURCE_TYPE, BSKY_LIKES_SOURCE_TYPE } from './bsky-sources';
import { itemBodyKey, mapLimited } from '../routes/item-bodies';
import { htmlToText, stripControlChars, truncateText } from '../utils/html-text';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { log, serializeError } from '../utils/logger';

/** Operator switch, a `sync_state` row: only an explicit '1' turns matching on. */
export const SAVED_SEARCH_ENABLED_KEY = 'saved_search_enabled';

/** How far back a new saved search looks, and how old a newly ingested item may be to match. */
export const MATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Body text matched per item: the whole article, within reason (search keeps the same for saves). */
export const MATCH_BODY_CHARS = 64_000;
/** Matches older than this are dropped; a saved or highlighted item is still in search. */
export const MATCH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const IN_CHUNK = 80;
/** Stored bodies read from R2 at once. */
const R2_READ_CONCURRENCY = 6;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// --- switch and plan -----------------------------------------------------------

export async function isSavedSearchEnabled(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM sync_state WHERE key = ?`)
      .bind(SAVED_SEARCH_ENABLED_KEY)
      .first<{ value: string }>();
    return row?.value === '1';
  } catch {
    return false;
  }
}

export interface SavedSearchAccess {
  enabled: boolean;
  /** How many saved searches the reader's plan matches; 0 = none. */
  maxSavedSearches: number;
}

export async function getSavedSearchAccess(env: Env, did: string): Promise<SavedSearchAccess> {
  const row = await env.DB.prepare(
    `SELECT (SELECT value FROM sync_state WHERE key = ?) AS switch_value,
            (SELECT tier FROM users WHERE did = ?) AS tier`
  )
    .bind(SAVED_SEARCH_ENABLED_KEY, did)
    .first<{ switch_value: string | null; tier: string | null }>();
  return {
    enabled: row?.switch_value === '1',
    maxSavedSearches: getLimitsForTier(row?.tier ?? 'free').maxSavedSearches,
  };
}

// --- channel config → saved query ----------------------------------------------

export type SourceMode = 'all' | 'include' | 'exclude';

export interface SavedQueryConfig {
  query: string;
  ftsQuery: string;
  sourceMode: SourceMode;
  sourceKeys: string[];
  digest: 'off' | 'daily';
  /** Whether it looks through the reader's saves too (`librarySources` naming 'saves'). */
  includeSaves: boolean;
}

interface ChannelConfigFields {
  mode?: string;
  query?: unknown;
  sourceMode?: unknown;
  sourceKeys?: unknown;
  digest?: unknown;
  librarySources?: unknown;
}

/**
 * The saved query a channel config carries, or null when it carries none: no
 * query, a query with nothing searchable in it, or a Saved-mode channel (which
 * filters the reader's own saves, not incoming items).
 */
export function extractSavedQuery(configJson: string): SavedQueryConfig | null {
  const config = parseJson<ChannelConfigFields>(configJson);
  if (!config || typeof config !== 'object') return null;
  if (config.mode === 'saved') return null;
  if (typeof config.query !== 'string') return null;
  const query = config.query.trim();
  const parsed = parseSearchQuery(query);
  if (!parsed) return null;
  const sourceMode: SourceMode =
    config.sourceMode === 'include' || config.sourceMode === 'exclude' ? config.sourceMode : 'all';
  const sourceKeys = Array.isArray(config.sourceKeys)
    ? config.sourceKeys.filter((k): k is string => typeof k === 'string')
    : [];
  return {
    query,
    // The percolator matches one scratch table, so the terms join into one
    // MATCH expression (the same one `/` search used before it split text/notes).
    ftsQuery: [parsed.positives.join(' '), ...parsed.negatives.map((n) => `NOT ${n}`)].join(' '),
    sourceMode,
    sourceKeys: sourceMode === 'all' ? [] : [...new Set(sourceKeys)].sort(),
    digest: config.digest === 'daily' ? 'daily' : 'off',
    // The Shelf alone isn't searched yet: it's a view over saves, not a stream.
    includeSaves: Array.isArray(config.librarySources) && config.librarySources.includes('saves'),
  };
}

interface SavedQueryRow {
  user_did: string;
  channel_uuid: string;
  query: string;
  fts_query: string;
  source_mode: SourceMode;
  source_keys: string;
  digest: string;
  backfill_state: 'pending' | 'done';
  backfill_feed_after: string;
  backfill_doc_after: string;
  backfill_follows_after: string;
  include_saves: number;
  backfill_saves_after: string;
  created_at: number;
  updated_at: number;
}

/**
 * Bring `saved_queries` in line with the channels `uuids` as D1 now holds them.
 * Reading the channel rows back (rather than trusting the request body) means a
 * write that lost to a tombstone never resurrects a query. A changed query or
 * source selection clears the channel's matches and backfills again; a changed
 * digest setting alone keeps them.
 */
export async function syncSavedQueries(env: Env, did: string, uuids: string[]): Promise<boolean> {
  const now = Date.now();
  // Whether any query is new or changed, so its look back is waiting.
  let lookBack = false;
  for (const keys of chunk([...new Set(uuids)], IN_CHUNK / 2)) {
    const [channels, existing] = await env.DB.batch([
      env.DB.prepare(
        `SELECT uuid, config, deleted_at FROM channels
          WHERE user_did = ? AND uuid IN (${placeholders(keys.length)})`
      ).bind(did, ...keys),
      env.DB.prepare(
        `SELECT * FROM saved_queries
          WHERE user_did = ? AND channel_uuid IN (${placeholders(keys.length)})`
      ).bind(did, ...keys),
    ]);
    const live = new Map<string, SavedQueryConfig>();
    for (const row of (channels.results ?? []) as {
      uuid: string;
      config: string;
      deleted_at: number | null;
    }[]) {
      if (row.deleted_at != null) continue;
      const saved = extractSavedQuery(row.config);
      if (saved) live.set(row.uuid, saved);
    }
    const stored = new Map(
      ((existing.results ?? []) as SavedQueryRow[]).map((r) => [r.channel_uuid, r])
    );

    const statements: D1PreparedStatement[] = [];
    for (const uuid of keys) {
      const want = live.get(uuid);
      const have = stored.get(uuid);
      if (!want) {
        if (have) statements.push(...dropStatements(env, did, uuid));
        continue;
      }
      const sourceKeys = JSON.stringify(want.sourceKeys);
      if (!have) {
        lookBack = true;
        statements.push(
          env.DB.prepare(
            `INSERT INTO saved_queries
               (user_did, channel_uuid, query, fts_query, source_mode, source_keys, digest,
                include_saves, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            did,
            uuid,
            want.query,
            want.ftsQuery,
            want.sourceMode,
            sourceKeys,
            want.digest,
            want.includeSaves ? 1 : 0,
            now,
            now
          )
        );
        continue;
      }
      const sourcesChanged =
        have.fts_query !== want.ftsQuery ||
        have.source_mode !== want.sourceMode ||
        have.source_keys !== sourceKeys;
      const savesChanged = have.include_saves !== (want.includeSaves ? 1 : 0);
      if (!sourcesChanged && savesChanged && want.includeSaves) {
        // Saves added to a query its other matches still answer: only the saves
        // need a look back. The other sources' cursors stay at their end.
        lookBack = true;
        statements.push(
          env.DB.prepare(
            `UPDATE saved_queries
                SET query = ?, digest = ?, include_saves = 1, backfill_state = 'pending',
                    backfill_saves_after = '', updated_at = ?
              WHERE user_did = ? AND channel_uuid = ?`
          ).bind(want.query, want.digest, now, did, uuid)
        );
      } else if (sourcesChanged || savesChanged) {
        lookBack = true;
        statements.push(
          env.DB.prepare(
            `UPDATE saved_queries
                SET query = ?, fts_query = ?, source_mode = ?, source_keys = ?, digest = ?,
                    include_saves = ?, backfill_state = 'pending', backfill_feed_after = '',
                    backfill_doc_after = '', backfill_follows_after = '',
                    backfill_saves_after = '', updated_at = ?
              WHERE user_did = ? AND channel_uuid = ?`
          ).bind(
            want.query,
            want.ftsQuery,
            want.sourceMode,
            sourceKeys,
            want.digest,
            want.includeSaves ? 1 : 0,
            now,
            did,
            uuid
          ),
          ...clearMatchStatements(env, did, uuid)
        );
      } else if (have.digest !== want.digest || have.query !== want.query) {
        statements.push(
          env.DB.prepare(
            // updated_at is the matcher's version guard; leaving it alone keeps an
            // in-flight pass's hits, which a digest-only edit doesn't invalidate.
            `UPDATE saved_queries SET query = ?, digest = ?
              WHERE user_did = ? AND channel_uuid = ?`
          ).bind(want.query, want.digest, did, uuid)
        );
      }
    }
    if (statements.length > 0) await env.DB.batch(statements);
  }
  return lookBack;
}

function dropStatements(env: Env, did: string, uuid: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(`DELETE FROM saved_queries WHERE user_did = ? AND channel_uuid = ?`).bind(
      did,
      uuid
    ),
    ...clearMatchStatements(env, did, uuid),
  ];
}

function clearMatchStatements(env: Env, did: string, uuid: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(`DELETE FROM channel_matches WHERE user_did = ? AND channel_uuid = ?`).bind(
      did,
      uuid
    ),
    env.DB.prepare(
      `DELETE FROM channel_match_sources WHERE user_did = ? AND channel_uuid = ?`
    ).bind(did, uuid),
  ];
}

// --- active queries and their scopes -------------------------------------------

export interface DocScope {
  did: string;
  /** Publication AT-URI, or undefined for all of the author's documents. */
  pub?: string;
}

export interface ActiveQuery {
  userDid: string;
  channelUuid: string;
  ftsQuery: string;
  /** The row's version: matches are only written while it still holds. */
  updatedAt: number;
  backfillState: 'pending' | 'done';
  backfillFeedAfter: string;
  backfillDocAfter: string;
  /** '' before the follows backfill starts, 'done' after, else its JSON cursor. */
  backfillFollowsAfter: string;
  /** Feed URLs (RSS and newsletters) the query covers. */
  feedUrls: Set<string>;
  /** standard.site document scopes the query covers. */
  docScopes: DocScope[];
  /** Whether the query takes in the links the reader's follows share. */
  coversFollows: boolean;
  /** Whether the query looks through the reader's own saves. */
  coversSaves: boolean;
  /** '' before the saves backfill starts, 'done' after, else its JSON cursor. */
  backfillSavesAfter: string;
}

/** The channel source key for follows links (frontend utils/sourceKeys.ts). */
export const FOLLOWS_SOURCE_KEY = 'bsky~follows';

interface SubscriptionRow {
  user_did: string;
  record_uri: string;
  feed_url: string;
  source_type: string | null;
  subject_did: string | null;
  category?: string | null;
}

function rkeyOf(recordUri: string): string {
  return recordUri.slice(recordUri.lastIndexOf('/') + 1);
}

function isFeedSubscription(sub: SubscriptionRow): boolean {
  return !sub.source_type || !sub.source_type.startsWith('atproto.');
}

/** The source key the frontend gives a subscription (frontend utils/sourceKeys.ts). */
function sourceKeyOf(sub: SubscriptionRow): string | null {
  if (isFeedSubscription(sub)) return `rss~${rkeyOf(sub.record_uri)}`;
  if (sub.source_type === 'atproto.documents') return `${rkeyOf(sub.record_uri)}~documents`;
  return null;
}

/**
 * The group keys a subscription belongs to, as the frontend's source picker
 * builds them (frontend utils/sourceFilter.ts, `buildSourceGroups`). A channel
 * can name a group (`group~newsletters`), which stands for its members as they
 * are now, so it covers sources subscribed after it was made.
 */
function groupKeysOf(sub: SubscriptionRow): string[] {
  if (isNewsletterSubscription(sub.feed_url, sub.source_type)) return ['group~newsletters'];
  // In the frontend's order (bskySourceKind): the type first, then the URL.
  if (sub.source_type === BSKY_LIKES_SOURCE_TYPE || sub.feed_url.startsWith('bsky-likes:')) {
    return ['group~likes'];
  }
  if (
    sub.source_type === BSKY_BOOKMARKS_SOURCE_TYPE ||
    sub.feed_url.startsWith('bsky-bookmarks:')
  ) {
    return ['group~bookmarks'];
  }
  const isDocuments = sub.source_type === 'atproto.documents';
  if (!isDocuments && !isFeedSubscription(sub)) return [];
  const groups = ['group~publications', isDocuments ? 'group~documents' : 'group~feeds'];
  const category = sub.category?.trim();
  if (category) groups.push(`group~category~${category}`);
  return groups;
}

function docScopeOf(sub: SubscriptionRow): DocScope | null {
  if (sub.source_type !== 'atproto.documents' || !sub.subject_did) return null;
  return {
    did: sub.subject_did,
    pub: sub.feed_url.startsWith('at://') ? sub.feed_url : undefined,
  };
}

/**
 * Resolve one query's source selection against the reader's live subscriptions.
 * Keys that name no subscription (an unsubscribed feed) cover nothing. Follows
 * links aren't a subscription: 'include' takes them in by naming them, 'exclude'
 * by not naming them, and 'all' only when the reader shows them in Everything
 * (frontend utils/sourceFilter.ts isSourceShown).
 */
export function resolveQueryScope(
  sourceMode: SourceMode,
  sourceKeys: string[],
  subs: SubscriptionRow[],
  followsInEverything = false
): { feedUrls: Set<string>; docScopes: DocScope[]; coversFollows: boolean } {
  const keys = new Set(sourceKeys);
  const namesGroups = sourceKeys.some((k) => k.startsWith('group~'));
  const followsNamed = keys.has(FOLLOWS_SOURCE_KEY);
  const coversFollows =
    sourceMode === 'all'
      ? followsInEverything
      : sourceMode === 'include'
        ? followsNamed
        : !followsNamed;
  const feedUrls = new Set<string>();
  const docScopes: DocScope[] = [];
  for (const sub of subs) {
    const key = sourceKeyOf(sub);
    if (!key) continue;
    // Legacy documents keys name the author DID instead of the subscription.
    const legacyDocKey = sub.subject_did ? `${sub.subject_did}~documents` : null;
    const named =
      keys.has(key) ||
      (legacyDocKey !== null && keys.has(legacyDocKey)) ||
      (namesGroups && groupKeysOf(sub).some((g) => keys.has(g)));
    const included = sourceMode === 'all' ? true : sourceMode === 'include' ? named : !named;
    if (!included) continue;
    if (isFeedSubscription(sub)) {
      feedUrls.add(sub.feed_url);
    } else {
      const scope = docScopeOf(sub);
      if (scope) docScopes.push(scope);
    }
  }
  return { feedUrls, docScopes, coversFollows };
}

/**
 * One reader's scope for a source selection, as the matcher would resolve it
 * for a saved query with these sources (the channel editor's preview).
 */
export async function loadReaderScope(
  env: Env,
  did: string,
  sourceMode: SourceMode,
  sourceKeys: string[]
): Promise<{ feedUrls: Set<string>; docScopes: DocScope[]; coversFollows: boolean }> {
  const [subs, follows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT user_did, record_uri, feed_url, source_type, subject_did, category
         FROM subscriptions_cache WHERE user_did = ? AND active = 1`
    ).bind(did),
    env.DB.prepare(`SELECT in_everything FROM follow_link_sync WHERE user_did = ?`).bind(did),
  ]);
  const inEverything =
    ((follows.results ?? [])[0] as { in_everything: number | null } | undefined)?.in_everything ===
    1;
  return resolveQueryScope(
    sourceMode,
    sourceKeys,
    (subs.results ?? []) as SubscriptionRow[],
    inEverything
  );
}

/**
 * The newest items (up to `limit`) a scope covers since `since`, for a preview.
 * Each IN chunk reads its own newest `limit`, so the merge holds the true newest.
 */
export async function readPreviewHeads(
  env: Env,
  scope: { feedUrls: Set<string>; docScopes: DocScope[] },
  since: number,
  limit: number
): Promise<{ feeds: FeedHead[]; docs: DocHead[] }> {
  // Publications are matched in SQL, before the LIMIT, so an author's other
  // sites can't crowd the picked ones out of the newest `limit`.
  const authors = [...new Set(scope.docScopes.filter((s) => !s.pub).map((s) => s.did))];
  const sites = [...new Set(scope.docScopes.flatMap((s) => (s.pub ? [s.pub] : [])))];
  const docSql = (column: string, n: number) =>
    `SELECT record_uri, author_did, site_uri, published_at, indexed_at FROM documents_v2
      WHERE ${column} IN (${placeholders(n)}) AND published_at >= ?
      ORDER BY published_at DESC LIMIT ?`;
  const feedChunks = chunk([...scope.feedUrls], IN_CHUNK);
  const statements = [
    ...feedChunks.map((urls) =>
      env.DB.prepare(
        `SELECT seq, feed_url, published_at FROM feed_items
          WHERE feed_url IN (${placeholders(urls.length)}) AND published_at >= ?
          ORDER BY published_at DESC LIMIT ?`
      ).bind(...urls, since, limit)
    ),
    ...chunk(authors, IN_CHUNK).map((dids) =>
      env.DB.prepare(docSql('author_did', dids.length)).bind(...dids, since, limit)
    ),
    ...chunk(sites, IN_CHUNK).map((uris) =>
      env.DB.prepare(docSql('site_uri', uris.length)).bind(...uris, since, limit)
    ),
  ];
  const results = statements.length > 0 ? await env.DB.batch(statements) : [];
  const docs = new Map<string, DocHead>();
  for (const r of results.slice(feedChunks.length)) {
    for (const d of (r.results ?? []) as DocHead[]) {
      if (docInAnyScope({ authorDid: d.author_did, siteUri: d.site_uri }, scope.docScopes)) {
        docs.set(d.record_uri, d);
      }
    }
  }
  const heads = [
    ...results
      .slice(0, feedChunks.length)
      .flatMap((r) => (r.results ?? []) as FeedHead[])
      .map((head) => ({ at: head.published_at ?? 0, feed: head })),
    ...[...docs.values()].map((head) => ({ at: head.published_at, doc: head })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
  return {
    feeds: heads.flatMap((h) => ('feed' in h ? [h.feed] : [])),
    docs: heads.flatMap((h) => ('doc' in h ? [h.doc] : [])),
  };
}

export function docInAnyScope(
  doc: { authorDid: string; siteUri: string },
  scopes: DocScope[]
): boolean {
  return scopes.some((s) => doc.authorDid === s.did && (!s.pub || doc.siteUri === s.pub));
}

/** Whether `doc` comes from a source `query` covers. */
export function queryCovers(query: ActiveQuery, doc: MatchDoc): boolean {
  if (doc.kind === 'feed') return query.feedUrls.has(doc.sourceRef);
  if (doc.kind === 'document') {
    return docInAnyScope({ authorDid: doc.sourceRef, siteUri: doc.siteUri }, query.docScopes);
  }
  if (doc.kind === 'save') return query.coversSaves && doc.ownerDid === query.userDid;
  return query.coversFollows && doc.ownerDid === query.userDid;
}

/** Tiers whose plan includes saved searches, for filtering in SQL. */
export function entitledTiers(): string[] {
  return ALL_TIERS.filter((tier) => getLimitsForTier(tier).maxSavedSearches > 0);
}

type LoadedQueryRow = SavedQueryRow & { tier: string; follows_in_everything: number | null };

/**
 * Every saved query that should match right now: its reader's plan includes
 * saved searches, and it is within their plan's count (oldest first, so a
 * downgrade-then-upgrade resumes the same ones). Each comes with its resolved
 * source scope.
 */
export async function loadActiveQueries(env: Env): Promise<ActiveQuery[]> {
  const tiers = entitledTiers();
  if (tiers.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT q.*, u.tier, fs.in_everything AS follows_in_everything
       FROM saved_queries q JOIN users u ON u.did = q.user_did
       LEFT JOIN follow_link_sync fs ON fs.user_did = q.user_did
      WHERE u.tier IN (${placeholders(tiers.length)})
      ORDER BY q.user_did, q.created_at, q.channel_uuid`
  )
    .bind(...tiers)
    .all<LoadedQueryRow>();

  const byUser = new Map<string, LoadedQueryRow[]>();
  for (const row of rows.results ?? []) {
    const list = byUser.get(row.user_did) ?? [];
    if (list.length < getLimitsForTier(row.tier).maxSavedSearches) list.push(row);
    byUser.set(row.user_did, list);
  }
  if (byUser.size === 0) return [];

  const subsByUser = new Map<string, SubscriptionRow[]>();
  for (const users of chunk([...byUser.keys()], IN_CHUNK)) {
    const subs = await env.DB.prepare(
      `SELECT user_did, record_uri, feed_url, source_type, subject_did, category
         FROM subscriptions_cache
        WHERE user_did IN (${placeholders(users.length)}) AND active = 1`
    )
      .bind(...users)
      .all<SubscriptionRow>();
    for (const sub of subs.results ?? []) {
      const list = subsByUser.get(sub.user_did) ?? [];
      list.push(sub);
      subsByUser.set(sub.user_did, list);
    }
  }

  const active: ActiveQuery[] = [];
  for (const [did, queries] of byUser) {
    const subs = subsByUser.get(did) ?? [];
    for (const q of queries) {
      const scope = resolveQueryScope(
        q.source_mode,
        parseJson<string[]>(q.source_keys) ?? [],
        subs,
        q.follows_in_everything === 1
      );
      active.push({
        userDid: did,
        channelUuid: q.channel_uuid,
        ftsQuery: q.fts_query,
        updatedAt: q.updated_at,
        backfillState: q.backfill_state,
        backfillFeedAfter: q.backfill_feed_after,
        backfillDocAfter: q.backfill_doc_after,
        backfillFollowsAfter: q.backfill_follows_after,
        coversSaves: q.include_saves === 1,
        backfillSavesAfter: q.backfill_saves_after,
        ...scope,
      });
    }
  }
  return active;
}

// --- streams of new items ------------------------------------------------------

/** One item, as the matcher indexes it. */
export interface MatchDoc {
  kind: 'feed' | 'document' | 'follows' | 'save';
  /**
   * What read state is filed under: guid, document URI, or a link's normalized
   * URL. A save's is its rkey (read means archived, under any of its aliases).
   */
  itemKey: string;
  /**
   * feed_url for feed items, the author DID for documents, the first sharer's
   * DID for links, the rkey for a save.
   */
  sourceRef: string;
  /** Documents only: the `site` the record names, for publication scoping. */
  siteUri: string;
  feedSeq: number | null;
  url: string | null;
  title: string;
  author: string;
  sourceTitle: string;
  body: string;
  publishedAt: number | null;
  /** Follows links and saves: whose timeline (or Library) it's in. */
  ownerDid?: string;
  /** Follows links only: everyone in that timeline who shared it. */
  sharers?: Sharer[];
  /** Follows links only: the link card, kept on the match (shares expire in a week). */
  link?: LinkCard;
  /** Follows links only: matched without the article, the reader's extraction budget being spent. */
  bodySkipped?: boolean;
}

export interface Sharer {
  did: string;
  postUri: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
}

export interface LinkCard {
  url: string;
  title: string | null;
  description: string | null;
  thumb: string | null;
}

export interface FeedHead {
  seq: number;
  feed_url: string;
  published_at: number | null;
}

export interface DocHead {
  record_uri: string;
  author_did: string;
  site_uri: string;
  published_at: number;
  indexed_at: number;
}

export interface DocCursor {
  at: number;
  uri: string;
}

/** A follows-link share as the matcher reads it, from one reader's timeline. */
export interface ShareHead {
  user_did: string;
  post_uri: string;
  sharer_did: string;
  url: string;
  url_normalized: string;
  post_text: string | null;
  card_title: string | null;
  card_description: string | null;
  card_thumb: string | null;
  sharer_handle: string | null;
  sharer_name: string | null;
  sharer_avatar: string | null;
  shared_at: number;
  first_seen_at: number | null;
}

/** Position in the share stream: `(first_seen_at, user_did, post_uri, sharer_did)`. */
export interface ShareCursor {
  at: number;
  user: string;
  post: string;
  sharer: string;
}

const SHARE_COLUMNS = `user_did, post_uri, sharer_did, url, url_normalized, post_text, card_title,
  card_description, card_thumb, sharer_handle, sharer_name, sharer_avatar, shared_at, first_seen_at`;

/** A save as the matcher reads it from the stream: cheap columns only. */
export interface SaveHead {
  id: number;
  user_did: string;
}

export interface StreamCursors {
  seq: number;
  doc: DocCursor;
  /** Absent in cursors saved before follows matching; it starts at the head. */
  share?: ShareCursor;
  /** saved_articles.id. Absent in cursors saved before saves matching; it starts at the head. */
  save?: number;
}

/** The newest positions of every stream, where a fresh matcher starts. */
export async function streamHeads(
  env: Env
): Promise<{ seq: number; doc: DocCursor; share: ShareCursor; save: number }> {
  const [seq, doc, share, save] = await env.DB.batch([
    env.DB.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM feed_items`),
    env.DB.prepare(
      `SELECT indexed_at AS at, record_uri AS uri FROM documents_v2
        ORDER BY indexed_at DESC, record_uri DESC LIMIT 1`
    ),
    env.DB.prepare(
      `SELECT first_seen_at AS at, user_did AS user, post_uri AS post, sharer_did AS sharer
         FROM follow_link_shares WHERE first_seen_at IS NOT NULL
        ORDER BY first_seen_at DESC, user_did DESC, post_uri DESC, sharer_did DESC LIMIT 1`
    ),
    env.DB.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM saved_articles`),
  ]);
  const docRow = (doc.results ?? [])[0] as DocCursor | undefined;
  const shareRow = (share.results ?? [])[0] as ShareCursor | undefined;
  return {
    seq: ((seq.results ?? [])[0] as { seq: number } | undefined)?.seq ?? 0,
    doc: docRow ?? { at: 0, uri: '' },
    share: shareRow ?? { at: 0, user: '', post: '', sharer: '' },
    save: ((save.results ?? [])[0] as { id: number } | undefined)?.id ?? 0,
  };
}

/**
 * The next page of every stream: cheap columns only, so items no query covers
 * are skipped before their bodies are read. Documents stay a little behind
 * now (`settledBefore`): `indexed_at` is a write-time clock, and a row written
 * in the same millisecond as the cursor with a smaller URI would otherwise be
 * passed. Shares stay further behind (`sharesSettledBefore`), since their
 * clock is read before the batch that writes them is sent. A share row is
 * small (the sharer's words are truncated), so it comes whole.
 */
export async function readStreamPage(
  env: Env,
  cursors: { seq: number; doc: DocCursor; share: ShareCursor; save: number },
  pageSize: number,
  settledBefore: number,
  sharesSettledBefore: number,
  savesSettledBefore: number
): Promise<{ feeds: FeedHead[]; docs: DocHead[]; shares: ShareHead[]; saves: SaveHead[] }> {
  const c = cursors.share;
  const [feeds, docs, shares, saves] = await env.DB.batch([
    env.DB.prepare(
      `SELECT seq, feed_url, published_at FROM feed_items WHERE seq > ? ORDER BY seq LIMIT ?`
    ).bind(cursors.seq, pageSize),
    env.DB.prepare(
      `SELECT record_uri, author_did, site_uri, published_at, indexed_at FROM documents_v2
        WHERE (indexed_at > ? OR (indexed_at = ? AND record_uri > ?)) AND indexed_at < ?
        ORDER BY indexed_at, record_uri LIMIT ?`
    ).bind(cursors.doc.at, cursors.doc.at, cursors.doc.uri, settledBefore, pageSize),
    env.DB.prepare(
      `SELECT ${SHARE_COLUMNS} FROM follow_link_shares
        WHERE (first_seen_at, user_did, post_uri, sharer_did) > (?, ?, ?, ?)
          AND first_seen_at < ?
        ORDER BY first_seen_at, user_did, post_uri, sharer_did LIMIT ?`
    ).bind(c.at, c.user, c.post, c.sharer, sharesSettledBefore, pageSize),
    // A save's id is assigned as it's written, so the stream is commit-ordered.
    // It stops short of a recent save with no body yet, so the cursor doesn't pass
    // it before its article is read.
    env.DB.prepare(
      `SELECT id, user_did FROM saved_articles
        WHERE id > ?1 AND id < coalesce(
          (SELECT min(id) FROM saved_articles
            WHERE id > ?1 AND content IS NULL AND created_at >= ?2), 9223372036854775807)
        ORDER BY id LIMIT ?3`
    ).bind(cursors.save, savesSettledBefore, pageSize),
  ]);
  return {
    feeds: (feeds.results ?? []) as FeedHead[],
    docs: (docs.results ?? []) as DocHead[],
    shares: (shares.results ?? []) as ShareHead[],
    saves: (saves.results ?? []) as SaveHead[],
  };
}

export function shareCursorOf(share: ShareHead): ShareCursor {
  return {
    at: share.first_seen_at ?? 0,
    user: share.user_did,
    post: share.post_uri,
    sharer: share.sharer_did,
  };
}

/** Where a follows backfill has got to: the last share it finished, newest first. */
interface FollowsBackfillCursor {
  at: number;
  post: string;
  sharer: string;
}

/**
 * One step of a query's follows backfill: the next page of its reader's stored
 * shares, newest first, so the extraction budget goes to what's recent.
 */
export async function readFollowsBackfillPage(
  env: Env,
  query: ActiveQuery,
  since: number,
  pageSize: number
): Promise<{ shares: ShareHead[]; after: string; done: boolean }> {
  const after = parseJson<FollowsBackfillCursor>(query.backfillFollowsAfter);
  const rows = await env.DB.prepare(
    `SELECT ${SHARE_COLUMNS} FROM follow_link_shares
      WHERE user_did = ?1 AND shared_at >= ?2
        AND (?3 IS NULL OR (shared_at, post_uri, sharer_did) < (?3, ?4, ?5))
      ORDER BY shared_at DESC, post_uri DESC, sharer_did DESC LIMIT ?6`
  )
    .bind(query.userDid, since, after?.at ?? null, after?.post ?? '', after?.sharer ?? '', pageSize)
    .all<ShareHead>();
  const shares = rows.results ?? [];
  const last = shares.at(-1);
  const done = shares.length < pageSize;
  return {
    shares,
    after: done
      ? 'done'
      : JSON.stringify({ at: last!.shared_at, post: last!.post_uri, sharer: last!.sharer_did }),
    done,
  };
}

/** Where a saves backfill has got to: the last save it finished, newest first. */
interface SavesBackfillCursor {
  id: number;
}

/**
 * One step of a query's saves backfill: the next page of its reader's saves,
 * newest first. All of them, not the last 30 days: a Library is read as a
 * whole, and it's one reader's, so it stays small next to the feeds.
 */
export async function readSavesBackfillPage(
  env: Env,
  query: ActiveQuery,
  pageSize: number
): Promise<{ ids: number[]; after: string; done: boolean }> {
  const after = parseJson<SavesBackfillCursor>(query.backfillSavesAfter);
  // By id, which never changes, rather than saved_at, which a re-save moves.
  const rows = await env.DB.prepare(
    `SELECT id FROM saved_articles WHERE user_did = ? AND id < ? ORDER BY id DESC LIMIT ?`
  )
    .bind(query.userDid, after?.id ?? Number.MAX_SAFE_INTEGER, pageSize)
    .all<{ id: number }>();
  const saves = rows.results ?? [];
  const last = saves.at(-1);
  const done = saves.length < pageSize;
  return {
    ids: saves.map((s) => s.id),
    after: done ? 'done' : JSON.stringify({ id: last!.id }),
    done,
  };
}

/** A reader's newest saves, for a preview. */
export async function readPreviewSaves(
  env: Env,
  did: string,
  limit: number
): Promise<{ id: number; saved_at: number }[]> {
  const rows = await env.DB.prepare(
    `SELECT id, saved_at FROM saved_articles WHERE user_did = ?
      ORDER BY saved_at DESC, id DESC LIMIT ?`
  )
    .bind(did, limit)
    .all<{ id: number; saved_at: number }>();
  return rows.results ?? [];
}

/** A reader's shares of one URL, for re-checking them once the article is read. */
export async function readSharesOfUrl(
  env: Env,
  readers: string[],
  urlNormalized: string,
  since: number
): Promise<ShareHead[]> {
  if (readers.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT ${SHARE_COLUMNS} FROM follow_link_shares
      WHERE user_did IN (SELECT value FROM json_each(?)) AND url_normalized = ? AND shared_at >= ?`
  )
    .bind(JSON.stringify(readers), urlNormalized, since)
    .all<ShareHead>();
  return rows.results ?? [];
}

/**
 * One match document per link per reader: every share of a URL in one
 * reader's timeline indexes together, so a story shared by three follows is
 * one row, matched on all their words, the card, and the article when it's
 * been read (`bodies`, by normalized URL).
 */
export function buildShareDocs(
  shares: ShareHead[],
  bodies: Map<string, string>,
  bodySkipped: Set<string>
): MatchDoc[] {
  const groups = new Map<string, ShareHead[]>();
  for (const share of shares) {
    const key = `${share.user_did}\u0000${share.url_normalized}`;
    const list = groups.get(key) ?? [];
    list.push(share);
    groups.set(key, list);
  }
  const docs: MatchDoc[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.shared_at - b.shared_at || a.post_uri.localeCompare(b.post_uri));
    const first = group[0];
    const withCard = group.find((s) => s.card_title) ?? first;
    const sharers = new Map<string, Sharer>();
    for (const s of group) {
      if (sharers.has(s.sharer_did)) continue;
      sharers.set(s.sharer_did, {
        did: s.sharer_did,
        postUri: s.post_uri,
        handle: s.sharer_handle,
        name: s.sharer_name,
        avatar: s.sharer_avatar,
      });
    }
    const words = [...new Set(group.map((s) => s.post_text).filter((t): t is string => !!t))];
    const body = [...words, withCard.card_description ?? '', bodies.get(first.url_normalized) ?? '']
      .filter(Boolean)
      .join('\n\n');
    docs.push({
      kind: 'follows',
      itemKey: first.url_normalized,
      sourceRef: first.sharer_did,
      siteUri: '',
      feedSeq: null,
      url: first.url,
      title: clean(withCard.card_title ?? '', 500),
      author: clean(
        [...sharers.values()]
          .map((s) => s.name || s.handle || '')
          .filter(Boolean)
          .join(', '),
        200
      ),
      sourceTitle: '',
      body: stripControlChars(truncateText(body, MATCH_BODY_CHARS)),
      publishedAt: first.shared_at,
      ownerDid: first.user_did,
      sharers: [...sharers.values()],
      link: {
        url: first.url,
        title: withCard.card_title,
        description: withCard.card_description,
        thumb: withCard.card_thumb,
      },
      bodySkipped: bodySkipped.has(first.url_normalized),
    });
  }
  return docs;
}

/** One backfill step: recent items from the next few of a query's feeds and authors. */
export async function readBackfillPage(
  env: Env,
  query: ActiveQuery,
  since: number,
  sourcesPerStep: number,
  itemsPerSource: number
): Promise<{
  feeds: FeedHead[];
  docs: DocHead[];
  feedAfter: string;
  docAfter: string;
  done: boolean;
  /** Feed items in this page whose body is kept in R2. */
  storedBodies: number;
}> {
  const feedUrls = [...query.feedUrls].sort().filter((u) => u > query.backfillFeedAfter);
  const authors = [...new Set(query.docScopes.map((s) => s.did))]
    .sort()
    .filter((d) => d > query.backfillDocAfter);
  const feedStep = feedUrls.slice(0, sourcesPerStep);
  const authorStep =
    feedStep.length < sourcesPerStep ? authors.slice(0, sourcesPerStep - feedStep.length) : [];

  const statements = [
    ...feedStep.map((feedUrl) =>
      env.DB.prepare(
        `SELECT seq, feed_url, published_at,
                json_extract(item_json, '$.bodyStored') AS body_stored
           FROM feed_items
          WHERE feed_url = ? AND published_at >= ?
          ORDER BY published_at DESC, seq DESC LIMIT ?`
      ).bind(feedUrl, since, itemsPerSource)
    ),
    ...authorStep.map((did) =>
      env.DB.prepare(
        `SELECT record_uri, author_did, site_uri, published_at, indexed_at FROM documents_v2
          WHERE author_did = ? AND published_at >= ?
          ORDER BY published_at DESC LIMIT ?`
      ).bind(did, since, itemsPerSource)
    ),
  ];
  const results = statements.length > 0 ? await env.DB.batch(statements) : [];
  const feeds = results
    .slice(0, feedStep.length)
    .flatMap((r) => (r.results ?? []) as (FeedHead & { body_stored: unknown })[]);
  const docs = results.slice(feedStep.length).flatMap((r) => (r.results ?? []) as DocHead[]);
  return {
    feeds,
    docs,
    feedAfter: feedStep.at(-1) ?? query.backfillFeedAfter,
    docAfter: authorStep.at(-1) ?? query.backfillDocAfter,
    done: feedUrls.length <= feedStep.length && authors.length <= authorStep.length,
    storedBodies: env.ITEM_BODIES ? feeds.filter((f) => f.body_stored).length : 0,
  };
}

// --- bodies --------------------------------------------------------------------

interface FeedItemRow {
  seq: number;
  feed_url: string;
  guid: string;
  item_json: string;
  published_at: number | null;
}

interface DocumentRow {
  record_uri: string;
  author_did: string;
  site_uri: string;
  published_at: number;
  canonical_url: string | null;
  title: string | null;
  description: string | null;
  text_content: string | null;
}

/**
 * Full text for the given feed items and documents. Feed bodies over the
 * inline cap come from R2 while `r2Budget.left` lasts; past it an item matches
 * on its inline lead, which is logged rather than silently narrower.
 */
export async function loadMatchDocs(
  env: Env,
  seqs: number[],
  documentUris: string[],
  /** `quiet`: skipping stored bodies is expected (the editor's preview), not worth a log. */
  r2Budget: { left: number; quiet?: boolean }
): Promise<MatchDoc[]> {
  const docs: MatchDoc[] = [];

  const feedRows: FeedItemRow[] = [];
  for (const keys of chunk(seqs, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT seq, feed_url, guid, item_json, published_at FROM feed_items
        WHERE seq IN (${placeholders(keys.length)})`
    )
      .bind(...keys)
      .all<FeedItemRow>();
    feedRows.push(...(rows.results ?? []));
  }
  const feedTitles = await lookupFeedTitles(env, [...new Set(feedRows.map((r) => r.feed_url))]);
  const parsed = feedRows.flatMap((row) => {
    const item = parseJson<FeedItem>(row.item_json);
    return item ? [{ row, item }] : [];
  });
  // Stored bodies are read a few at a time rather than one after another: a
  // look back over a busy feed reads dozens, and in series they took seconds.
  let budgetSkipped = 0;
  const toRead: typeof parsed = [];
  for (const entry of parsed) {
    if (!entry.item.bodyStored || !env.ITEM_BODIES) continue;
    if (r2Budget.left > 0) {
      r2Budget.left--;
      toRead.push(entry);
    } else {
      budgetSkipped++;
    }
  }
  // Kept as matching text, not raw HTML, so a step's bodies aren't all in memory at once.
  const texts = await mapLimited(toRead, R2_READ_CONCURRENCY, async ({ row }) =>
    htmlToText((await readStoredBody(env, row.feed_url, row.guid)) ?? '', MATCH_BODY_CHARS)
  );
  const stored = new Map(toRead.map(({ row }, i) => [row.seq, texts[i]]));
  for (const { row, item } of parsed) {
    const body =
      stored.get(row.seq) ||
      htmlToText(item.content || item.contentLead || '', MATCH_BODY_CHARS) ||
      htmlToText(item.summary ?? '', MATCH_BODY_CHARS);
    docs.push({
      kind: 'feed',
      itemKey: row.guid,
      sourceRef: row.feed_url,
      siteUri: '',
      feedSeq: row.seq,
      url: item.url || null,
      title: clean(item.title ?? '', 500),
      author: clean(item.author ?? '', 200),
      sourceTitle: clean(feedTitles.get(row.feed_url) ?? '', 300),
      body: stripControlChars(body),
      publishedAt: row.published_at,
    });
  }
  if (budgetSkipped > 0 && !r2Budget.quiet) {
    log.info('saved_search_r2_budget_spent', { budgetSkipped });
  }

  for (const keys of chunk(documentUris, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT record_uri, author_did, site_uri, published_at, canonical_url,
              json_extract(record_json, '$.title') AS title,
              json_extract(record_json, '$.description') AS description,
              json_extract(record_json, '$.textContent') AS text_content
         FROM documents_v2 WHERE record_uri IN (${placeholders(keys.length)})`
    )
      .bind(...keys)
      .all<DocumentRow>();
    for (const row of rows.results ?? []) {
      const text = row.text_content || row.description || '';
      docs.push({
        kind: 'document',
        itemKey: row.record_uri,
        sourceRef: row.author_did,
        siteUri: row.site_uri,
        feedSeq: null,
        url: row.canonical_url,
        title: clean(row.title ?? '', 500),
        author: '',
        sourceTitle: '',
        body: stripControlChars(truncateText(text, MATCH_BODY_CHARS)),
        publishedAt: row.published_at,
      });
    }
  }
  return docs;
}

interface SaveRow {
  id: number;
  user_did: string;
  rkey: string;
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  domain: string | null;
  content: string | null;
  saved_at: number;
}

/**
 * Text for the given saves: the body kept with the save (inline in D1), else
 * its description. A book's body can run to a megabyte, so only its first
 * `bodyChars` (in HTML, read in SQL) are matched.
 */
export async function loadSaveDocs(
  env: Env,
  ids: number[],
  bodyChars = MATCH_BODY_CHARS
): Promise<MatchDoc[]> {
  const docs: MatchDoc[] = [];
  // HTML runs longer than its text; this much markup leaves room for the cap.
  const htmlChars = bodyChars * 3;
  for (const keys of chunk(ids, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT id, user_did, rkey, url, title, author, description, domain,
              substr(content, 1, ?) AS content, saved_at
         FROM saved_articles WHERE id IN (${placeholders(keys.length)})`
    )
      .bind(htmlChars, ...keys)
      .all<SaveRow>();
    for (const row of rows.results ?? []) {
      const body =
        htmlToText(row.content ?? '', bodyChars) || htmlToText(row.description ?? '', bodyChars);
      docs.push({
        kind: 'save',
        itemKey: row.rkey,
        sourceRef: row.rkey,
        siteUri: '',
        feedSeq: null,
        url: row.url || null,
        title: clean(row.title ?? '', 500),
        author: clean(row.author ?? '', 200),
        sourceTitle: clean(row.domain ?? '', 300),
        body: stripControlChars(body),
        publishedAt: row.saved_at,
        ownerDid: row.user_did,
      });
    }
  }
  return docs;
}

function clean(text: string, max: number): string {
  return stripControlChars(truncateText(text, max));
}

async function lookupFeedTitles(env: Env, feedUrls: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const keys of chunk(feedUrls, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT feed_url, title FROM feeds WHERE feed_url IN (${placeholders(keys.length)})`
    )
      .bind(...keys)
      .all<{ feed_url: string; title: string | null }>();
    for (const row of rows.results ?? []) {
      if (row.title) found.set(row.feed_url, row.title);
    }
  }
  return found;
}

async function readStoredBody(env: Env, feedUrl: string, guid: string): Promise<string | null> {
  try {
    const object = await env.ITEM_BODIES!.get(await itemBodyKey(feedUrl, guid));
    return object ? await object.text() : null;
  } catch (error) {
    log.warn('saved_search_body_read_failed', serializeError(error));
    return null;
  }
}

// --- matches -------------------------------------------------------------------

export interface MatchHit {
  query: MatchTarget;
  doc: MatchDoc;
  /** FTS5 snippet with matches wrapped in \u0002…\u0003. */
  snippet: string;
}

/** Which saved query a hit is for, as of the version the matcher loaded. */
export type MatchTarget = Pick<ActiveQuery, 'userDid' | 'channelUuid' | 'updatedAt'>;

// The page was saved again, under a new record, after the save that matched it
// was removed: the match follows the save that's there now.
const SAVE_MOVED = `(channel_matches.source_kind = 'save' AND excluded.source_kind = 'save'
     AND channel_matches.item_key <> excluded.item_key)`;

/** The key one story matches under in a channel: its normalized URL, else the item. */
export function dedupKey(doc: Pick<MatchDoc, 'kind' | 'url' | 'itemKey'>): string {
  // A link's item key already is its normalized URL, as the follows surface keyed it.
  if (doc.kind === 'follows') return doc.itemKey;
  return (doc.url && normalizeArticleUrl(doc.url)) || `item:${doc.itemKey}`;
}

// D1 binds at most 100 parameters per statement: 6 shared + 9 per row.
const MATCH_ROWS_PER_STATEMENT = 10;
// 6 shared + 5 per source row.
const SOURCE_ROWS_PER_STATEMENT = 18;

interface SourceRow {
  dedupKey: string;
  kind: MatchDoc['kind'];
  ref: string;
  itemKey: string;
  meta: string | null;
}

function sourceRowsOf(hit: MatchHit): SourceRow[] {
  const key = dedupKey(hit.doc);
  if (hit.doc.kind === 'follows') {
    return (hit.doc.sharers ?? []).map((s) => ({
      dedupKey: key,
      kind: 'follows',
      ref: s.did,
      itemKey: s.postUri,
      meta: JSON.stringify({ handle: s.handle, name: s.name, avatar: s.avatar }),
    }));
  }
  return [
    {
      dedupKey: key,
      kind: hit.doc.kind,
      ref: hit.doc.sourceRef,
      itemKey: hit.doc.itemKey,
      meta: null,
    },
  ];
}

/**
 * Insert statements for `hits`, a few rows each: the story's one match row
 * (the first source to match keeps it), and a row per source it arrived from.
 * Every insert is guarded on the query still being the version the matcher
 * loaded: an edit made while a pass was running cleared the channel's matches
 * and restarted its backfill, and must not get hits for the old predicate
 * written back on top.
 */
export function matchInsertStatements(
  env: Env,
  hits: MatchHit[],
  now: number
): D1PreparedStatement[] {
  const byQuery = new Map<string, MatchHit[]>();
  for (const hit of hits) {
    const key = `${hit.query.userDid}\u0000${hit.query.channelUuid}`;
    const list = byQuery.get(key) ?? [];
    list.push(hit);
    byQuery.set(key, list);
  }
  const statements: D1PreparedStatement[] = [];
  for (const group of byQuery.values()) {
    const { userDid, channelUuid, updatedAt } = group[0].query;
    for (const rows of chunk(group, MATCH_ROWS_PER_STATEMENT)) {
      const values = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      statements.push(
        env.DB.prepare(
          `INSERT INTO channel_matches
             (user_did, channel_uuid, dedup_key, item_key, source_kind, source_ref, feed_seq,
              snippet, published_at, body_skipped, link_json, matched_at)
           SELECT ?, ?, v.column1, v.column2, v.column3, v.column4, v.column5, v.column6,
                  v.column7, v.column8, v.column9, ?
             FROM (VALUES ${values}) AS v
            WHERE EXISTS (SELECT 1 FROM saved_queries
                           WHERE user_did = ? AND channel_uuid = ? AND updated_at = ?)
           ON CONFLICT (user_did, channel_uuid, dedup_key) DO UPDATE SET
             body_skipped = CASE WHEN excluded.body_skipped = 0 THEN 0
                                 ELSE channel_matches.body_skipped END,
             item_key = CASE WHEN ${SAVE_MOVED} THEN excluded.item_key
                             ELSE channel_matches.item_key END,
             source_ref = CASE WHEN ${SAVE_MOVED} THEN excluded.source_ref
                               ELSE channel_matches.source_ref END
             WHERE (excluded.body_skipped = 0 AND channel_matches.body_skipped = 1)
                OR ${SAVE_MOVED}`
        ).bind(
          userDid,
          channelUuid,
          now,
          ...rows.flatMap((hit) => [
            dedupKey(hit.doc),
            hit.doc.itemKey,
            hit.doc.kind,
            hit.doc.sourceRef,
            hit.doc.feedSeq,
            hit.snippet,
            // Undated items sort by when they matched, so every row has a place in the list.
            hit.doc.publishedAt ?? now,
            hit.doc.bodySkipped ? 1 : 0,
            hit.doc.link ? JSON.stringify(hit.doc.link) : null,
          ]),
          userDid,
          channelUuid,
          updatedAt
        )
      );
    }
    for (const rows of chunk(group.flatMap(sourceRowsOf), SOURCE_ROWS_PER_STATEMENT)) {
      const values = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
      statements.push(
        env.DB.prepare(
          `INSERT INTO channel_match_sources
             (user_did, channel_uuid, dedup_key, source_kind, source_ref, item_key, meta_json,
              matched_at)
           SELECT ?, ?, v.column1, v.column2, v.column3, v.column4, v.column5, ?
             FROM (VALUES ${values}) AS v
            WHERE EXISTS (SELECT 1 FROM saved_queries
                           WHERE user_did = ? AND channel_uuid = ? AND updated_at = ?)
           ON CONFLICT (user_did, channel_uuid, dedup_key, source_kind, source_ref) DO NOTHING`
        ).bind(
          userDid,
          channelUuid,
          now,
          ...rows.flatMap((r) => [r.dedupKey, r.kind, r.ref, r.itemKey, r.meta]),
          userDid,
          channelUuid,
          updatedAt
        )
      );
    }
  }
  return statements;
}

/** The Percolator's stub: one instance today, named so it can be sharded later. */
/**
 * The instance the channel editor's previews run on: the same class, kept off
 * the matcher's own instance so typing never holds up live matching. It never
 * sets an alarm, so it never matches anything for real.
 */
export function previewStub(env: Env) {
  return env.PERCOLATOR.get(env.PERCOLATOR.idFromName('percolator-preview'));
}

export function percolatorStub(env: Env) {
  return env.PERCOLATOR.get(env.PERCOLATOR.idFromName('percolator-0'));
}

/** Wake the matcher if saved searches are on. Cheap enough for every cron minute. */
export async function nudgePercolator(env: Env): Promise<void> {
  if (!(await isSavedSearchEnabled(env))) return;
  await percolatorStub(env).nudge();
}
