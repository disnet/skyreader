// POST /api/saved/import — a reader's library from another read-later app.
//
// The browser reads the export file (Pocket, Omnivore, Instapaper, Readwise
// Reader or Matter: CSV, JSON, HTML or a zip of them) and posts what it found
// here a batch at a time, already in one shape. Each new save lands the way a
// URL save does, keyed by its own record uri, with the app's archived state,
// tags and highlights written as the labels the reader would have made by hand.
//
// Nothing here fetches a page. An imported save arrives without its text: the
// first few are extracted after the import, the rest when they're opened
// (extractImportedSaves, from POST /api/saved/bodies).

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { getUserSettings } from './settings';
import { savedUrlKey } from '../services/semble-connections';
import { generateTid } from '../utils/tid';
import { sha256Hex } from '../utils/sha256';
import { chunkArray } from './reading';
import { MERGE_HIGHLIGHTS_CONFLICT } from './labels';
import { FeedProxyClient } from '../services/feed-proxy-client';
import { fillExtractedContent } from '../services/saved-content';
import { checkRateLimit } from '../services/rate-limit';

const COLLECTION = 'app.skyreader.feed.saved';

export const IMPORT_SOURCES = ['pocket', 'omnivore', 'instapaper', 'readwise', 'matter'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** Items per request: each can cost up to four statements of the invocation's 1,000. */
export const MAX_IMPORT_ITEMS = 100;
// The same caps the reader's own tag menu and highlighter hold to.
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 64;
const MAX_HIGHLIGHT_LENGTH = 5000;
const MAX_HIGHLIGHTS_PER_SAVE = 500;
const MAX_NOTE_LENGTH = 10_000;
// Bound parameters per IN (...) lookup; two per URL, under D1's cap.
const LOOKUP_CHUNK = 40;
// Imported saves extracted in the background after an import: enough that the
// newest few open ready to read. Everything else is extracted when opened.
const EXTRACT_AFTER_IMPORT = 20;
// Rate-limit buckets (services/rate-limit.ts) for the two ways an import fetches
// pages: the background pass above, and one save extracted as it's opened.
export const IMPORT_EXTRACT_RATE_KEY = '/api/saved/import:extract';
export const OPEN_EXTRACT_RATE_KEY = '/api/saved/bodies:extract';
const EXTRACT_CONCURRENCY = 4;
// Nothing a read-later app exported was saved before the web had them.
const EARLIEST_SAVE_MS = Date.UTC(1995, 0, 1);

export interface ImportHighlight {
  text: string;
  note?: string;
  createdAt?: number;
}

export interface ImportItem {
  url: string;
  title?: string;
  author?: string;
  description?: string;
  /** When the reader saved it in the other app, epoch ms. */
  savedAt?: number;
  archived?: boolean;
  tags?: string[];
  highlights?: ImportHighlight[];
}

interface CleanItem {
  url: string;
  urlKey: string;
  title: string | null;
  author: string | null;
  description: string | null;
  domain: string | null;
  savedAt: number;
  archived: boolean;
  tags: string[];
  highlights: ImportHighlight[];
}

export interface ImportResult {
  added: number;
  /** Already in the Library (or twice in this batch): left as they were. */
  duplicates: number;
  /** No usable web URL. */
  invalid: number;
  /** Highlights written, on new saves and on ones already in the Library. */
  highlights: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function webUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** An item as stored, or null when it has no web URL to save. Exported for tests. */
export function cleanImportItem(raw: unknown, now: number): CleanItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Partial<Record<keyof ImportItem, unknown>>;
  const url = webUrl(item.url);
  if (!url) return null;
  const href = url.href;

  const savedAt =
    typeof item.savedAt === 'number' &&
    Number.isFinite(item.savedAt) &&
    item.savedAt >= EARLIEST_SAVE_MS &&
    item.savedAt <= now
      ? Math.floor(item.savedAt)
      : now;

  const tags: string[] = [];
  if (Array.isArray(item.tags)) {
    for (const tag of item.tags) {
      const clean = text(tag, MAX_TAG_LENGTH);
      if (clean && !tags.includes(clean)) tags.push(clean);
      if (tags.length === MAX_TAGS) break;
    }
  }

  const highlights: ImportHighlight[] = [];
  if (Array.isArray(item.highlights)) {
    for (const raw of item.highlights) {
      if (typeof raw !== 'object' || raw === null) continue;
      const h = raw as Partial<Record<keyof ImportHighlight, unknown>>;
      const quote = typeof h.text === 'string' ? h.text.trim() : '';
      // A passage longer than a selector carries would come back shorter than
      // it was (frontend textSelector.ts), so it's left out rather than cut.
      if (!quote || quote.length > MAX_HIGHLIGHT_LENGTH) continue;
      const note = text(h.note, MAX_NOTE_LENGTH);
      const createdAt =
        typeof h.createdAt === 'number' &&
        Number.isFinite(h.createdAt) &&
        h.createdAt >= EARLIEST_SAVE_MS &&
        h.createdAt <= now
          ? Math.floor(h.createdAt)
          : undefined;
      highlights.push({
        text: quote,
        ...(note ? { note } : {}),
        ...(createdAt ? { createdAt } : {}),
      });
      if (highlights.length === MAX_HIGHLIGHTS_PER_SAVE) break;
    }
  }

  return {
    url: href,
    urlKey: savedUrlKey(href),
    title: text(item.title, 1000),
    author: text(item.author, 300),
    description: text(item.description, 2000),
    domain: url.hostname.replace(/^www\./, '') || null,
    savedAt,
    archived: item.archived === true,
    tags,
    highlights,
  };
}

/**
 * A highlight's id, from its page and passage: importing the same export twice
 * lands on the same ids, and the merge write unions by id, so nothing doubles.
 */
async function importedHighlightId(url: string, quote: string): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(`${url}\0${quote}`));
  return `imp${digest.slice(0, 24)}`;
}

async function highlightProps(item: CleanItem, fallbackCreatedAt: number) {
  const seen = new Set<string>();
  const highlights = [];
  for (const h of item.highlights) {
    const id = await importedHighlightId(item.url, h.text);
    if (seen.has(id)) continue;
    seen.add(id);
    highlights.push({
      id,
      selector: { type: 'TextQuoteSelector', exact: h.text },
      createdAt: h.createdAt ?? fallbackCreatedAt,
      ...(h.note ? { note: h.note } : {}),
      sourceUrl: item.url,
      ...(item.title ? { sourceTitle: item.title } : {}),
    });
  }
  return highlights;
}

interface ExistingSave {
  url: string;
  url_key: string | null;
  record_uri: string | null;
}

/** The reader's saves that match any of these URLs, exactly or by normalized key. */
async function findExisting(env: Env, did: string, items: CleanItem[]): Promise<ExistingSave[]> {
  const found: ExistingSave[] = [];
  for (const chunk of chunkArray(items, LOOKUP_CHUNK)) {
    const urls = chunk.map((i) => i.url);
    const keys = chunk.map((i) => i.urlKey).filter(Boolean);
    const urlIn = urls.map(() => '?').join(',');
    const keyClause = keys.length ? ` OR url_key IN (${keys.map(() => '?').join(',')})` : '';
    const result = await env.DB.prepare(
      `SELECT url, url_key, record_uri FROM saved_articles
        WHERE user_did = ? AND (url IN (${urlIn})${keyClause})`
    )
      .bind(did, ...urls, ...keys)
      .all<ExistingSave>();
    found.push(...result.results);
  }
  return found;
}

/**
 * Write a batch of imported items. New URLs become saves with their labels;
 * URLs already in the Library keep everything they have and only gain the
 * export's highlights. Returns the counts and the rkeys of the new saves that
 * are still unread, newest first (the ones worth extracting first).
 */
export async function importSaves(
  env: Env,
  did: string,
  source: ImportSource,
  rawItems: unknown[]
): Promise<ImportResult & { unreadRkeys: string[] }> {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const result: ImportResult & { unreadRkeys: string[] } = {
    added: 0,
    duplicates: 0,
    invalid: 0,
    highlights: 0,
    unreadRkeys: [],
  };

  const items: CleanItem[] = [];
  for (const raw of rawItems) {
    const item = cleanImportItem(raw, now);
    if (item) items.push(item);
    else result.invalid++;
  }
  if (items.length === 0) return result;

  const existing = await findExisting(env, did, items);
  const existingByUrl = new Map<string, ExistingSave>();
  for (const row of existing) {
    existingByUrl.set(row.url, row);
    if (row.url_key) existingByUrl.set(`key:${row.url_key}`, row);
  }

  const statements: D1PreparedStatement[] = [];
  const labelInsert = (itemKey: string, label: string, props: unknown, merge = false) =>
    env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
       VALUES (?, ?, 'saved', ?, ?, ?, ?, ?, ?)
       ${merge ? MERGE_HIGHLIGHTS_CONFLICT : 'ON CONFLICT(user_did, item_key, label) DO NOTHING'}`
    ).bind(did, itemKey, label, JSON.stringify(props), generateTid(), nowSec, nowSec, now);

  const unread: { rkey: string; savedAt: number }[] = [];
  const seenInBatch = new Set<string>();
  for (const item of items) {
    const batchKey = item.urlKey || item.url;
    const match =
      existingByUrl.get(item.url) ?? (item.urlKey ? existingByUrl.get(`key:${item.urlKey}`) : null);
    if (match || seenInBatch.has(batchKey)) {
      result.duplicates++;
      // Highlights from the export still find the save they belong to. A save
      // with no record uri (a Semble/Margin-backed stub) has no key to file them under.
      if (match?.record_uri && item.highlights.length > 0) {
        const highlights = await highlightProps(item, now);
        statements.push(labelInsert(match.record_uri, 'highlights', { highlights }, true));
        result.highlights += highlights.length;
      }
      continue;
    }
    seenInBatch.add(batchKey);

    const rkey = generateTid();
    const recordUri = `at://${did}/${COLLECTION}/${rkey}`;
    statements.push(
      env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_key, title, author, description,
            content, content_type, domain, saved_at, created_at, updated_at, source, imported_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'webpage', ?, ?, ?, ?, 'url', ?)`
      ).bind(
        did,
        rkey,
        recordUri,
        item.url,
        item.urlKey,
        item.title,
        item.author,
        item.description,
        item.domain,
        item.savedAt,
        now,
        now,
        source
      )
    );
    result.added++;

    if (item.archived) {
      statements.push(labelInsert(recordUri, 'archived', { archivedAt: item.savedAt }));
    } else {
      unread.push({ rkey, savedAt: item.savedAt });
    }
    if (item.tags.length > 0) {
      statements.push(labelInsert(recordUri, 'tagged', { tags: item.tags }));
    }
    if (item.highlights.length > 0) {
      const highlights = await highlightProps(item, item.savedAt);
      statements.push(labelInsert(recordUri, 'highlights', { highlights }, true));
      result.highlights += highlights.length;
    }
  }

  if (statements.length > 0) await env.DB.batch(statements);
  result.unreadRkeys = unread.sort((a, b) => b.savedAt - a.savedAt).map((u) => u.rkey);
  return result;
}

/**
 * Extract the text of imported saves still waiting for it. Each one is filled
 * (or given the "couldn't find the text" note) by fillExtractedContent, which
 * stamps updated_at so every device picks the body up. A failure leaves the
 * save as it was, to be tried again when it's opened.
 */
export async function extractImportedSaves(
  env: Env,
  did: string,
  rkeys: string[]
): Promise<number> {
  if (rkeys.length === 0) return 0;
  const rows: { rkey: string; url: string }[] = [];
  for (const chunk of chunkArray(rkeys, LOOKUP_CHUNK)) {
    const result = await env.DB.prepare(
      `SELECT rkey, url FROM saved_articles
        WHERE user_did = ? AND rkey IN (${chunk.map(() => '?').join(',')})
          AND imported_from IS NOT NULL AND content IS NULL AND url != ''`
    )
      .bind(did, ...chunk)
      .all<{ rkey: string; url: string }>();
    rows.push(...result.results);
  }

  const proxy = new FeedProxyClient(env);
  const queue = [...rows];
  let filled = 0;
  async function worker() {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      try {
        const article = await proxy.extract(row.url, { userDid: did });
        await fillExtractedContent(
          env,
          article,
          { userDid: did, rkey: row.rkey },
          { url: row.url }
        );
        filled++;
      } catch (err) {
        console.error(`[import] extract failed for ${row.url}:`, err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, queue.length) }, worker));
  return filled;
}

/** POST /api/saved/import — { source, items: ImportItem[] } */
export async function handleImportSaved(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  let body: { source?: unknown; items?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const source = body.source;
  if (typeof source !== 'string' || !(IMPORT_SOURCES as readonly string[]).includes(source)) {
    return json({ error: 'Unknown source' }, 400);
  }
  if (!Array.isArray(body.items)) return json({ error: 'Missing items array' }, 400);
  if (body.items.length > MAX_IMPORT_ITEMS) {
    return json({ error: `At most ${MAX_IMPORT_ITEMS} items per request` }, 400);
  }

  // With Semble or Margin backing, the Saved list is that collection, and an
  // import would mean a public record per save. Not something to do in bulk
  // behind a file upload: the reader imports first, then turns backing on
  // (which offers to copy the Library across).
  const settings = await getUserSettings(env, session.did);
  if (settings.backing.provider !== 'skyreader') {
    return json(
      {
        error: 'backing_enabled',
        message:
          'Importing isn’t available while your saves are backed by Semble or Margin. Switch back to Skyreader, import, then turn backing on again.',
      },
      409
    );
  }

  try {
    const { unreadRkeys, ...result } = await importSaves(
      env,
      session.did,
      source as ImportSource,
      body.items
    );

    // Extract the newest unread saves now, so the first ones opened are ready.
    // Once per import, not per batch: a whole library extracted up front would
    // be thousands of fetches for pages nobody may open. The rest wait to be opened.
    if (unreadRkeys.length > 0) {
      const once = await checkRateLimit(env, session.did, IMPORT_EXTRACT_RATE_KEY);
      if (once.allowed) {
        ctx.waitUntil(
          extractImportedSaves(env, session.did, unreadRkeys.slice(0, EXTRACT_AFTER_IMPORT)).catch(
            (err) => console.error('[import] background extract failed:', err)
          )
        );
      }
    }

    return json(result);
  } catch (error) {
    console.error('Failed to import saves:', error);
    return json({ error: 'Failed to import saves' }, 500);
  }
}
