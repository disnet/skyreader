import type { Env } from '../../types';
import { parseSearchQuery } from '../search-query';
import {
  KIND_HIGHLIGHTED,
  KIND_READ,
  KIND_SAVED,
  getSearchAccess,
  searchIndexStub,
} from '../search-index';
import { SEARCH_COUNT_CAP } from '../../durable-objects/search-index';
import { collectExport } from '../export/collect';
import { getUserSettings } from '../../routes/settings';
import { listBackedSaved, type SavedArticleView } from '../backing/sync';
import { normalizeArticleUrl } from '../../utils/url-normalize';
import { htmlToText } from '../../utils/html-text';

/**
 * The MCP server's tools (services/mcp/server.ts). All read-only, all scoped to
 * the signed-in reader. Every list is paged so one call can't pull a whole
 * library. The lists page by cursor, with no cap on depth: a page past the
 * thousandth save costs what the first did, so an agent can walk the whole
 * library, bounded by the rate limit, not by an offset. Search pages by cursor
 * too, though its ranked index stops at SEARCH_COUNT_CAP matches.
 *
 * These schemas are a public API: AI apps cache them and refresh on their own
 * schedule. Add freely; never remove, rename, require or narrow an argument or
 * a result field. A replaced argument stays accepted under `aliases`. See
 * "Changing an MCP Tool" in backend/CLAUDE.md.
 */

export interface ToolContext {
  env: Env;
  ctx: ExecutionContext;
  reader: { did: string; handle: string };
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Retired argument names still accepted from apps holding an old schema, and
   * translated by `run`. Left out of inputSchema, so new copies don't see them.
   */
  aliases?: string[];
  run(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>;
}

/** Bad arguments: told to the model as a tool error it can correct, not logged as a failure. */
export class ToolInputError extends Error {}

// An article's text comes in chunks this long; `fromChar` fetches the next.
export const ARTICLE_TEXT_CHARS = 30_000;

function intArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number
) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolInputError(`${key} must be a whole number`);
  }
  return Math.min(Math.max(value, min), max);
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  maxLength: number
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string`);
  if (value.length > maxLength) throw new ToolInputError(`${key} is too long`);
  return value;
}

const iso = (ms: number | null | undefined) =>
  typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;

/** An ISO date or datetime argument, as ms since the epoch. */
function dateArg(args: Record<string, unknown>, key: string): number | undefined {
  const raw = stringArg(args, key, 40);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new ToolInputError(`${key} must be an ISO date`);
  return ms;
}

const limitProp = (maxLimit: number, fallback: number) => ({
  type: 'integer',
  minimum: 1,
  maximum: maxLimit,
  default: fallback,
  description: `How many to return (at most ${maxLimit}).`,
});

// ─── cursors ────────────────────────────────────────────────────────────────

/**
 * Where the next page starts. Opaque to the agent; it only hands back the
 * `nextCursor` it was given. Keyset positions where the list is a D1 query, so
 * a deep page reads only its own rows; an index where the list is built whole
 * in memory anyway (a backed Saved list, highlights).
 */
type Cursor =
  | { k: 'saved'; t: number; i: number }
  | { k: 'shelf'; p: number; a: number; r: string }
  // `l` names the list, so one list's index isn't taken by another.
  | { k: 'index'; l: IndexedList; o: number };

type IndexedList = 'search' | 'backed' | 'highlights';

/**
 * The arguments a cursor belongs to, all but `cursor` and `limit`, as a short
 * hash. A cursor handed back with other arguments (another query, collection
 * or filter) would page the wrong list, so it's refused instead.
 */
function argsFingerprint(args: Record<string, unknown>): string {
  const rest = Object.keys(args)
    .filter((key) => key !== 'cursor' && key !== 'limit' && args[key] !== undefined)
    .sort()
    .map((key) => [key, args[key]]);
  // FNV-1a: a cursor is not a secret, only a check against honest mistakes.
  let hash = 0x811c9dc5;
  for (const ch of JSON.stringify(rest)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// Through UTF-8 bytes, since btoa takes Latin-1 only and an rkey is free text.
function encodeCursor(cursor: Cursor, args: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...cursor, f: argsFingerprint(args) }));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const BAD_CURSOR =
  'cursor isn’t one this list gave out with these arguments; start again without it';

function cursorArg<K extends Cursor['k']>(
  args: Record<string, unknown>,
  kind: K,
  list?: IndexedList
): Extract<Cursor, { k: K }> | undefined {
  const raw = stringArg(args, 'cursor', 500);
  if (!raw) return undefined;
  let value: unknown;
  try {
    const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ToolInputError(BAD_CURSOR);
  }
  const c = value as Record<string, unknown>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const ok =
    !!c &&
    typeof c === 'object' &&
    c.k === kind &&
    c.f === argsFingerprint(args) &&
    (kind === 'saved'
      ? num(c.t) && num(c.i)
      : kind === 'shelf'
        ? num(c.p) && num(c.a) && typeof c.r === 'string'
        : c.l === list && num(c.o) && Number.isInteger(c.o) && (c.o as number) >= 0);
  if (!ok) throw new ToolInputError(BAD_CURSOR);
  return c as Extract<Cursor, { k: K }>;
}

const CURSOR_PROP = {
  type: 'string',
  description:
    'For the next page: the nextCursor the last call returned, with the same other arguments.',
};

/** `hasMore` always, so a full last page never reads as a cut-off one. */
function nextPage(args: Record<string, unknown>, more: boolean, cursor: () => Cursor) {
  return more ? { hasMore: true, nextCursor: encodeCursor(cursor(), args) } : { hasMore: false };
}

/** A page of a list already built whole in memory. */
function slicePage<T>(all: T[], args: Record<string, unknown>, limit: number, list: IndexedList) {
  const start = cursorArg(args, 'index', list)?.o ?? 0;
  const end = start + limit;
  return {
    items: all.slice(start, end),
    ...nextPage(args, end < all.length, () => ({ k: 'index', l: list, o: end })),
  };
}

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * The index files a save under its feed item's guid or its record uri when it
 * has one (`savedItemKey` in services/search-index.ts), `saved:<rkey>` when
 * not. Map those keys back to rkeys, which get_saved_article takes.
 */
async function savedRkeys(env: Env, did: string, keys: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;
  const marks = keys.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT rkey, item_guid, record_uri FROM saved_articles
      WHERE user_did = ? AND (item_guid IN (${marks}) OR record_uri IN (${marks}) OR 'saved:' || rkey IN (${marks}))`
  )
    .bind(did, ...keys, ...keys, ...keys)
    .all<{ rkey: string; item_guid: string | null; record_uri: string | null }>();
  for (const row of rows.results ?? []) {
    for (const key of [row.item_guid, row.record_uri, `saved:${row.rkey}`]) {
      if (key && keys.includes(key)) found.set(key, row.rkey);
    }
  }
  return found;
}

const SEARCH_KINDS: Record<string, number> = {
  read: KIND_READ,
  saved: KIND_SAVED,
  highlighted: KIND_HIGHLIGHTED,
};

const search: McpTool = {
  name: 'search',
  title: 'Search my reading',
  description:
    'Full-text search over everything the reader has read, saved or highlighted in Skyreader, ' +
    'best matches first. Supports quoted phrases and -excluded words. Returns titles, URLs and a ' +
    'matching snippet; for a save, `rkey` can be passed to get_saved_article.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for.' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['read', 'saved', 'highlighted'] },
        description: 'Only these kinds of item. Omit for everything.',
      },
      limit: limitProp(20, 10),
      cursor: {
        ...CURSOR_PROP,
        description:
          `${CURSOR_PROP.description} Search ranks at most ${SEARCH_COUNT_CAP} matches; to walk ` +
          'the whole library, use list_saved or list_highlights.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(args, { env, reader }) {
    const query = stringArg(args, 'query', 500);
    const parsed = parseSearchQuery(query ?? '');
    if (!parsed) throw new ToolInputError('query has nothing to search for');

    let kinds = 0;
    if (args.kinds !== undefined) {
      if (!Array.isArray(args.kinds)) throw new ToolInputError('kinds must be a list');
      for (const name of args.kinds) {
        const bit = typeof name === 'string' ? SEARCH_KINDS[name] : undefined;
        if (!bit) throw new ToolInputError(`Unknown kind: ${String(name)}`);
        kinds |= bit;
      }
    }

    const access = await getSearchAccess(env, reader.did);
    if (!access.enabled) throw new ToolInputError('Search isn’t available yet.');
    if (!access.entitled) throw new ToolInputError('Search needs a Supporter plan.');

    const limit = intArg(args, 'limit', 10, 1, 20);
    const offset = Math.min(cursorArg(args, 'index', 'search')?.o ?? 0, SEARCH_COUNT_CAP);
    const result = await searchIndexStub(env, reader.did).search(
      reader.did,
      { positives: parsed.positives, negatives: parsed.negatives },
      { kinds, since: 0, limit, offset }
    );
    const rkeys = await savedRkeys(
      env,
      reader.did,
      result.hits.filter((hit) => hit.kinds & KIND_SAVED).map((hit) => hit.itemKey)
    );
    const total = Math.min(result.total, SEARCH_COUNT_CAP);
    const end = offset + result.hits.length;
    const more = result.hits.length === limit && end < total;
    return {
      results: result.hits.map((hit) => ({
        title: hit.title,
        url: hit.url,
        source: hit.feedTitle || null,
        rkey: rkeys.get(hit.itemKey) ?? null,
        read: (hit.kinds & KIND_READ) !== 0,
        saved: (hit.kinds & KIND_SAVED) !== 0,
        highlighted: (hit.kinds & KIND_HIGHLIGHTED) !== 0,
        snippet: hit.snippet.map((part) => part.text).join(''),
      })),
      total,
      // A first search builds the reader's index; until it's done, results are partial.
      ...(result.building ? { indexStillBuilding: true } : {}),
      ...nextPage(args, more, () => ({ k: 'index', l: 'search', o: end })),
    };
  },
};

// ─── list_saved ─────────────────────────────────────────────────────────────

interface SavedListRow {
  id?: number;
  rkey: string | null;
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  domain: string | null;
  word_count: number | null;
  saved_at: number | null;
  position?: number;
  added_at?: number;
}

const SAVED_COLUMNS = `s.rkey, s.url, s.title, s.author, s.description, s.domain, s.word_count, s.saved_at`;

/**
 * A page of rows and the count of the whole list, in one round trip. The
 * count is on every page so an agent never has to remember the first one's;
 * it's an index-only scan over one reader's saves, a few thousand rows.
 */
async function rowsAndCount(
  env: Env,
  list: D1PreparedStatement,
  count: D1PreparedStatement
): Promise<{ got: SavedListRow[]; total: number }> {
  const [rows, counted] = await env.DB.batch([list, count]);
  return {
    got: (rows.results as SavedListRow[] | undefined) ?? [],
    total: (counted.results?.[0] as { n: number } | undefined)?.n ?? 0,
  };
}

/** The reader's saves, within a date range clause on saved_articles s. */
const countSaved = (env: Env, did: string, range = '') =>
  env.DB.prepare(`SELECT COUNT(*) AS n FROM saved_articles s WHERE s.user_did = ?${range}`).bind(
    did
  );

const listSaved: McpTool = {
  name: 'list_saved',
  title: 'List saved articles',
  description:
    'The reader’s saved articles, newest first, or the ones in one Shelf collection in the ' +
    'reader’s own order (ids from list_collections), optionally only those saved in a date ' +
    'range. Titles, URLs and descriptions, and `total`, how many match in all. Page with ' +
    'nextCursor until hasMore is false; it reaches every save. get_saved_article reads one.',
  inputSchema: {
    type: 'object',
    properties: {
      collectionId: { type: 'string', description: 'Only saves in this Shelf collection.' },
      savedSince: {
        type: 'string',
        description: 'An ISO date or datetime: only saves made at or after it.',
      },
      savedBefore: {
        type: 'string',
        description: 'An ISO date or datetime: only saves made before it.',
      },
      limit: limitProp(100, 50),
      cursor: CURSOR_PROP,
    },
    additionalProperties: false,
  },
  async run(args, { env, reader }) {
    const collectionId = stringArg(args, 'collectionId', 200);
    const since = dateArg(args, 'savedSince');
    const before = dateArg(args, 'savedBefore');
    const limit = intArg(args, 'limit', 50, 1, 100);

    // The date range, on saved_articles s, for every path that queries D1.
    const range = [
      ...(since !== undefined ? [`s.saved_at >= ${Math.floor(since)}`] : []),
      ...(before !== undefined ? [`s.saved_at < ${Math.floor(before)}`] : []),
    ]
      .map((clause) => ` AND ${clause}`)
      .join('');

    let rows: SavedListRow[];
    let total: number;
    let paging: ReturnType<typeof nextPage>;
    if (collectionId) {
      const after = cursorArg(args, 'shelf');
      const from = `FROM shelf_collection_items ci
             JOIN saved_articles s ON s.user_did = ci.user_did AND s.rkey = ci.saved_rkey
            WHERE ci.user_did = ? AND ci.collection_id = ?${range}`;
      let got: SavedListRow[];
      ({ got, total } = await rowsAndCount(
        env,
        env.DB.prepare(
          `SELECT ${SAVED_COLUMNS}, ci.position, ci.added_at ${from}
             ${after ? 'AND (ci.position, ci.added_at, ci.saved_rkey) > (?, ?, ?)' : ''}
            ORDER BY ci.position ASC, ci.added_at ASC, ci.saved_rkey ASC LIMIT ?`
        ).bind(reader.did, collectionId, ...(after ? [after.p, after.a, after.r] : []), limit + 1),
        env.DB.prepare(`SELECT COUNT(*) AS n ${from}`).bind(reader.did, collectionId)
      ));
      rows = got.slice(0, limit);
      const last = rows[rows.length - 1];
      paging = nextPage(args, got.length > limit, () => ({
        k: 'shelf',
        p: last.position ?? 0,
        a: last.added_at ?? 0,
        r: last.rkey ?? '',
      }));
    } else {
      const settings = await getUserSettings(env, reader.did);
      if (settings.backing.provider !== 'skyreader') {
        // A backed Saved list is the Semble/Margin collection's last snapshot,
        // built whole on every read, so its cursor is a plain index.
        // A member added in the other app, with no row here, has no rkey and
        // no time of its own (its view's savedAt is "now"), so a date range
        // leaves it out and it lists with no savedAt.
        const savedAt = (v: SavedArticleView) => (v.rkey ? Date.parse(v.savedAt) : NaN);
        const views = (await listBackedSaved(env, reader.did, settings.backing)).filter((v) => {
          if (since === undefined && before === undefined) return true;
          const at = savedAt(v);
          if (!Number.isFinite(at)) return false;
          return (since === undefined || at >= since) && (before === undefined || at < before);
        });
        const { items, ...rest } = slicePage(views, args, limit, 'backed');
        total = views.length;
        paging = rest;
        rows = items.map((v) => ({
          rkey: v.rkey,
          url: v.url,
          title: v.title,
          author: v.author,
          description: v.description,
          domain: v.domain,
          word_count: v.wordCount,
          saved_at: Number.isFinite(savedAt(v)) ? savedAt(v) : null,
        }));
      } else {
        // Keyset on (saved_at, id), the index GET /api/saved pages by
        // (idx_saved_articles_user_savedat): every page reads only its rows.
        const after = cursorArg(args, 'saved');
        let got: SavedListRow[];
        ({ got, total } = await rowsAndCount(
          env,
          env.DB.prepare(
            `SELECT ${SAVED_COLUMNS}, s.id FROM saved_articles s
              WHERE s.user_did = ?${range}
              ${after ? 'AND (s.saved_at < ? OR (s.saved_at = ? AND s.id < ?))' : ''}
              ORDER BY s.saved_at DESC, s.id DESC LIMIT ?`
          ).bind(reader.did, ...(after ? [after.t, after.t, after.i] : []), limit + 1),
          countSaved(env, reader.did, range)
        ));
        rows = got.slice(0, limit);
        const last = rows[rows.length - 1];
        paging = nextPage(args, got.length > limit, () => ({
          k: 'saved',
          t: last.saved_at ?? 0,
          i: last.id ?? 0,
        }));
      }
    }

    return {
      saved: rows.map((r) => ({
        rkey: r.rkey,
        title: r.title,
        url: r.url || null,
        author: r.author,
        domain: r.domain,
        description: r.description,
        wordCount: r.word_count,
        savedAt: iso(r.saved_at),
      })),
      total,
      ...paging,
    };
  },
};

// ─── get_saved_article ──────────────────────────────────────────────────────

const getSavedArticle: McpTool = {
  name: 'get_saved_article',
  title: 'Read a saved article',
  description:
    'The text of one saved article, by the `rkey` that list_saved or search returned. Long ' +
    `articles come in chunks of about ${ARTICLE_TEXT_CHARS.toLocaleString('en-US')} characters: ` +
    'when `truncated` is true, pass `nextChar` as `fromChar` for the next one.',
  inputSchema: {
    type: 'object',
    properties: {
      rkey: { type: 'string', description: 'The save’s rkey.' },
      fromChar: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Where to start in the text: the nextChar the last call returned.',
      },
    },
    required: ['rkey'],
    additionalProperties: false,
  },
  async run(args, { env, reader }) {
    const rkey = stringArg(args, 'rkey', 100);
    if (!rkey) throw new ToolInputError('rkey is required');
    const fromChar = intArg(args, 'fromChar', 0, 0, Number.MAX_SAFE_INTEGER);
    const row = await env.DB.prepare(
      `SELECT rkey, url, title, author, domain, published_at, saved_at, content
         FROM saved_articles WHERE user_did = ? AND rkey = ?`
    )
      .bind(reader.did, rkey)
      .first<{
        rkey: string;
        url: string;
        title: string | null;
        author: string | null;
        domain: string | null;
        published_at: number | null;
        saved_at: number | null;
        content: string | null;
      }>();
    if (!row) throw new ToolInputError(`No saved article with rkey ${rkey}`);

    // htmlToText walks the whole body whatever its cap, so convert it all and cut here.
    const text = row.content ? htmlToText(row.content).trim() : '';
    if (fromChar > 0 && fromChar >= text.length) {
      throw new ToolInputError(`fromChar is past the end of the text (${text.length} characters)`);
    }
    let end = Math.min(fromChar + ARTICLE_TEXT_CHARS, text.length);
    if (end < text.length) {
      // End a chunk at a space when there's one near, so a word isn't split across two.
      const space = text.lastIndexOf(' ', end - 1);
      if (space > fromChar + ARTICLE_TEXT_CHARS * 0.9) end = space + 1;
      // Never between the two halves of an emoji or other astral character.
      else if (/[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
    }
    const truncated = end < text.length;
    return {
      rkey: row.rkey,
      title: row.title,
      url: row.url || null,
      author: row.author,
      domain: row.domain,
      publishedAt: iso(row.published_at),
      savedAt: iso(row.saved_at),
      text: text.slice(fromChar, end),
      fromChar,
      totalChars: text.length,
      truncated,
      ...(truncated ? { nextChar: end } : {}),
      ...(text ? {} : { note: 'Skyreader has no text for this save, only its link.' }),
    };
  },
};

// ─── list_highlights ────────────────────────────────────────────────────────

const listHighlights: McpTool = {
  name: 'list_highlights',
  title: 'List highlights and notes',
  description:
    'Pages the reader highlighted, each with its highlights and their notes in reading order. ' +
    'Saves first (newest first), then pages highlighted without saving. Narrow to one page (by ' +
    'a save’s `rkey`, or by `url` for a page highlighted without saving), to what changed since ' +
    'a date, or to one Shelf collection. Page with nextCursor until hasMore is false.',
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description: 'An ISO date or datetime: only pages whose highlights changed since then.',
      },
      collectionId: { type: 'string', description: 'Only saves in this Shelf collection.' },
      rkey: { type: 'string', description: 'Only this save’s highlights.' },
      url: { type: 'string', description: 'Only the highlights on the page at this URL.' },
      limit: limitProp(50, 20),
      cursor: CURSOR_PROP,
    },
    additionalProperties: false,
  },
  async run(args, { env, reader }) {
    const sinceMs = dateArg(args, 'since');
    const since = sinceMs === undefined ? undefined : Math.max(0, Math.floor(sinceMs / 1000));
    const collectionId = stringArg(args, 'collectionId', 200);
    const rkey = stringArg(args, 'rkey', 100);
    const url = stringArg(args, 'url', 2000);
    const limit = intArg(args, 'limit', 20, 1, 50);

    const doc = await collectExport(env, reader.did, {
      ...(since !== undefined ? { since } : {}),
      ...(collectionId ? { collections: [collectionId] } : {}),
      // One save's highlights: read that save, not the whole library.
      ...(rkey ? { rkeys: [rkey] } : {}),
    });
    // A URL matches however it's written: scheme case, trailing slash, tracking params.
    const wanted = url ? normalizeArticleUrl(url) : null;
    const sameUrl = (a: string) =>
      a === url || (wanted !== null && normalizeArticleUrl(a) === wanted);
    const highlighted = doc.sources.filter(
      (s) =>
        s.highlights.length > 0 &&
        (!rkey || s.id === `saved:${rkey}` || (s.keys ?? []).includes(`saved:${rkey}`)) &&
        (!url || (s.url !== undefined && sameUrl(s.url)))
    );
    const { items, ...paging } = slicePage(highlighted, args, limit, 'highlights');
    return {
      pages: items.map((s) => ({
        title: s.title ?? null,
        url: s.url ?? null,
        author: s.author ?? null,
        // A page highlighted under a save's key whose save is gone has no rkey.
        rkey: s.kind === 'save' && s.id?.startsWith('saved:') ? s.id.slice('saved:'.length) : null,
        savedAt: s.savedAt ?? null,
        highlights: s.highlights.map((h) => ({
          text: h.text,
          ...(h.note ? { note: h.note } : {}),
          ...(h.createdAt ? { createdAt: h.createdAt } : {}),
        })),
      })),
      total: highlighted.length,
      ...paging,
    };
  },
};

/** How many saves the reader has, the length of the list list_saved pages through. */
async function savedTotal(env: Env, did: string): Promise<number> {
  const settings = await getUserSettings(env, did);
  if (settings.backing.provider !== 'skyreader') {
    return (await listBackedSaved(env, did, settings.backing)).length;
  }
  const row = await countSaved(env, did).first<{ n: number }>();
  return row?.n ?? 0;
}

// ─── list_collections ───────────────────────────────────────────────────────

const listCollections: McpTool = {
  name: 'list_collections',
  title: 'List Shelf collections',
  description:
    'The reader’s Shelf collections, in their order, with how many saves each holds ' +
    '(`itemCount`), and `totalSaved`, how many saves the reader has in all. Pass an id to ' +
    'list_saved or list_highlights to narrow to one.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, { env, reader }) {
    // Counted through the same join list_saved reads, so a count matches the list.
    const rowsQ = env.DB.prepare(
      `SELECT c.id, c.name, COUNT(s.rkey) AS itemCount
         FROM shelf_collections c
         LEFT JOIN shelf_collection_items ci
           ON ci.user_did = c.user_did AND ci.collection_id = c.id
         LEFT JOIN saved_articles s
           ON s.user_did = ci.user_did AND s.rkey = ci.saved_rkey
        WHERE c.user_did = ?
        GROUP BY c.id
        ORDER BY c.position ASC, c.created_at ASC LIMIT 100`
    )
      .bind(reader.did)
      .all<{ id: string; name: string; itemCount: number }>();
    const [rows, totalSaved] = await Promise.all([rowsQ, savedTotal(env, reader.did)]);
    return { collections: rows.results ?? [], totalSaved };
  },
};

export const MCP_TOOLS: McpTool[] = [
  search,
  listSaved,
  getSavedArticle,
  listHighlights,
  listCollections,
];
