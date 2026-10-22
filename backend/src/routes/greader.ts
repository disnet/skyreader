import type { Env, FeedItem } from '../types';
import { ARTICLE_WINDOW_PER_FEED } from '../config/window';
import { rssSubscriptionPredicate } from './ingest';
import { READ_UPSERT_CONFLICT, UNREAD_UPSERT_CONFLICT, chunkArray } from './reading';
import { handleCreateSaved, handleDeleteSavedByGuid } from './saved';
import { itemBodyKey } from './item-bodies';
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
 * (services/app-passwords.ts), and gets their subscriptions — newsletters and
 * Bluesky sources included — with read state shared with the web app.
 *
 * The model maps onto what the web app already has:
 *
 *  - An item is a `feed_items` row, its id the row's `seq` (decimal in
 *    `stream/items/ids`, the 16-hex-digit long form elsewhere; both accepted).
 *  - Read is the `read` label in `item_labels_cache`, keyed by guid, written
 *    with the same user-time guard as the web app's own read writes.
 *  - Starred is saved: the web app's star is its save, so starring delegates to
 *    the save routes (snapshot, limits, Semble/Margin backing and all) as the
 *    stored OAuth session, like the AT Intents endpoints in routes/xrpc.ts.
 *    Matching is by guid, which is how a feed item's save is keyed; an article
 *    saved by link is not starred here even when a feed also carries it.
 *  - The reading list is each subscribed feed's newest ARTICLE_WINDOW_PER_FEED
 *    items, the window the web app shows and counts unread over. Older archive
 *    items stay out, or an app would show a feed's whole history as unread.
 *    The starred stream is not windowed: a save from long ago is still starred.
 *
 * standard.site documents (atproto subscriptions) live outside `feed_items` and
 * aren't served here yet. Subscribing, unsubscribing and folders are managed in
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

function readSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM item_labels_cache il
                   WHERE il.user_did = ?1 AND il.item_key = ${alias}.guid
                     AND il.item_type = 'article' AND il.label = 'read' AND il.deleted_at IS NULL)`;
}

function starredSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM saved_articles sa
                   WHERE sa.user_did = ?1 AND sa.item_guid = ${alias}.guid)`;
}

/** The reader's active feed subscriptions, as a predicate over `alias.feed_url`. */
function subscribedSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM subscriptions_cache sc
                   WHERE sc.user_did = ?1 AND sc.feed_url = ${alias}.feed_url AND sc.active = 1
                     AND ${rssSubscriptionPredicate('sc')})`;
}

/**
 * `WITH subs, win`: `win` is the stream's items (seq, feed_url, guid,
 * first_seen_at, item_json, content_hash). Every query that lists items starts here, so the
 * subscription check and the window are in one place.
 */
function streamCte(stream: Stream, binds: Binds): string {
  let filter = '';
  if (stream.kind === 'feed') filter = `AND feed_url = ${binds.add(stream.feedUrl)}`;
  if (stream.kind === 'label') filter = `AND category = ${binds.add(stream.label)}`;
  const subs = `subs AS (
      SELECT DISTINCT feed_url FROM subscriptions_cache
       WHERE user_did = ?1 AND active = 1 AND feed_url <> ''
         AND ${rssSubscriptionPredicate()} ${filter})`;

  if (stream.kind === 'starred') {
    return `WITH ${subs},
      win AS (
        SELECT fi.seq, fi.feed_url, fi.guid, fi.first_seen_at, fi.item_json, fi.content_hash
          FROM subs JOIN feed_items fi ON fi.feed_url = subs.feed_url
         WHERE fi.guid IN (SELECT item_guid FROM saved_articles
                            WHERE user_did = ?1 AND item_guid IS NOT NULL))`;
  }
  // The newest-K window per feed: a per-feed index seek each, the same slice
  // the timeline's cold start and unread counts read.
  return `WITH ${subs},
    win AS (
      SELECT fi.seq, fi.feed_url, fi.guid, fi.first_seen_at, fi.item_json, fi.content_hash
        FROM subs JOIN feed_items fi
          ON fi.seq IN (SELECT f2.seq FROM feed_items f2
                         WHERE f2.feed_url = subs.feed_url
                         ORDER BY f2.published_at DESC, f2.seq DESC
                         LIMIT ${ARTICLE_WINDOW_PER_FEED})
       WHERE 1 = 1 ${stream.kind === 'read' ? `AND ${readSql('fi')}` : ''})`;
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

async function handleClientLogin(request: Request, env: Env, url: URL): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimit = await checkRateLimit(env, `ip:${ip}`, GREADER_LOGIN_RATE_LIMIT_KEY);
  if (!rateLimit.allowed) {
    return text('Error=RateLimited\n', 429, { 'Retry-After': String(rateLimit.retryAfter ?? 60) });
  }

  const params = await readParams(request, url);
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

/** The reader's feeds, one row per feed URL, keyed by it. */
async function loadSubscriptions(env: Env, did: string): Promise<Map<string, SubscriptionRow>> {
  const rows = await env.DB.prepare(
    `SELECT sc.feed_url,
            COALESCE(NULLIF(sc.custom_title, ''), NULLIF(sc.title, ''), f.title, sc.feed_url) AS title,
            NULLIF(sc.category, '') AS category,
            COALESCE(sc.site_url, f.site_url) AS site_url,
            COALESCE(sc.custom_icon_url, f.image_url) AS icon_url
       FROM subscriptions_cache sc
       LEFT JOIN feeds f ON f.feed_url = sc.feed_url
      WHERE sc.user_did = ? AND sc.active = 1 AND sc.feed_url <> ''
        AND ${rssSubscriptionPredicate('sc')}
      ORDER BY sc.id`
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
  continuation: number | null;
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
    continuation: intParam(params, 'c'),
    oldestFirst: params.get('r') === 'o',
    limit,
  };
}

interface StreamRow {
  seq: number;
  feed_url: string;
  guid: string;
  first_seen_at: number;
  item_json: string;
  content_hash: string;
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
    where.push(`win.seq ${query.oldestFirst ? '>' : '<'} ${binds.add(query.continuation)}`);
  }
  const cte = streamCte(query.stream, binds);
  const columns = withItems
    ? `win.seq, win.feed_url, win.guid, win.first_seen_at, win.item_json, win.content_hash,
       ${readSql('win')} AS read, ${starredSql('win')} AS starred`
    : 'win.seq, win.feed_url, win.first_seen_at';
  const rows = await env.DB.prepare(
    `${cte}
     SELECT ${columns} FROM win
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY win.seq ${query.oldestFirst ? 'ASC' : 'DESC'}
      LIMIT ${binds.add(query.limit + 1)}`
  )
    .bind(...binds.values)
    .all<StreamRow>();

  const hasMore = rows.results.length > query.limit;
  const page = hasMore ? rows.results.slice(0, query.limit) : rows.results;
  return {
    rows: page,
    continuation: hasMore ? String(page[page.length - 1].seq) : undefined,
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
      id: String(row.seq),
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

/** Rows for the given seqs that sit in one of the reader's subscribed feeds. */
async function loadItems(env: Env, did: string, seqs: number[]): Promise<StreamRow[]> {
  if (seqs.length === 0) return [];
  const statements = chunkArray(seqs, ID_CHUNK).map((chunk) =>
    env.DB.prepare(
      `SELECT fi.seq, fi.feed_url, fi.guid, fi.first_seen_at, fi.item_json, fi.content_hash,
              ${readSql('fi')} AS read, ${starredSql('fi')} AS starred
         FROM feed_items fi
        WHERE fi.seq IN (${chunk.map((_, i) => `?${i + 2}`).join(',')})
          AND ${subscribedSql('fi')}`
    ).bind(did, ...chunk)
  );
  const results = await env.DB.batch<StreamRow>(statements);
  return results.flatMap((result) => result.results ?? []);
}

function itemIdsParam(params: URLSearchParams): number[] | null {
  const raw = params.getAll('i');
  if (raw.length > MAX_ITEM_IDS) return null;
  const seqs = new Set<number>();
  for (const id of raw) {
    const seq = parseItemId(id);
    if (seq !== null) seqs.add(seq);
  }
  return [...seqs];
}

async function handleItemContents(
  env: Env,
  did: string,
  params: URLSearchParams
): Promise<Response> {
  const seqs = itemIdsParam(params);
  if (!seqs) return text(`At most ${MAX_ITEM_IDS} ids per request\n`, 400);
  const [rows, subs] = await Promise.all([loadItems(env, did, seqs), loadSubscriptions(env, did)]);
  // In the order asked for, which is what clients expect back.
  const order = new Map(seqs.map((seq, i) => [seq, i]));
  rows.sort((a, b) => order.get(a.seq)! - order.get(b.seq)!);
  return json({
    id: READING_LIST,
    updated: Math.floor(Date.now() / 1000),
    items: await renderItems(env, rows, subs),
  });
}

// --- items ---------------------------------------------------------------------

function parseItem(row: Pick<StreamRow, 'item_json' | 'seq'>): FeedItem | null {
  try {
    return JSON.parse(row.item_json) as FeedItem;
  } catch {
    log.warn('greader_item_unparseable', { seq: row.seq });
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
    const object = await env.ITEM_BODIES.get(await itemBodyKey(row.feed_url, row.guid));
    if (object && object.customMetadata?.contentHash === row.content_hash) {
      if (object.size <= budget.bytes) {
        budget.bytes -= object.size;
        return object.text();
      }
      await object.body.cancel();
    }
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
    id: longItemId(row.seq),
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

/** Mark the given items read (or unread) as the reader, now, in one statement per chunk. */
async function writeReadState(env: Env, did: string, seqs: number[], read: boolean) {
  const nowMs = Date.now();
  const statements = chunkArray(seqs, ID_CHUNK).map((chunk) => {
    const binds = new Binds(did);
    const at = binds.add(nowMs);
    const now = binds.add(Math.floor(nowMs / 1000));
    const ids = chunk.map((seq) => binds.add(seq)).join(',');
    // The rkey is a legacy PDS-record key nothing reads for a new row; a random
    // record-key-shaped value keeps the column's shape without a per-row TID.
    const sql = read
      ? `INSERT INTO item_labels_cache
           (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
         SELECT ?1, fi.guid, 'article', 'read',
                json_object('readAt', ${at}, 'itemUrl', json_extract(fi.item_json, '$.url'),
                            'itemTitle', json_extract(fi.item_json, '$.title')),
                lower(hex(randomblob(8))), ${now}, ${now}, ${at}
           FROM feed_items fi
          WHERE fi.seq IN (${ids}) AND ${subscribedSql('fi')}
         ${READ_UPSERT_CONFLICT}`
      : `INSERT INTO item_labels_cache
           (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, deleted_at, client_updated_at)
         SELECT ?1, fi.guid, 'article', 'read', NULL, lower(hex(randomblob(8))), ${now}, ${now}, ${now}, ${at}
           FROM feed_items fi
          WHERE fi.seq IN (${ids}) AND ${subscribedSql('fi')}
         ${UNREAD_UPSERT_CONFLICT}`;
    return env.DB.prepare(sql).bind(...binds.values);
  });
  if (statements.length) await env.DB.batch(statements);
}

/**
 * Star or unstar by delegating to the save routes as the reader's stored
 * session, so a star is a save in every way the web app's is. Returns false
 * when there is no session to act as.
 */
async function writeStarred(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  did: string,
  rows: StreamRow[],
  starred: boolean
): Promise<boolean> {
  if (rows.length === 0) return true;
  const sessionId = await findSessionIdForDid(env, did);
  if (!sessionId) return false;
  const origin = new URL(request.url).origin;
  const headers = { Authorization: `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const budget = { bytes: MAX_BODY_BYTES_PER_RESPONSE };

  for (const row of rows) {
    if (Boolean(row.starred) === starred) continue;
    const item = parseItem(row);
    if (!item) continue;
    const response = starred
      ? await handleCreateSaved(
          new Request(`${origin}/api/saved`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              url: item.url ?? '',
              rkey: generateTid(),
              source: 'feed',
              fromFeed: true,
              itemGuid: row.guid,
              title: item.title,
              author: item.author,
              description: item.summary,
              content: (await itemBody(env, row, item, budget)) || undefined,
              image: item.imageUrl,
              publishedAt: item.publishedAt,
            }),
          }),
          env,
          ctx
        )
      : await handleDeleteSavedByGuid(
          new Request(`${origin}/api/saved/by-guid/${encodeURIComponent(row.guid)}`, {
            method: 'DELETE',
            headers,
          }),
          env,
          ctx
        );
    // Already saved / already gone is the state that was asked for.
    if (!response.ok && response.status !== 409 && response.status !== 404) {
      log.warn('greader_star_failed', { starred, status: response.status, seq: row.seq });
    }
  }
  return true;
}

async function handleEditTag(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  did: string,
  params: URLSearchParams
): Promise<Response> {
  const seqs = itemIdsParam(params);
  if (!seqs) return text(`At most ${MAX_ITEM_IDS} ids per request\n`, 400);
  const add = new Set(params.getAll('a').map(itemState));
  const remove = new Set(params.getAll('r').map(itemState));

  // Adding kept-unread is Google's way to say unread.
  const markRead = add.has('read') && !add.has('kept-unread');
  const markUnread = remove.has('read') || add.has('kept-unread');
  const star = add.has('starred');
  const unstar = remove.has('starred');

  if (markRead) await writeReadState(env, did, seqs, true);
  else if (markUnread) await writeReadState(env, did, seqs, false);

  if (star !== unstar) {
    const rows = await loadItems(env, did, seqs);
    if (!(await writeStarred(env, ctx, request, did, rows, star))) {
      return text('Sign in to Skyreader on the web once to star from other apps\n', 403);
    }
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
  // invocation's query budget on a large library.
  await env.DB.prepare(
    `${cte}
     INSERT INTO item_labels_cache
       (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
     SELECT ?1, win.guid, 'article', 'read',
            json_object('readAt', ${readAt}, 'itemUrl', json_extract(win.item_json, '$.url'),
                        'itemTitle', json_extract(win.item_json, '$.title')),
            lower(hex(randomblob(8))), ${now}, ${now}, ${readAt}
       FROM win
      WHERE win.first_seen_at <= ${before} AND NOT ${readSql('win')}
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
  if (subpath === 'accounts/ClientLogin') return handleClientLogin(request, env, url);

  const token = authToken(request);
  const owner = token ? await verifyAppPassword(env, token) : null;
  if (!owner) return unauthorized();
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
