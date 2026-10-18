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
import { itemBodyKey } from '../routes/item-bodies';
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
}

interface ChannelConfigFields {
  mode?: string;
  query?: unknown;
  sourceMode?: unknown;
  sourceKeys?: unknown;
  digest?: unknown;
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
export async function syncSavedQueries(env: Env, did: string, uuids: string[]): Promise<void> {
  const now = Date.now();
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
        statements.push(
          env.DB.prepare(
            `INSERT INTO saved_queries
               (user_did, channel_uuid, query, fts_query, source_mode, source_keys, digest, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            did,
            uuid,
            want.query,
            want.ftsQuery,
            want.sourceMode,
            sourceKeys,
            want.digest,
            now,
            now
          )
        );
        continue;
      }
      const predicateChanged =
        have.fts_query !== want.ftsQuery ||
        have.source_mode !== want.sourceMode ||
        have.source_keys !== sourceKeys;
      if (predicateChanged) {
        statements.push(
          env.DB.prepare(
            `UPDATE saved_queries
                SET query = ?, fts_query = ?, source_mode = ?, source_keys = ?, digest = ?,
                    backfill_state = 'pending', backfill_feed_after = '', backfill_doc_after = '',
                    updated_at = ?
              WHERE user_did = ? AND channel_uuid = ?`
          ).bind(
            want.query,
            want.ftsQuery,
            want.sourceMode,
            sourceKeys,
            want.digest,
            now,
            did,
            uuid
          ),
          env.DB.prepare(
            `DELETE FROM channel_matches WHERE user_did = ? AND channel_uuid = ?`
          ).bind(did, uuid)
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
}

function dropStatements(env: Env, did: string, uuid: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(`DELETE FROM saved_queries WHERE user_did = ? AND channel_uuid = ?`).bind(
      did,
      uuid
    ),
    env.DB.prepare(`DELETE FROM channel_matches WHERE user_did = ? AND channel_uuid = ?`).bind(
      did,
      uuid
    ),
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
  /** Feed URLs (RSS and newsletters) the query covers. */
  feedUrls: Set<string>;
  /** standard.site document scopes the query covers. */
  docScopes: DocScope[];
}

interface SubscriptionRow {
  user_did: string;
  record_uri: string;
  feed_url: string;
  source_type: string | null;
  subject_did: string | null;
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

function docScopeOf(sub: SubscriptionRow): DocScope | null {
  if (sub.source_type !== 'atproto.documents' || !sub.subject_did) return null;
  return {
    did: sub.subject_did,
    pub: sub.feed_url.startsWith('at://') ? sub.feed_url : undefined,
  };
}

/**
 * Resolve one query's source selection against the reader's live subscriptions.
 * Keys that name no subscription (an unsubscribed feed, `bsky~follows` until
 * follows matching lands) cover nothing.
 */
export function resolveQueryScope(
  sourceMode: SourceMode,
  sourceKeys: string[],
  subs: SubscriptionRow[]
): { feedUrls: Set<string>; docScopes: DocScope[] } {
  const keys = new Set(sourceKeys);
  const feedUrls = new Set<string>();
  const docScopes: DocScope[] = [];
  for (const sub of subs) {
    const key = sourceKeyOf(sub);
    if (!key) continue;
    // Legacy documents keys name the author DID instead of the subscription.
    const legacyDocKey = sub.subject_did ? `${sub.subject_did}~documents` : null;
    const named = keys.has(key) || (legacyDocKey !== null && keys.has(legacyDocKey));
    const included = sourceMode === 'all' ? true : sourceMode === 'include' ? named : !named;
    if (!included) continue;
    if (isFeedSubscription(sub)) {
      feedUrls.add(sub.feed_url);
    } else {
      const scope = docScopeOf(sub);
      if (scope) docScopes.push(scope);
    }
  }
  return { feedUrls, docScopes };
}

export function docInAnyScope(
  doc: { authorDid: string; siteUri: string },
  scopes: DocScope[]
): boolean {
  return scopes.some((s) => doc.authorDid === s.did && (!s.pub || doc.siteUri === s.pub));
}

/** Tiers whose plan includes saved searches, for filtering in SQL. */
function entitledTiers(): string[] {
  return ALL_TIERS.filter((tier) => getLimitsForTier(tier).maxSavedSearches > 0);
}

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
    `SELECT q.*, u.tier FROM saved_queries q JOIN users u ON u.did = q.user_did
      WHERE u.tier IN (${placeholders(tiers.length)})
      ORDER BY q.user_did, q.created_at, q.channel_uuid`
  )
    .bind(...tiers)
    .all<SavedQueryRow & { tier: string }>();

  const byUser = new Map<string, (SavedQueryRow & { tier: string })[]>();
  for (const row of rows.results ?? []) {
    const list = byUser.get(row.user_did) ?? [];
    if (list.length < getLimitsForTier(row.tier).maxSavedSearches) list.push(row);
    byUser.set(row.user_did, list);
  }
  if (byUser.size === 0) return [];

  const subsByUser = new Map<string, SubscriptionRow[]>();
  for (const users of chunk([...byUser.keys()], IN_CHUNK)) {
    const subs = await env.DB.prepare(
      `SELECT user_did, record_uri, feed_url, source_type, subject_did
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
        subs
      );
      active.push({
        userDid: did,
        channelUuid: q.channel_uuid,
        ftsQuery: q.fts_query,
        updatedAt: q.updated_at,
        backfillState: q.backfill_state,
        backfillFeedAfter: q.backfill_feed_after,
        backfillDocAfter: q.backfill_doc_after,
        ...scope,
      });
    }
  }
  return active;
}

// --- streams of new items ------------------------------------------------------

/** One item, as the matcher indexes it. */
export interface MatchDoc {
  kind: 'feed' | 'document';
  itemKey: string;
  /** feed_url for feed items, the author DID for documents. */
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

/** The newest positions of both streams, where a fresh matcher starts. */
export async function streamHeads(env: Env): Promise<{ seq: number; doc: DocCursor }> {
  const [seq, doc] = await env.DB.batch([
    env.DB.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM feed_items`),
    env.DB.prepare(
      `SELECT indexed_at AS at, record_uri AS uri FROM documents_v2
        ORDER BY indexed_at DESC, record_uri DESC LIMIT 1`
    ),
  ]);
  const docRow = (doc.results ?? [])[0] as { at: number; uri: string } | undefined;
  return {
    seq: ((seq.results ?? [])[0] as { seq: number } | undefined)?.seq ?? 0,
    doc: docRow ?? { at: 0, uri: '' },
  };
}

/**
 * The next page of both streams: cheap columns only, so items no query covers
 * are skipped before their bodies are read. Documents stay `settleMs` behind
 * now: `indexed_at` is a write-time clock, and a row written in the same
 * millisecond as the cursor with a smaller URI would otherwise be passed.
 */
export async function readStreamPage(
  env: Env,
  cursors: { seq: number; doc: DocCursor },
  pageSize: number,
  settledBefore: number
): Promise<{ feeds: FeedHead[]; docs: DocHead[] }> {
  const [feeds, docs] = await env.DB.batch([
    env.DB.prepare(
      `SELECT seq, feed_url, published_at FROM feed_items WHERE seq > ? ORDER BY seq LIMIT ?`
    ).bind(cursors.seq, pageSize),
    env.DB.prepare(
      `SELECT record_uri, author_did, site_uri, published_at, indexed_at FROM documents_v2
        WHERE (indexed_at > ? OR (indexed_at = ? AND record_uri > ?)) AND indexed_at < ?
        ORDER BY indexed_at, record_uri LIMIT ?`
    ).bind(cursors.doc.at, cursors.doc.at, cursors.doc.uri, settledBefore, pageSize),
  ]);
  return {
    feeds: (feeds.results ?? []) as FeedHead[],
    docs: (docs.results ?? []) as DocHead[],
  };
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
        `SELECT seq, feed_url, published_at FROM feed_items
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
  const feeds = results.slice(0, feedStep.length).flatMap((r) => (r.results ?? []) as FeedHead[]);
  const docs = results.slice(feedStep.length).flatMap((r) => (r.results ?? []) as DocHead[]);
  return {
    feeds,
    docs,
    feedAfter: feedStep.at(-1) ?? query.backfillFeedAfter,
    docAfter: authorStep.at(-1) ?? query.backfillDocAfter,
    done: feedUrls.length <= feedStep.length && authors.length <= authorStep.length,
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
  r2Budget: { left: number }
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
  let budgetSkipped = 0;
  for (const row of feedRows) {
    const item = parseJson<FeedItem>(row.item_json);
    if (!item) continue;
    let html = '';
    if (item.bodyStored && env.ITEM_BODIES) {
      if (r2Budget.left > 0) {
        r2Budget.left--;
        html = (await readStoredBody(env, row.feed_url, row.guid)) ?? '';
      } else {
        budgetSkipped++;
      }
    }
    html ||= item.content || item.contentLead || '';
    const body =
      htmlToText(html, MATCH_BODY_CHARS) || htmlToText(item.summary ?? '', MATCH_BODY_CHARS);
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
  if (budgetSkipped > 0) log.info('saved_search_r2_budget_spent', { budgetSkipped });

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

/** The key one story matches under in a channel: its normalized URL, else the item. */
export function dedupKey(doc: Pick<MatchDoc, 'url' | 'itemKey'>): string {
  return (doc.url && normalizeArticleUrl(doc.url)) || `item:${doc.itemKey}`;
}

// D1 binds at most 100 parameters per statement: 6 shared + 7 per row.
const MATCH_ROWS_PER_STATEMENT = 13;

/**
 * Insert statements for `hits`, a few rows each. Every insert is guarded on
 * the query still being the version the matcher loaded: an edit made while a
 * pass was running cleared the channel's matches and restarted its backfill,
 * and must not get hits for the old predicate written back on top.
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
      const values = rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
      statements.push(
        env.DB.prepare(
          `INSERT INTO channel_matches
             (user_did, channel_uuid, dedup_key, item_key, source_kind, source_ref, feed_seq,
              snippet, published_at, matched_at)
           SELECT ?, ?, v.column1, v.column2, v.column3, v.column4, v.column5, v.column6,
                  v.column7, ?
             FROM (VALUES ${values}) AS v
            WHERE EXISTS (SELECT 1 FROM saved_queries
                           WHERE user_did = ? AND channel_uuid = ? AND updated_at = ?)
           ON CONFLICT (user_did, channel_uuid, dedup_key) DO NOTHING`
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
          ]),
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
export function percolatorStub(env: Env) {
  return env.PERCOLATOR.get(env.PERCOLATOR.idFromName('percolator-0'));
}

/** Wake the matcher if saved searches are on. Cheap enough for every cron minute. */
export async function nudgePercolator(env: Env): Promise<void> {
  if (!(await isSavedSearchEnabled(env))) return;
  await percolatorStub(env).nudge();
}
