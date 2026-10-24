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
import { backfillSavedUrlKeys, savedUrlKey } from '../services/semble-connections';
import { generateTid } from '../utils/tid';
import { sha256Hex } from '../utils/sha256';
import { chunkArray } from './reading';
import { FeedProxyClient } from '../services/feed-proxy-client';
import { fillExtractedContent } from '../services/saved-content';
import { checkRateLimit } from '../services/rate-limit';
import { log, serializeError } from '../utils/logger';
import { MAX_COLLECTIONS, MAX_ITEMS_PER_COLLECTION } from './shelf';

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
// Characters of highlight text and notes kept per save, well inside D1's 2 MB
// value limit: a label row past it would fail the whole batch, every retry.
const MAX_HIGHLIGHT_CHARS_PER_SAVE = 500_000;
// Bound parameters per IN (...) lookup; two per URL, under D1's cap.
const LOOKUP_CHUNK = 40;
// Imported saves extracted in the background after an import: enough that the
// newest few open ready to read. Everything else is extracted when opened. Two
// rounds of EXTRACT_CONCURRENCY, so it finishes inside waitUntil's time after
// the response.
const EXTRACT_AFTER_IMPORT = 8;
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
  let highlightChars = 0;
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
      highlightChars += quote.length + (note?.length ?? 0);
      if (highlightChars > MAX_HIGHLIGHT_CHARS_PER_SAVE) break;
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

/** A highlight's id, from its page and passage, so it's the same on every import. */
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
  rkey: string;
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
      `SELECT rkey, url, url_key, record_uri FROM saved_articles
        WHERE user_did = ? AND (url IN (${urlIn})${keyClause})`
    )
      .bind(did, ...urls, ...keys)
      .all<ExistingSave>();
    found.push(...result.results);
  }
  return found;
}

/**
 * Write a batch of imported items. New URLs become saves with their labels.
 * URLs already in the Library keep everything they have, and gain the export's
 * highlights only if they have never had any: a save the reader has highlighted
 * (or cleared of highlights) is theirs, and importing again must not bring back
 * what they deleted. Returns the counts and the rkeys of the new saves that are
 * still unread, newest first (the ones worth extracting first).
 */
const SOURCE_NAMES: Record<ImportSource, string> = {
  pocket: 'Pocket',
  omnivore: 'Omnivore',
  instapaper: 'Instapaper',
  readwise: 'Readwise Reader',
  matter: 'Matter',
};

/** The Shelf collection an import from `source` files into, and its overflow names. */
export function importCollectionName(source: ImportSource, part = 1): string {
  const base = `Imported from ${SOURCE_NAMES[source]}`;
  return part === 1 ? base : `${base} (${part})`;
}

/**
 * Files an import's articles in a Shelf collection named for the app they came
 * from (routes/shelf.ts), created on the first import. A library bigger than a
 * collection holds runs on into "… (2)" and so on. An article already in one of
 * them isn't added again, so re-running an import leaves them as they were.
 * A reader already at the collection limit gets the saves without one.
 */
async function fileInImportCollection(
  env: Env,
  did: string,
  source: ImportSource,
  rkeys: string[],
  nowSec: number
): Promise<void> {
  if (rkeys.length === 0) return;
  const base = importCollectionName(source);
  const { results: owned } = await env.DB.prepare(
    `SELECT c.id, c.name,
            (SELECT COUNT(*) FROM shelf_collection_items i
              WHERE i.user_did = c.user_did AND i.collection_id = c.id) AS n,
            (SELECT MAX(position) FROM shelf_collection_items i
              WHERE i.user_did = c.user_did AND i.collection_id = c.id) AS maxPos
       FROM shelf_collections c
      WHERE c.user_did = ? AND (c.name = ? OR c.name LIKE ?)
      ORDER BY c.created_at ASC, c.id ASC`
  )
    .bind(did, base, `${base} (%)`)
    .all<{ id: string; name: string; n: number; maxPos: number | null }>();

  let pending = rkeys;
  if (owned.length > 0) {
    const ids = owned.map((c) => c.id);
    const filed = new Set<string>();
    // Ids and rkeys together stay under D1's bound-parameter cap.
    for (const chunk of chunkArray(rkeys, Math.max(1, 90 - ids.length))) {
      const { results } = await env.DB.prepare(
        `SELECT saved_rkey FROM shelf_collection_items
          WHERE user_did = ? AND collection_id IN (${ids.map(() => '?').join(',')})
            AND saved_rkey IN (${chunk.map(() => '?').join(',')})`
      )
        .bind(did, ...ids, ...chunk)
        .all<{ saved_rkey: string }>();
      for (const row of results) filed.add(row.saved_rkey);
    }
    pending = rkeys.filter((rkey) => !filed.has(rkey));
  }
  if (pending.length === 0) return;

  const statements: D1PreparedStatement[] = [];
  let current = owned.at(-1);
  let room = current ? MAX_ITEMS_PER_COLLECTION - current.n : 0;
  let position = (current?.maxPos ?? -1) + 1;
  let part = owned.length;
  let collections: { n: number; maxPos: number | null } | null = null;
  let filledExisting = false;
  for (const rkey of pending) {
    if (!current || room <= 0) {
      collections ??= await env.DB.prepare(
        'SELECT COUNT(*) AS n, MAX(position) AS maxPos FROM shelf_collections WHERE user_did = ?'
      )
        .bind(did)
        .first<{ n: number; maxPos: number | null }>();
      if (!collections || collections.n >= MAX_COLLECTIONS) break;
      part++;
      collections.n++;
      collections.maxPos = (collections.maxPos ?? -1) + 1;
      current = { id: generateTid(), name: importCollectionName(source, part), n: 0, maxPos: null };
      statements.push(
        env.DB.prepare(
          `INSERT INTO shelf_collections (user_did, id, name, description, position, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?)`
        ).bind(did, current.id, current.name, collections.maxPos, nowSec, nowSec)
      );
      room = MAX_ITEMS_PER_COLLECTION;
      position = 0;
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_did, collection_id, saved_rkey) DO NOTHING`
      ).bind(did, current.id, rkey, position++, nowSec)
    );
    room--;
    filledExisting ||= current === owned.at(-1);
  }
  if (filledExisting) {
    statements.push(
      env.DB.prepare(
        'UPDATE shelf_collections SET updated_at = ? WHERE user_did = ? AND id = ?'
      ).bind(nowSec, did, owned.at(-1)!.id)
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
}

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

  // The same article twice in a batch (two URLs that normalize alike) is one
  // save, with both entries' tags and highlights.
  const byKey = new Map<string, CleanItem>();
  for (const item of items) {
    const key = item.urlKey || item.url;
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, item);
      continue;
    }
    result.duplicates++;
    kept.archived ||= item.archived;
    for (const tag of item.tags) {
      if (kept.tags.length < MAX_TAGS && !kept.tags.includes(tag)) kept.tags.push(tag);
    }
    for (const h of item.highlights) {
      if (!kept.highlights.some((k) => k.text === h.text)) kept.highlights.push(h);
    }
  }
  items.splice(0, items.length, ...byKey.values());

  const existing = await findExisting(env, did, items);
  const existingByUrl = new Map<string, ExistingSave>();
  for (const row of existing) {
    existingByUrl.set(row.url, row);
    if (row.url_key) existingByUrl.set(`key:${row.url_key}`, row);
  }

  const statements: D1PreparedStatement[] = [];
  // DO NOTHING: a new save's key is fresh, and an existing save's labels are the reader's.
  const labelInsert = (itemKey: string, label: string, props: unknown) =>
    env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
       VALUES (?, ?, 'saved', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_did, item_key, label) DO NOTHING`
    ).bind(did, itemKey, label, JSON.stringify(props), generateTid(), nowSec, nowSec, now);
  // Highlight writes, by statement index: counted only if the row was written.
  const highlightWrites: { index: number; count: number }[] = [];
  const pushHighlights = async (itemKey: string, item: CleanItem, fallbackCreatedAt: number) => {
    const highlights = await highlightProps(item, fallbackCreatedAt);
    highlightWrites.push({ index: statements.length, count: highlights.length });
    statements.push(labelInsert(itemKey, 'highlights', { highlights }));
  };

  const unread: { rkey: string; savedAt: number }[] = [];
  // Every article in the export, new or already saved, in the export's order.
  const members: string[] = [];
  for (const item of items) {
    const match =
      existingByUrl.get(item.url) ?? (item.urlKey ? existingByUrl.get(`key:${item.urlKey}`) : null);
    if (match) {
      result.duplicates++;
      if (!members.includes(match.rkey)) members.push(match.rkey);
      // Highlights from the export still find the save they belong to. A save
      // with no record uri (a Semble/Margin-backed stub) has no key to file them under.
      if (match.record_uri && item.highlights.length > 0) {
        await pushHighlights(match.record_uri, item, now);
      }
      continue;
    }

    const rkey = generateTid();
    const recordUri = `at://${did}/${COLLECTION}/${rkey}`;
    members.push(rkey);
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
    if (item.highlights.length > 0) await pushHighlights(recordUri, item, item.savedAt);
  }

  if (statements.length > 0) {
    const written = await env.DB.batch(statements);
    for (const { index, count } of highlightWrites) {
      if ((written[index]?.meta?.changes ?? 0) > 0) result.highlights += count;
    }
  }
  await fileInImportCollection(env, did, source, members, nowSec);
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
        log.warn('import_extract_failed', { url: row.url, ...serializeError(err) });
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
    // Older saves have no url_key yet, and dedupe matches on it.
    await backfillSavedUrlKeys(env, session.did);
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
            (err) => log.error('import_background_extract_failed', serializeError(err))
          )
        );
      }
    }

    return json(result);
  } catch (error) {
    log.error('import_failed', { source, ...serializeError(error) });
    return json({ error: 'Failed to import saves' }, 500);
  }
}
