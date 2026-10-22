import type { Env, FeedItem } from '../types';
import { ARTICLE_WINDOW_PER_FEED } from '../config/window';
import { rssSubscriptionPredicate } from './ingest';
import { READ_UPSERT_CONFLICT, UNREAD_UPSERT_CONFLICT, chunkArray } from './reading';
import { handleCreateSaved, handleDeleteSavedByGuid } from './saved';
import { itemBodyKey } from './item-bodies';
import { documentBlobUrl, documentHtml } from '../services/document-html';
import { MAX_DOCUMENTS_PER_AUTHOR } from '../services/standard-site';
import {
  touchAppPassword,
  verifyAppPassword,
  type AppPasswordOwner,
} from '../services/app-passwords';
import { findSessionIdForDid } from '../services/oauth';
import { checkRateLimit } from '../services/rate-limit';
import { nudgeSearchIndex } from '../services/search-index';
import { generateTid } from '../utils/tid';
import { sha256Hex } from '../utils/sha256';
import { setContextDid } from '../utils/request-context';
import { log } from '../utils/logger';

/**
 * The Google Reader API, so NetNewsWire, Reeder, ReadKit and Unread can use
 * Skyreader as their sync service. A reader points their app at
 * `<api origin>/api/greader` (or the origin itself for apps that append
 * FreshRSS's `/api/greader.php`), signs in with their handle and an app password
 * (services/app-passwords.ts), and gets their subscriptions — newsletters,
 * Bluesky sources and standard.site publications included — with read state
 * shared with the web app.
 *
 * The model maps onto what the web app already has:
 *
 *  - An item is a `feed_items` row, its id the row's `seq` (decimal in
 *    `stream/items/ids`, the 16-hex-digit long form elsewhere; both accepted),
 *    or a standard.site document, its id DOC_ID_BASE plus its `documents_v2`
 *    rowid. A documents subscription is listed as a feed whose URL is its
 *    publication's at:// URI, or `at://<did>` when it follows everything the
 *    author publishes.
 *  - Read is the `read` label in `item_labels_cache`, keyed by guid (record
 *    URI for a document, as the web app keys it), written with the same
 *    user-time guard as the web app's own read writes.
 *  - Starred is saved: the web app's star is its save, so starring delegates to
 *    the save routes (snapshot, limits, Semble/Margin backing and all) as the
 *    stored OAuth session, like the AT Intents endpoints in routes/xrpc.ts.
 *    Matching is by guid (record URI for a document), which is how the web app
 *    keys those saves; an article saved by link is not starred here even when
 *    a feed also carries it.
 *  - The reading list is each subscribed feed's newest ARTICLE_WINDOW_PER_FEED
 *    items, the window the web app shows and counts unread over. Older archive
 *    items stay out, or an app would show a feed's whole history as unread.
 *    A documents subscription's window is its newest MAX_DOCUMENTS_PER_AUTHOR,
 *    what the web app serves for it. The starred stream is not windowed: a
 *    save from long ago is still starred.
 *
 * Documents are read from D1 whatever `documents_v2_enabled` says: that flag
 * picks the web app's source between D1 and the feed proxy, and this API has
 * no proxy path. Subscribing, unsubscribing and folders are managed in
 * Skyreader; the subscription-editing calls answer 501.
 *
 * Auth is the `Authorization: GoogleLogin auth=<token>` header, never a cookie,
 * so the `T` write token clients send with POSTs is accepted but not checked:
 * there is no ambient credential for a cross-site request to ride.
 */

export const GREADER_PATH = '/api/greader';
// FreshRSS-style apps append `/api/greader.php` to the server address
// themselves; answering there too means the reader can type just the origin.
const PATH_PREFIXES = [`${GREADER_PATH}/`, '/api/greader.php/'];

const LONG_ID_PREFIX = 'tag:google.com,2005:reader/item/';
const READING_LIST = 'user/-/state/com.google/reading-list';
const READ = 'user/-/state/com.google/read';
const STARRED = 'user/-/state/com.google/starred';

// Rate-limit buckets (services/rate-limit.ts). Sign-in is keyed by IP: it runs
// before there's a reader to key it on.
export const GREADER_RATE_LIMIT_KEY = '/api/greader';
export const GREADER_LOGIN_RATE_LIMIT_KEY = '/api/greader:login';
export const GREADER_STAR_RATE_LIMIT_KEY = '/api/greader:star';

const MAX_ID_REFS = 10_000;
const DEFAULT_ID_REFS = 1000;
const MAX_STREAM_ITEMS = 1000;
const DEFAULT_STREAM_ITEMS = 20;
// Ids per `stream/items/contents` or `edit-tag` request.
const MAX_ITEM_IDS = 1000;
// Bound parameters per D1 statement stay under its limit of 100.
const ID_CHUNK = 80;
// Feed bodies over the archive's inline cap live in R2 (routes/item-bodies.ts).
// A page of a thousand long newsletters must not be held whole: past this many
// bytes an item carries its stored lead instead.
const MAX_BODY_BYTES_PER_RESPONSE = 20 * 1024 * 1024;
const R2_CONCURRENCY = 6;

/** The path under the API prefix (`reader/api/0/...`), or null when it isn't one. */
export function greaderSubpath(pathname: string): string | null {
  for (const prefix of PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) return pathname.slice(prefix.length);
  }
  return null;
}

// --- responses -----------------------------------------------------------------

function text(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function unauthorized(): Response {
  // The header is what Google Reader clients look for to show a sign-in error.
  return text('Unauthorized\n', 401, { 'Google-Reader-API-Error': 'unauthorized' });
}

// --- ids and streams -----------------------------------------------------------

export function longItemId(seq: number): string {
  return LONG_ID_PREFIX + seq.toString(16).padStart(16, '0');
}

/**
 * An item id in any of the forms clients send: long (`tag:...item/<hex>`),
 * decimal, or Google's signed decimal for ids past 2^63. Null if it's none.
 */
export function parseItemId(raw: string): number | null {
  const id = raw.trim();
  if (id.startsWith(LONG_ID_PREFIX)) {
    const hex = id.slice(LONG_ID_PREFIX.length);
    if (!/^[0-9a-f]{1,16}$/i.test(hex)) return null;
    const value = BigInt(`0x${hex}`);
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  if (!/^-?\d{1,20}$/.test(id)) return null;
  let value = BigInt(id);
  if (value < 0n) value += 1n << 64n;
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

type Stream =
  | { kind: 'reading-list' }
  | { kind: 'read' }
  | { kind: 'starred' }
  | { kind: 'feed'; feedUrl: string }
  | { kind: 'label'; label: string };

/** A stream id. `user/<anything>/` is the same reader as `user/-/`. */
export function parseStreamId(id: string): Stream | null {
  if (id.startsWith('feed/')) {
    const feedUrl = id.slice('feed/'.length);
    return feedUrl ? { kind: 'feed', feedUrl } : null;
  }
  const match = /^user\/[^/]+\/(state\/com\.google|label)\/(.+)$/.exec(id);
  if (!match) return null;
  if (match[1] === 'label') return { kind: 'label', label: match[2] };
  switch (match[2]) {
    case 'reading-list':
      return { kind: 'reading-list' };
    case 'read':
      return { kind: 'read' };
    case 'starred':
      return { kind: 'starred' };
    default:
      return null;
  }
}

/** A state an `xt`/`it` filter or `edit-tag` names: read or starred, else null. */
function itemState(id: string): 'read' | 'starred' | 'kept-unread' | null {
  const match = /^user\/[^/]+\/state\/com\.google\/(read|starred|kept-unread)$/.exec(id);
  return match ? (match[1] as 'read' | 'starred' | 'kept-unread') : null;
}

// --- SQL -----------------------------------------------------------------------

/** Numbered bind parameters; ?1 is always the reader's DID. */
class Binds {
  readonly values: unknown[];
  constructor(did: string) {
    this.values = [did];
  }
  add(value: unknown): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

// A document's item id is this plus its `documents_v2` rowid, so it can't meet
// a `feed_items` seq. The rowid is stable: an upsert keeps it, and D1 doesn't
// VACUUM. Every id stays under 2^53.
export const DOC_ID_BASE = 2 ** 50;

/**
 * Every query that lists items reads these columns, whichever table the item
 * came from: `feed_url` is the stream key (a feed URL, or a documents
 * subscription's key), `item_key` what read state and saves are keyed by, and
 * `url` the item's link.
 */
const ITEM_COLUMNS =
  'id, kind, feed_url, item_key, first_seen_at, item_json, content_hash, url, author_did';

function articleColumns(fi: string): string {
  return `${fi}.seq AS id, 'article' AS kind, ${fi}.feed_url, ${fi}.guid AS item_key,
          ${fi}.first_seen_at, ${fi}.item_json, ${fi}.content_hash,
          json_extract(${fi}.item_json, '$.url') AS url, NULL AS author_did`;
}

function documentColumns(d: string, streamKey: string): string {
  return `${DOC_ID_BASE} + ${d}.rowid AS id, 'document' AS kind, ${streamKey} AS feed_url,
          ${d}.record_uri AS item_key, ${d}.indexed_at AS first_seen_at,
          ${d}.record_json AS item_json, '' AS content_hash, ${d}.canonical_url AS url,
          ${d}.author_did`;
}

/** The key a documents subscription is listed under: its publication, or its author. */
function docStreamKey(sc: string): string {
  return `CASE WHEN COALESCE(${sc}.feed_url, '') = '' THEN 'at://' || ${sc}.subject_did
               ELSE ${sc}.feed_url END`;
}

function docSubscriptionPredicate(sc: string): string {
  return `${sc}.user_did = ?1 AND ${sc}.active = 1
          AND ${sc}.source_type = 'atproto.documents' AND ${sc}.subject_did IS NOT NULL`;
}

/** A documents subscription (alias `sc`) covers the document (alias `d`). */
function docCoveredSql(sc: string, d: string): string {
  return `${sc}.subject_did = ${d}.author_did
          AND (COALESCE(${sc}.feed_url, '') = '' OR ${sc}.feed_url = ${d}.site_uri)`;
}

function readSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM item_labels_cache il
                   WHERE il.user_did = ?1 AND il.item_key = ${alias}.item_key
                     AND il.item_type = ${alias}.kind AND il.label = 'read' AND il.deleted_at IS NULL)`;
}

function starredSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM saved_articles sa
                   WHERE sa.user_did = ?1 AND sa.item_guid = ${alias}.item_key)`;
}

/** The reader's active feed subscriptions, as a predicate over `alias.feed_url`. */
function subscribedSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM subscriptions_cache sc
                   WHERE sc.user_did = ?1 AND sc.feed_url = ${alias}.feed_url AND sc.active = 1
                     AND ${rssSubscriptionPredicate('sc')})`;
}

/**
 * `WITH ... win`: `win` is the stream's items, in ITEM_COLUMNS. Every query
 * that lists items starts here, so the subscription check and the window are
 * in one place.
 */
function streamCte(stream: Stream, binds: Binds): string {
  let feedFilter = '';
  let docFilter = '';
  if (stream.kind === 'feed') {
    const key = binds.add(stream.feedUrl);
    feedFilter = `AND feed_url = ${key}`;
    docFilter = `AND ${docStreamKey('sc')} = ${key}`;
  }
  if (stream.kind === 'label') {
    const label = binds.add(stream.label);
    feedFilter = `AND category = ${label}`;
    docFilter = `AND sc.category = ${label}`;
  }
  const subs = `subs AS (
      SELECT DISTINCT feed_url FROM subscriptions_cache
       WHERE user_did = ?1 AND active = 1 AND feed_url <> ''
         AND ${rssSubscriptionPredicate()} ${feedFilter}),
    dsubs AS (
      SELECT DISTINCT sc.subject_did, COALESCE(sc.feed_url, '') AS scope,
             ${docStreamKey('sc')} AS stream_key
        FROM subscriptions_cache sc
       WHERE ${docSubscriptionPredicate('sc')} ${docFilter})`;
  // A document two subscriptions cover (the author's and one publication's) is
  // listed once, under the publication: MAX picks the non-empty scope, and the
  // bare columns come from that row.
  const docs = (join: string, where = '') => `
      SELECT ${documentColumns('d', 'dsubs.stream_key')}, MAX(dsubs.scope) AS scope
        FROM dsubs JOIN documents_v2 d ON ${join}
       ${where}
       GROUP BY d.rowid`;

  if (stream.kind === 'starred') {
    const saved = `IN (SELECT item_guid FROM saved_articles WHERE user_did = ?1 AND item_guid IS NOT NULL)`;
    return `WITH ${subs},
      dwin AS (${docs(
        `d.author_did = dsubs.subject_did AND (dsubs.scope = '' OR d.site_uri = dsubs.scope)`,
        `WHERE d.record_uri ${saved}`
      )}),
      win AS (
        SELECT ${articleColumns('fi')}
          FROM subs JOIN feed_items fi ON fi.feed_url = subs.feed_url
         WHERE fi.guid ${saved}
        UNION ALL
        SELECT ${ITEM_COLUMNS} FROM dwin)`;
  }
  // The newest-K window per feed and per documents subscription: an index seek
  // each, the same slices the web app shows and counts unread over.
  return `WITH ${subs},
    dwin AS (${docs(
      `d.rowid IN (SELECT d2.rowid FROM documents_v2 d2
                    WHERE d2.author_did = dsubs.subject_did
                      AND (dsubs.scope = '' OR d2.site_uri = dsubs.scope)
                    ORDER BY d2.published_at DESC
                    LIMIT ${MAX_DOCUMENTS_PER_AUTHOR})`
    )}),
    items AS (
      SELECT ${articleColumns('fi')}
        FROM subs JOIN feed_items fi
          ON fi.seq IN (SELECT f2.seq FROM feed_items f2
                         WHERE f2.feed_url = subs.feed_url
                         ORDER BY f2.published_at DESC, f2.seq DESC
                         LIMIT ${ARTICLE_WINDOW_PER_FEED})
      UNION ALL
      SELECT ${ITEM_COLUMNS} FROM dwin),
    win AS (
      SELECT ${ITEM_COLUMNS} FROM items
       ${stream.kind === 'read' ? `WHERE ${readSql('items')}` : ''})`;
}

/**
 * The given items, in ITEM_COLUMNS, keeping only those in a subscription of the
 * reader's. Not windowed: an app may ask after an item that has since aged out.
 */
function itemsByIdSql(ids: number[], binds: Binds): string {
  const seqs = ids.filter((id) => id < DOC_ID_BASE);
  const rowids = ids.filter((id) => id >= DOC_ID_BASE).map((id) => id - DOC_ID_BASE);
  const parts: string[] = [];
  if (seqs.length) {
    parts.push(`SELECT ${articleColumns('fi')} FROM feed_items fi
                 WHERE fi.seq IN (${seqs.map((seq) => binds.add(seq)).join(',')})
                   AND ${subscribedSql('fi')}`);
  }
  if (rowids.length) {
    // Listed under the covering subscription's key, a publication's first.
    const streamKey = `(SELECT ${docStreamKey('sc')} FROM subscriptions_cache sc
                         WHERE ${docSubscriptionPredicate('sc')} AND ${docCoveredSql('sc', 'd')}
                         ORDER BY COALESCE(sc.feed_url, '') DESC LIMIT 1)`;
    parts.push(`SELECT ${ITEM_COLUMNS} FROM (
                  SELECT ${documentColumns('d', streamKey)} FROM documents_v2 d
                   WHERE d.rowid IN (${rowids.map((rowid) => binds.add(rowid)).join(',')}))
                 WHERE feed_url IS NOT NULL`);
  }
  return parts.join(' UNION ALL ');
}

// --- params --------------------------------------------------------------------

/** Query string plus a form-encoded POST body: clients send parameters either way. */
async function readParams(request: Request, url: URL): Promise<URLSearchParams> {
  const params = new URLSearchParams(url.search);
  if (request.method === 'POST') {
    const body = await request.text();
    for (const [key, value] of new URLSearchParams(body)) params.append(key, value);
  }
  return params;
}

function intParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || !/^\d{1,16}$/.test(raw)) return null;
  return Number(raw);
}

function countParam(params: URLSearchParams, fallback: number, max: number): number {
  const n = intParam(params, 'n');
  return n === null || n < 1 ? fallback : Math.min(n, max);
}

// --- auth ----------------------------------------------------------------------

function authToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^GoogleLogin\s+auth=(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Does the sign-in name belong to this reader? Their handle (an @ is fine) or DID. */
function nameMatches(email: string, owner: AppPasswordOwner): boolean {
  const name = email.trim().toLowerCase().replace(/^@/, '');
  return name === owner.handle.toLowerCase() || name === owner.did.toLowerCase();
}

function loginRateLimit(request: Request, env: Env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return checkRateLimit(env, `ip:${ip}`, GREADER_LOGIN_RATE_LIMIT_KEY);
}

async function handleClientLogin(request: Request, env: Env): Promise<Response> {
  // POST only, the password in the body: a query string would put the
  // credential, which is also the bearer token, into request logs.
  if (request.method !== 'POST') return text('Method not allowed\n', 405);
  const rateLimit = await loginRateLimit(request, env);
  if (!rateLimit.allowed) {
    return text('Error=RateLimited\n', 429, { 'Retry-After': String(rateLimit.retryAfter ?? 60) });
  }

  const params = new URLSearchParams(await request.text());
  const email = params.get('Email') ?? '';
  const password = params.get('Passwd') ?? '';
  const owner = password ? await verifyAppPassword(env, password) : null;
  if (!owner || !nameMatches(email, owner)) {
    return text('Error=BadAuthentication\n', 401);
  }
  // The password itself is the token: revoking it in Settings signs the app
  // out, and there is no second secret to store or expire.
  return text(`SID=${password}\nLSID=null\nAuth=${password}\n`);
}

// --- subscriptions -------------------------------------------------------------

interface SubscriptionRow {
  feed_url: string;
  title: string | null;
  category: string | null;
  site_url: string | null;
  icon_url: string | null;
}

/** The reader's feeds and documents subscriptions, one row per stream key, keyed by it. */
async function loadSubscriptions(env: Env, did: string): Promise<Map<string, SubscriptionRow>> {
  const rows = await env.DB.prepare(
    `SELECT sc.id, sc.feed_url,
            COALESCE(NULLIF(sc.custom_title, ''), NULLIF(sc.title, ''), f.title, sc.feed_url) AS title,
            NULLIF(sc.category, '') AS category,
            COALESCE(sc.site_url, f.site_url) AS site_url,
            COALESCE(sc.custom_icon_url, f.image_url) AS icon_url
       FROM subscriptions_cache sc
       LEFT JOIN feeds f ON f.feed_url = sc.feed_url
      WHERE sc.user_did = ?1 AND sc.active = 1 AND sc.feed_url <> ''
        AND ${rssSubscriptionPredicate('sc')}
     UNION ALL
     SELECT sc.id, ${docStreamKey('sc')} AS feed_url,
            COALESCE(NULLIF(sc.custom_title, ''), NULLIF(sc.title, ''), ${docStreamKey('sc')}) AS title,
            NULLIF(sc.category, '') AS category, sc.site_url, sc.custom_icon_url AS icon_url
       FROM subscriptions_cache sc
      WHERE ${docSubscriptionPredicate('sc')}
      ORDER BY 1`
  )
    .bind(did)
    .all<SubscriptionRow>();
  const subs = new Map<string, SubscriptionRow>();
  for (const row of rows.results) if (!subs.has(row.feed_url)) subs.set(row.feed_url, row);
  return subs;
}

function labelId(label: string): string {
  return `user/-/label/${label}`;
}

async function handleSubscriptionList(env: Env, did: string): Promise<Response> {
  const subs = await loadSubscriptions(env, did);
  return json({
    subscriptions: [...subs.values()].map((sub) => ({
      id: `feed/${sub.feed_url}`,
      title: sub.title ?? sub.feed_url,
      categories: sub.category ? [{ id: labelId(sub.category), label: sub.category }] : [],
      url: sub.feed_url,
      htmlUrl: sub.site_url ?? '',
      iconUrl: sub.icon_url ?? '',
    })),
  });
}

async function handleTagList(env: Env, did: string): Promise<Response> {
  const subs = await loadSubscriptions(env, did);
  const labels = [
    ...new Set([...subs.values()].map((s) => s.category).filter(Boolean)),
  ] as string[];
  return json({
    tags: [
      { id: STARRED },
      ...labels.sort().map((label) => ({ id: labelId(label), type: 'folder' })),
    ],
  });
}

async function handleUnreadCount(env: Env, did: string): Promise<Response> {
  const binds = new Binds(did);
  const rows = await env.DB.prepare(
    `${streamCte({ kind: 'reading-list' }, binds)}
     SELECT win.feed_url, COUNT(*) AS unread, MAX(win.first_seen_at) AS newest
       FROM win WHERE NOT ${readSql('win')}
      GROUP BY win.feed_url`
  )
    .bind(...binds.values)
    .all<{ feed_url: string; unread: number; newest: number }>();

  const subs = await loadSubscriptions(env, did);
  const counts: Array<{ id: string; count: number; newestItemTimestampUsec: string }> = [];
  const labels = new Map<string, { count: number; newest: number }>();
  let total = 0;
  let newestOverall = 0;
  for (const row of rows.results) {
    counts.push({
      id: `feed/${row.feed_url}`,
      count: row.unread,
      newestItemTimestampUsec: String(row.newest * 1000),
    });
    total += row.unread;
    newestOverall = Math.max(newestOverall, row.newest);
    const label = subs.get(row.feed_url)?.category;
    if (label) {
      const entry = labels.get(label) ?? { count: 0, newest: 0 };
      entry.count += row.unread;
      entry.newest = Math.max(entry.newest, row.newest);
      labels.set(label, entry);
    }
  }
  for (const [label, entry] of labels) {
    counts.push({
      id: labelId(label),
      count: entry.count,
      newestItemTimestampUsec: String(entry.newest * 1000),
    });
  }
  counts.push({
    id: READING_LIST,
    count: total,
    newestItemTimestampUsec: String(newestOverall * 1000),
  });
  return json({ max: total, unreadcounts: counts });
}

// --- streams -------------------------------------------------------------------

interface StreamQuery {
  stream: Stream;
  exclude: Set<string>;
  include: Set<string>;
  // Unix seconds: `ot` keeps items first seen at or after it, `nt` before it.
  ot: number | null;
  nt: number | null;
  continuation: { at: number; id: number } | null;
  oldestFirst: boolean;
  limit: number;
}

function streamQuery(params: URLSearchParams, streamId: string, limit: number): StreamQuery | null {
  const stream = parseStreamId(streamId);
  if (!stream) return null;
  const states = (name: string) =>
    new Set(
      params
        .getAll(name)
        .map(itemState)
        .filter((s): s is 'read' | 'starred' => s === 'read' || s === 'starred')
    );
  return {
    stream,
    exclude: states('xt'),
    include: states('it'),
    ot: intParam(params, 'ot'),
    nt: intParam(params, 'nt'),
    continuation: continuationParam(params),
    oldestFirst: params.get('r') === 'o',
    limit,
  };
}

// A stream is ordered by first-seen time, then id, since articles and
// documents number their ids apart; the continuation is that pair.
function continuationParam(params: URLSearchParams): StreamQuery['continuation'] {
  const match = /^(\d{1,16})_(\d{1,16})$/.exec(params.get('c') ?? '');
  return match ? { at: Number(match[1]), id: Number(match[2]) } : null;
}

interface StreamRow {
  id: number;
  kind: 'article' | 'document';
  feed_url: string;
  item_key: string;
  first_seen_at: number;
  item_json: string;
  content_hash: string;
  url: string | null;
  author_did: string | null;
  read: number;
  starred: number;
}

/** One page of a stream, plus the continuation for the next. */
async function queryStream(
  env: Env,
  did: string,
  query: StreamQuery,
  withItems: boolean
): Promise<{ rows: StreamRow[]; continuation?: string }> {
  const binds = new Binds(did);
  const where: string[] = [];
  for (const state of query.exclude) {
    where.push(`NOT ${state === 'read' ? readSql('win') : starredSql('win')}`);
  }
  for (const state of query.include) {
    where.push(state === 'read' ? readSql('win') : starredSql('win'));
  }
  if (query.ot !== null) where.push(`win.first_seen_at >= ${binds.add(query.ot * 1000)}`);
  if (query.nt !== null) where.push(`win.first_seen_at < ${binds.add(query.nt * 1000)}`);
  if (query.continuation !== null) {
    const at = binds.add(query.continuation.at);
    const id = binds.add(query.continuation.id);
    where.push(`(win.first_seen_at, win.id) ${query.oldestFirst ? '>' : '<'} (${at}, ${id})`);
  }
  const cte = streamCte(query.stream, binds);
  const columns = withItems
    ? `win.*, ${readSql('win')} AS read, ${starredSql('win')} AS starred`
    : 'win.id, win.first_seen_at';
  const direction = query.oldestFirst ? 'ASC' : 'DESC';
  const rows = await env.DB.prepare(
    `${cte}
     SELECT ${columns} FROM win
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY win.first_seen_at ${direction}, win.id ${direction}
      LIMIT ${binds.add(query.limit + 1)}`
  )
    .bind(...binds.values)
    .all<StreamRow>();

  const hasMore = rows.results.length > query.limit;
  const page = hasMore ? rows.results.slice(0, query.limit) : rows.results;
  const last = page[page.length - 1];
  return {
    rows: page,
    continuation: hasMore ? `${last.first_seen_at}_${last.id}` : undefined,
  };
}

async function handleStreamItemIds(env: Env, did: string, params: URLSearchParams) {
  const query = streamQuery(
    params,
    params.get('s') ?? '',
    countParam(params, DEFAULT_ID_REFS, MAX_ID_REFS)
  );
  if (!query) return text('Unknown stream\n', 400);
  const { rows, continuation } = await queryStream(env, did, query, false);
  return json({
    itemRefs: rows.map((row) => ({
      id: String(row.id),
      directStreamIds: [],
      timestampUsec: String(row.first_seen_at * 1000),
    })),
    ...(continuation ? { continuation } : {}),
  });
}

async function handleStreamContents(
  env: Env,
  did: string,
  streamId: string,
  params: URLSearchParams
): Promise<Response> {
  const query = streamQuery(
    params,
    streamId,
    countParam(params, DEFAULT_STREAM_ITEMS, MAX_STREAM_ITEMS)
  );
  if (!query) return text('Unknown stream\n', 400);
  const [{ rows, continuation }, subs] = await Promise.all([
    queryStream(env, did, query, true),
    loadSubscriptions(env, did),
  ]);
  return json({
    id: streamId,
    updated: Math.floor(Date.now() / 1000),
    items: await renderItems(env, rows, subs),
    ...(continuation ? { continuation } : {}),
  });
}

/** Rows for the given ids that sit in one of the reader's subscriptions. */
async function loadItems(env: Env, did: string, ids: number[]): Promise<StreamRow[]> {
  if (ids.length === 0) return [];
  const statements = chunkArray(ids, ID_CHUNK).map((chunk) => {
    const binds = new Binds(did);
    return env.DB.prepare(
      `SELECT x.*, ${readSql('x')} AS read, ${starredSql('x')} AS starred
         FROM (${itemsByIdSql(chunk, binds)}) x`
    ).bind(...binds.values);
  });
  const results = await env.DB.batch<StreamRow>(statements);
  return results.flatMap((result) => result.results ?? []);
}

function itemIdsParam(params: URLSearchParams): number[] | null {
  const raw = params.getAll('i');
  if (raw.length > MAX_ITEM_IDS) return null;
  const ids = new Set<number>();
  for (const value of raw) {
    const id = parseItemId(value);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

async function handleItemContents(
  env: Env,
  did: string,
  params: URLSearchParams
): Promise<Response> {
  const ids = itemIdsParam(params);
  if (!ids) return text(`At most ${MAX_ITEM_IDS} ids per request\n`, 400);
  const [rows, subs] = await Promise.all([loadItems(env, did, ids), loadSubscriptions(env, did)]);
  // In the order asked for, which is what clients expect back.
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return json({
    id: READING_LIST,
    updated: Math.floor(Date.now() / 1000),
    items: await renderItems(env, rows, subs),
  });
}

// --- items ---------------------------------------------------------------------

interface DocumentRecordFields {
  title?: string;
  description?: string;
  publishedAt?: string;
  textContent?: string;
  content?: unknown;
  coverImage?: { ref?: { $link?: string } };
}

/**
 * The row as a feed item. A document is read into the same shape, carrying the
 * body it renders to, since it has no stored body to fetch.
 */
function parseItem(row: StreamRow): FeedItem | null {
  try {
    if (row.kind === 'article') return JSON.parse(row.item_json) as FeedItem;
    const record = JSON.parse(row.item_json) as DocumentRecordFields;
    const authorDid = row.author_did ?? '';
    const cover = record.coverImage?.ref?.$link;
    return {
      title: record.title ?? '',
      url: validUrl(row.url ?? ''),
      publishedAt: record.publishedAt ?? '',
      summary: record.description,
      content: documentHtml(record, authorDid),
      imageUrl: cover ? documentBlobUrl(authorDid, cover) : undefined,
    } as FeedItem;
  } catch {
    log.warn('greader_item_unparseable', { id: row.id });
    return null;
  }
}

/**
 * The item's whole body: the inline content, or the stored copy of one over
 * the inline cap while the response's byte budget lasts, else what the row kept.
 * Only a stored copy matching the row's current content hash is served, as
 * routes/item-bodies.ts does.
 */
async function itemBody(
  env: Env,
  row: StreamRow,
  item: FeedItem,
  budget: { bytes: number }
): Promise<string> {
  if (item.contentTruncated && item.bodyStored && env.ITEM_BODIES && budget.bytes > 0) {
    const object = await env.ITEM_BODIES.get(await itemBodyKey(row.feed_url, row.item_key));
    if (
      object &&
      object.customMetadata?.contentHash === row.content_hash &&
      object.size <= budget.bytes
    ) {
      budget.bytes -= object.size;
      return object.text();
    }
    // An unread body holds a connection open; let it go.
    if (object) await object.body.cancel();
  }
  return item.content || item.contentLead || item.summary || '';
}

async function renderItems(
  env: Env,
  rows: StreamRow[],
  subs: Map<string, SubscriptionRow>
): Promise<unknown[]> {
  const budget = { bytes: MAX_BODY_BYTES_PER_RESPONSE };
  const rendered = new Array<unknown>(rows.length);
  let next = 0;
  // A few R2 reads in flight at once, under the per-invocation connection cap.
  const workers = Array.from({ length: Math.min(R2_CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++;
      const row = rows[index];
      const item = parseItem(row);
      if (!item) continue;
      rendered[index] = renderItem(row, item, await itemBody(env, row, item, budget), subs);
    }
  });
  await Promise.all(workers);
  return rendered.filter((item) => item !== undefined);
}

function renderItem(
  row: StreamRow,
  item: FeedItem,
  body: string,
  subs: Map<string, SubscriptionRow>
): unknown {
  const sub = subs.get(row.feed_url);
  const publishedMs = Date.parse(item.publishedAt);
  const published = Math.floor(
    (Number.isNaN(publishedMs) ? row.first_seen_at : publishedMs) / 1000
  );
  const categories = [READING_LIST];
  if (row.read) categories.push(READ);
  if (row.starred) categories.push(STARRED);
  if (sub?.category) categories.push(labelId(sub.category));
  const links = item.url ? [{ href: item.url, type: 'text/html' }] : [];
  return {
    id: longItemId(row.id),
    crawlTimeMsec: String(row.first_seen_at),
    timestampUsec: String(row.first_seen_at * 1000),
    published,
    updated: published,
    title: item.title ?? '',
    canonical: links.map(({ href }) => ({ href })),
    alternate: links,
    summary: { direction: 'ltr', content: body },
    author: item.author ?? '',
    categories,
    origin: {
      streamId: `feed/${row.feed_url}`,
      title: sub?.title ?? row.feed_url,
      htmlUrl: sub?.site_url ?? '',
    },
    ...(item.imageUrl ? { enclosure: [{ href: item.imageUrl, type: 'image/jpeg' }] } : {}),
  };
}

// --- writes --------------------------------------------------------------------

/**
 * A read label's props, as the web app writes them (routes/reading.ts): a
 * document's also names its author.
 */
function readPropsSql(alias: string, readAt: string): string {
  const props = `'readAt', ${readAt}, 'itemUrl', ${alias}.url,
                 'itemTitle', json_extract(${alias}.item_json, '$.title')`;
  return `CASE WHEN ${alias}.kind = 'document'
               THEN json_object(${props}, 'authorDid', ${alias}.author_did)
               ELSE json_object(${props}) END`;
}

/** Mark the given items read (or unread) as the reader, now, in one statement per chunk. */
async function writeReadState(env: Env, did: string, ids: number[], read: boolean) {
  const nowMs = Date.now();
  const statements = chunkArray(ids, ID_CHUNK).map((chunk) => {
    const binds = new Binds(did);
    const at = binds.add(nowMs);
    const now = binds.add(Math.floor(nowMs / 1000));
    const items = itemsByIdSql(chunk, binds);
    // The rkey is a legacy PDS-record key nothing reads for a new row; a random
    // record-key-shaped value keeps the column's shape without a per-row TID.
    const sql = read
      ? `INSERT INTO item_labels_cache
           (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
         SELECT ?1, x.item_key, x.kind, 'read', ${readPropsSql('x', at)},
                lower(hex(randomblob(8))), ${now}, ${now}, ${at}
           FROM (${items}) x WHERE 1 = 1
         ${READ_UPSERT_CONFLICT}`
      : `INSERT INTO item_labels_cache
           (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, deleted_at, client_updated_at)
         SELECT ?1, x.item_key, x.kind, 'read', NULL, lower(hex(randomblob(8))), ${now}, ${now}, ${now}, ${at}
           FROM (${items}) x WHERE 1 = 1
         ${UNREAD_UPSERT_CONFLICT}`;
    return env.DB.prepare(sql).bind(...binds.values);
  });
  if (statements.length) await env.DB.batch(statements);
}

// Star changes carried out per edit-tag request. Each is a save or unsave
// through the save routes, about eight D1 statements, and an invocation gets
// 1,000 (backend/CLAUDE.md). Past this the request answers 503; the client's
// retry finds the first ones done (already starred is skipped) and goes on.
const MAX_STAR_CHANGES = 50;

function wordCount(html: string): number | undefined {
  const words = html
    .replace(/<[^>]*>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return words || undefined;
}

function validUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    new URL(url);
    return url;
  } catch {
    return '';
  }
}

/**
 * Star or unstar by delegating to the save routes as the reader's stored
 * session, so a star is a save in every way the web app's is. Returns an
 * error response when a change didn't land, so the client keeps it queued.
 */
async function writeStarred(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  sessionId: string,
  rows: StreamRow[],
  starred: boolean
): Promise<Response | null> {
  const origin = new URL(request.url).origin;
  const headers = { Authorization: `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const budget = { bytes: MAX_BODY_BYTES_PER_RESPONSE };

  for (const row of rows.slice(0, MAX_STAR_CHANGES)) {
    const item = parseItem(row);
    if (!item) continue;
    let response: Response;
    if (starred) {
      const content = (await itemBody(env, row, item, budget)) || undefined;
      response = await handleCreateSaved(
        new Request(`${origin}/api/saved`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            // A feed save is keyed by guid, so a link that won't parse is
            // dropped rather than failing the save.
            url: validUrl(item.url),
            rkey: generateTid(),
            // A document is saved as the web app saves one: a metadata save
            // keyed by its record URI, with the body rendered here.
            ...(row.kind === 'document'
              ? { source: 'document' }
              : { source: 'feed', fromFeed: true }),
            itemGuid: row.item_key,
            title: item.title,
            author: item.author,
            description: item.summary,
            content,
            wordCount: content ? wordCount(content) : undefined,
            image: item.imageUrl,
            publishedAt: item.publishedAt,
          }),
        }),
        env,
        ctx
      );
    } else {
      response = await handleDeleteSavedByGuid(
        new Request(`${origin}/api/saved/by-guid/${encodeURIComponent(row.item_key)}`, {
          method: 'DELETE',
          headers,
        }),
        env,
        ctx
      );
    }
    // Already saved / already gone is the state that was asked for.
    if (response.ok || response.status === 409 || response.status === 404) continue;
    log.warn('greader_star_failed', { starred, status: response.status, id: row.id });
    if (response.status === 401 || response.status === 403) return signInAgain();
    // A request the save route refuses won't succeed on a retry either; leave
    // that item and carry on rather than wedge the client's queue on it.
    if (response.status === 400) continue;
    return text('Could not save\n', 502);
  }
  if (rows.length > MAX_STAR_CHANGES) {
    return text('More to do; retry\n', 503, { 'Retry-After': '1' });
  }
  return null;
}

function signInAgain(): Response {
  return text('Sign in to Skyreader on the web again to star from other apps\n', 403);
}

async function handleEditTag(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  did: string,
  params: URLSearchParams
): Promise<Response> {
  const ids = itemIdsParam(params);
  if (!ids) return text(`At most ${MAX_ITEM_IDS} ids per request\n`, 400);
  const add = new Set(params.getAll('a').map(itemState));
  const remove = new Set(params.getAll('r').map(itemState));

  // Adding kept-unread is Google's way to say unread.
  const markRead = add.has('read') && !add.has('kept-unread');
  const markUnread = remove.has('read') || add.has('kept-unread');
  const star = add.has('starred');
  const unstar = remove.has('starred');

  // Everything that can refuse the stars is checked before any write, so a
  // refused request changed nothing.
  let starRows: StreamRow[] = [];
  let sessionId: string | null = null;
  if (star !== unstar) {
    starRows = (await loadItems(env, did, ids)).filter((row) => Boolean(row.starred) !== star);
    if (starRows.length > 0) {
      sessionId = await findSessionIdForDid(env, did);
      if (!sessionId) return signInAgain();
      // Saves have their own bucket on the web (/api/saved); this is theirs here.
      const rateLimit = await checkRateLimit(env, did, GREADER_STAR_RATE_LIMIT_KEY);
      if (!rateLimit.allowed) {
        return text('Rate limit exceeded\n', 429, {
          'Retry-After': String(rateLimit.retryAfter ?? 60),
        });
      }
    }
  }

  if (markRead) await writeReadState(env, did, ids, true);
  else if (markUnread) await writeReadState(env, did, ids, false);

  if (sessionId) {
    const failure = await writeStarred(env, ctx, request, sessionId, starRows, star);
    if (failure) return failure;
  }
  return text('OK');
}

async function handleMarkAllAsRead(
  env: Env,
  did: string,
  params: URLSearchParams
): Promise<Response> {
  const stream = parseStreamId(params.get('s') ?? '');
  if (!stream || stream.kind === 'read') return text('Unknown stream\n', 400);
  // `ts` is microseconds: only items the app had seen when the reader pressed it.
  const tsParam = intParam(params, 'ts');
  const nowMs = Date.now();
  const beforeMs = tsParam !== null ? Math.floor(tsParam / 1000) : nowMs;

  const binds = new Binds(did);
  const cte = streamCte(stream, binds);
  const readAt = binds.add(nowMs);
  const now = binds.add(Math.floor(nowMs / 1000));
  const before = binds.add(beforeMs);
  // One statement however many feeds: per-row statements would spend the
  // invocation's query budget on a large library. Items already read are
  // rewritten too, as the web app's mark-feed-read does: this is fresh intent
  // and must beat an older unread still queued on another device.
  await env.DB.prepare(
    `${cte}
     INSERT INTO item_labels_cache
       (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
     SELECT ?1, win.item_key, win.kind, 'read', ${readPropsSql('win', readAt)},
            lower(hex(randomblob(8))), ${now}, ${now}, ${readAt}
       FROM win
      WHERE win.first_seen_at <= ${before}
     ${READ_UPSERT_CONFLICT}`
  )
    .bind(...binds.values)
    .run();
  return text('OK');
}

// --- entry point ---------------------------------------------------------------

/**
 * Everything under the API prefix. Answered before session resolution: these
 * clients carry an app password, not a session cookie.
 */
export async function handleGReader(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  subpath: string
): Promise<Response> {
  const url = new URL(request.url);
  if (subpath === 'accounts/ClientLogin') return handleClientLogin(request, env);

  const token = authToken(request);
  const owner = token ? await verifyAppPassword(env, token) : null;
  if (!owner) {
    // A wrong token spends the same per-IP allowance as a wrong sign-in, so
    // the API calls aren't an unthrottled way around it.
    const rateLimit = token ? await loginRateLimit(request, env) : null;
    if (rateLimit && !rateLimit.allowed) {
      return text('Rate limit exceeded\n', 429, {
        'Retry-After': String(rateLimit.retryAfter ?? 60),
      });
    }
    return unauthorized();
  }
  setContextDid(owner.did);
  ctx.waitUntil(touchAppPassword(env, owner.id));

  const rateLimit = await checkRateLimit(env, owner.did, GREADER_RATE_LIMIT_KEY);
  if (!rateLimit.allowed) {
    return text('Rate limit exceeded\n', 429, {
      'Retry-After': String(rateLimit.retryAfter ?? 60),
    });
  }

  if (!subpath.startsWith('reader/api/0/')) return text('Not found\n', 404);
  const call = subpath.slice('reader/api/0/'.length);
  const did = owner.did;
  const isWrite = request.method === 'POST' && (call === 'edit-tag' || call === 'mark-all-as-read');
  const params = await readParams(request, url);

  let response: Response;
  switch (true) {
    case call === 'token':
      // Writes aren't checked against it (see the header comment), but clients
      // fetch one before their first POST and expect a token-shaped answer.
      response = text(
        (await sha256Hex(new TextEncoder().encode(`${owner.id}:${did}`))).slice(0, 57)
      );
      break;
    case call === 'user-info':
      response = json({
        userId: did,
        userName: owner.handle,
        userProfileId: did,
        userEmail: owner.handle,
        isBloggerUser: false,
        signupTimeSec: 0,
        isMultiLoginEnabled: false,
      });
      break;
    case call === 'subscription/list':
      response = await handleSubscriptionList(env, did);
      break;
    case call === 'tag/list':
      response = await handleTagList(env, did);
      break;
    case call === 'unread-count':
      response = await handleUnreadCount(env, did);
      break;
    case call === 'stream/items/ids':
      response = await handleStreamItemIds(env, did, params);
      break;
    case call === 'stream/items/contents':
      response = await handleItemContents(env, did, params);
      break;
    case call === 'stream/contents' || call.startsWith('stream/contents/'): {
      // The stream id rides the path (percent-encoded, since a feed id holds a
      // URL), or `s` when the path stops at stream/contents.
      const fromPath = call.slice('stream/contents/'.length);
      let streamId = params.get('s') ?? READING_LIST;
      if (fromPath) {
        try {
          streamId = decodeURIComponent(fromPath);
        } catch {
          return text('Unknown stream\n', 400);
        }
      }
      response = await handleStreamContents(env, did, streamId, params);
      break;
    }
    case isWrite && call === 'edit-tag':
      response = await handleEditTag(env, ctx, request, did, params);
      break;
    case isWrite && call === 'mark-all-as-read':
      response = await handleMarkAllAsRead(env, did, params);
      break;
    case call === 'edit-tag' || call === 'mark-all-as-read':
      response = text('Method not allowed\n', 405);
      break;
    case call.startsWith('subscription/') || call === 'rename-tag' || call === 'disable-tag':
      response = text('Manage subscriptions and folders in Skyreader\n', 501);
      break;
    default:
      response = text('Not found\n', 404);
  }

  // Read state and saves feed the reader's search index; nudge it as the web
  // routes do (index.ts), so a read here is searchable without waiting.
  // Saves are hard-deleted, so an unstar asks the index to diff its saved set.
  if (isWrite && response.ok) {
    const reconcileSaved = params.getAll('r').some((tag) => itemState(tag) === 'starred');
    ctx.waitUntil(nudgeSearchIndex(env, did, { reconcileSaved }));
  }
  return response;
}
