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
import { listBackedSaved } from '../backing/sync';
import { htmlToText } from '../../utils/html-text';

/**
 * The MCP server's tools (services/mcp/server.ts). All read-only, all scoped to
 * the signed-in reader, and every list capped and paged so one call can't pull
 * a whole library: an agent loops, and each call is D1 rows read.
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
  run(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>;
}

/** Bad arguments: told to the model as a tool error it can correct, not logged as a failure. */
export class ToolInputError extends Error {}

const MAX_OFFSET = 1000;
// An article's text, cut here with a note: a long read is still a few model turns' worth.
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

/** `more`: whether another page follows, and the offset that fetches it. */
function page(offset: number, limit: number, got: number) {
  return got === limit && offset + limit < MAX_OFFSET ? { nextOffset: offset + limit } : {};
}

const pagingProps = (maxLimit: number, fallback: number) => ({
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: maxLimit,
    default: fallback,
    description: `How many to return (at most ${maxLimit}).`,
  },
  offset: {
    type: 'integer',
    minimum: 0,
    maximum: MAX_OFFSET,
    default: 0,
    description: 'For the next page: the nextOffset the last call returned.',
  },
});

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
      ...pagingProps(20, 10),
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
    const offset = intArg(args, 'offset', 0, 0, Math.min(MAX_OFFSET, SEARCH_COUNT_CAP));
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
      total: Math.min(result.total, SEARCH_COUNT_CAP),
      // A first search builds the reader's index; until it's done, results are partial.
      ...(result.building ? { indexStillBuilding: true } : {}),
      ...page(offset, limit, result.hits.length),
    };
  },
};

// ─── list_saved ─────────────────────────────────────────────────────────────

interface SavedListRow {
  rkey: string | null;
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  domain: string | null;
  word_count: number | null;
  saved_at: number | null;
}

const SAVED_COLUMNS = `s.rkey, s.url, s.title, s.author, s.description, s.domain, s.word_count, s.saved_at`;

const listSaved: McpTool = {
  name: 'list_saved',
  title: 'List saved articles',
  description:
    'The reader’s saved articles, newest first, or the ones in one Shelf collection in the ' +
    'reader’s own order (ids from list_collections). Titles, URLs and descriptions, and ' +
    '`total`, how many there are in all; get_saved_article reads one.',
  inputSchema: {
    type: 'object',
    properties: {
      collectionId: { type: 'string', description: 'Only saves in this Shelf collection.' },
      ...pagingProps(50, 20),
    },
    additionalProperties: false,
  },
  async run(args, { env, reader }) {
    const collectionId = stringArg(args, 'collectionId', 200);
    const limit = intArg(args, 'limit', 20, 1, 50);
    const offset = intArg(args, 'offset', 0, 0, MAX_OFFSET);

    let rows: SavedListRow[];
    let total: number;
    if (collectionId) {
      const [list, count] = await env.DB.batch([
        env.DB.prepare(
          `SELECT ${SAVED_COLUMNS} FROM shelf_collection_items ci
             JOIN saved_articles s ON s.user_did = ci.user_did AND s.rkey = ci.saved_rkey
            WHERE ci.user_did = ? AND ci.collection_id = ?
            ORDER BY ci.position ASC, ci.added_at ASC LIMIT ? OFFSET ?`
        ).bind(reader.did, collectionId, limit, offset),
        env.DB.prepare(
          `SELECT COUNT(*) AS n FROM shelf_collection_items ci
             JOIN saved_articles s ON s.user_did = ci.user_did AND s.rkey = ci.saved_rkey
            WHERE ci.user_did = ? AND ci.collection_id = ?`
        ).bind(reader.did, collectionId),
      ]);
      rows = (list.results as SavedListRow[] | undefined) ?? [];
      total = (count.results?.[0] as { n: number } | undefined)?.n ?? 0;
    } else {
      const settings = await getUserSettings(env, reader.did);
      if (settings.backing.provider !== 'skyreader') {
        // A backed Saved list is the Semble/Margin collection's last snapshot.
        const views = await listBackedSaved(env, reader.did, settings.backing);
        total = views.length;
        rows = views.slice(offset, offset + limit).map((v) => ({
          rkey: v.rkey,
          url: v.url,
          title: v.title,
          author: v.author,
          description: v.description,
          domain: v.domain,
          word_count: v.wordCount,
          saved_at: v.savedAt ? Date.parse(v.savedAt) : null,
        }));
      } else {
        const [list, count] = await env.DB.batch([
          env.DB.prepare(
            `SELECT ${SAVED_COLUMNS} FROM saved_articles s
              WHERE s.user_did = ? ORDER BY s.saved_at DESC, s.id DESC LIMIT ? OFFSET ?`
          ).bind(reader.did, limit, offset),
          countSaved(env, reader.did),
        ]);
        rows = (list.results as SavedListRow[] | undefined) ?? [];
        total = (count.results?.[0] as { n: number } | undefined)?.n ?? 0;
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
      ...page(offset, limit, rows.length),
    };
  },
};

// ─── get_saved_article ──────────────────────────────────────────────────────

const getSavedArticle: McpTool = {
  name: 'get_saved_article',
  title: 'Read a saved article',
  description:
    'The text of one saved article, by the `rkey` that list_saved or search returned. Long ' +
    'articles are cut off, which `truncated` says.',
  inputSchema: {
    type: 'object',
    properties: { rkey: { type: 'string', description: 'The save’s rkey.' } },
    required: ['rkey'],
    additionalProperties: false,
  },
  async run(args, { env, reader }) {
    const rkey = stringArg(args, 'rkey', 100);
    if (!rkey) throw new ToolInputError('rkey is required');
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

    // Converted to twice the cap: htmlToText cuts back to a word boundary, so a
    // cut at the cap itself could come back shorter than it and read as whole.
    const text = row.content ? htmlToText(row.content, ARTICLE_TEXT_CHARS * 2).trim() : '';
    const truncated = text.length > ARTICLE_TEXT_CHARS;
    return {
      rkey: row.rkey,
      title: row.title,
      url: row.url || null,
      author: row.author,
      domain: row.domain,
      publishedAt: iso(row.published_at),
      savedAt: iso(row.saved_at),
      text: truncated ? text.slice(0, ARTICLE_TEXT_CHARS) : text,
      truncated,
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
    'Saves first (newest first), then pages highlighted without saving. Narrow to what changed ' +
    'since a date, or to one Shelf collection.',
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description: 'An ISO date or datetime: only pages whose highlights changed since then.',
      },
      collectionId: { type: 'string', description: 'Only saves in this Shelf collection.' },
      ...pagingProps(50, 20),
    },
    additionalProperties: false,
  },
  async run(args, { env, reader }) {
    const sinceRaw = stringArg(args, 'since', 40);
    let since: number | undefined;
    if (sinceRaw) {
      const ms = Date.parse(sinceRaw);
      if (!Number.isFinite(ms)) throw new ToolInputError('since must be an ISO date');
      since = Math.max(0, Math.floor(ms / 1000));
    }
    const collectionId = stringArg(args, 'collectionId', 200);
    const limit = intArg(args, 'limit', 20, 1, 50);
    const offset = intArg(args, 'offset', 0, 0, MAX_OFFSET);

    const doc = await collectExport(env, reader.did, {
      ...(since !== undefined ? { since } : {}),
      ...(collectionId ? { collections: [collectionId] } : {}),
    });
    const highlighted = doc.sources.filter((s) => s.highlights.length > 0);
    const pageSources = highlighted.slice(offset, offset + limit);
    return {
      pages: pageSources.map((s) => ({
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
      ...(offset + limit < highlighted.length && offset + limit < MAX_OFFSET
        ? { nextOffset: offset + limit }
        : {}),
    };
  },
};

const countSaved = (env: Env, did: string) =>
  env.DB.prepare(`SELECT COUNT(*) AS n FROM saved_articles WHERE user_did = ?`).bind(did);

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
