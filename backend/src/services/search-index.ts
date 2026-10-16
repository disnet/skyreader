/**
 * The D1 side of full-text search: which items changed, and what to index for
 * each. The index itself is a per-user SQLite Durable Object
 * (durable-objects/search-index.ts); this module is everything it reads from the
 * shared stores to build it. See docs/plans/FULL_TEXT_SEARCH.md.
 *
 * The index is derived data, rebuilt from records, so it *pulls*: it keeps
 * cursors over the two tables that say what a reader has touched —
 * `item_labels_cache` (`read`, `highlights`) and `saved_articles` — and every
 * change it sees is resolved by rebuilding that item's document from scratch.
 * Rebuild-by-key is idempotent, so a missed nudge or a replayed page costs work,
 * never correctness, and a first sync from cursor zero *is* the backfill.
 */

import type { Env, FeedItem } from '../types';
import { getLimitsForTier } from '../config/tier-limits';
import { afterCursorParams, afterCursorSql, type DeltaCursor } from '../utils/delta-cursor';
import { htmlToText, stripControlChars, truncateText } from '../utils/html-text';
import { itemBodyKey } from '../routes/item-bodies';
import { log, serializeError } from '../utils/logger';

export const KIND_READ = 1;
export const KIND_SAVED = 2;
export const KIND_HIGHLIGHTED = 4;

/** Body text kept for an item that was only read: enough to find it by its opening. */
export const READ_BODY_CHARS = 2_000;
/** Body text kept for a saved or highlighted item: the whole article, within reason. */
export const FULL_BODY_CHARS = 64_000;
/**
 * Body text kept for a saved PDF or EPUB: about 100k words, so the whole of nearly
 * every book (their stored extraction stops at 1 MB of HTML anyway). The cap keeps
 * an index row under the Durable Object's 2 MB row limit even for text that takes
 * 3 bytes a character in UTF-8. Affordable because a book's text is written once:
 * a highlight or a note rewrites only the item's notes (durable-objects/search-index.ts).
 */
export const BOOK_BODY_CHARS = 600_000;
const MAX_NOTES_CHARS = 16_000;
/**
 * Part of every body version: bump it when htmlToText or stripControlChars
 * changes what a body extracts to, so kept bodies are re-extracted.
 */
const BODY_EXTRACTOR_VERSION = 1;

/** Operator switch, a `sync_state` row: only an explicit '1' turns search on. */
export const SEARCH_ENABLED_KEY = 'search_enabled';

// D1 caps bound parameters per statement well below SQLite's 999.
const IN_CHUNK = 80;
// Feed-item lookups probe every subscription for each guid, so keep them smaller.
const GUID_CHUNK = 40;
/** R2 reads per build, for saved/highlighted feed items whose full body is in R2. */
const MAX_R2_BODIES_PER_BUILD = 25;
/**
 * Saved HTML one build loads, in characters. A saved book's is up to 1 MB, so a
 * batch of fresh uploads would otherwise hold tens of MB of it (twice that as JS
 * strings) in a 128 MB isolate. Past this, the rest of the batch is deferred.
 */
const MAX_BUILD_CONTENT_CHARS = 4_000_000;

export interface SavedCursor {
  at: number;
  id: number;
}

export interface SyncCursors {
  labels: DeltaCursor;
  savedAt: SavedCursor;
  savedUpdated: SavedCursor;
}

export const ZERO_CURSORS: SyncCursors = {
  labels: { updatedAt: 0, id: 0 },
  savedAt: { at: 0, id: 0 },
  savedUpdated: { at: 0, id: 0 },
};

/** One item as the index stores it. */
export interface IndexDoc {
  key: string;
  itemType: string;
  url: string | null;
  feedUrl: string | null;
  feedTitle: string;
  title: string;
  author: string;
  /**
   * Null when `bodyVersion` matches what the index already holds (from
   * `indexedVersion`): the text didn't change, so it wasn't loaded.
   */
  body: string | null;
  /**
   * What the body was built from, for a save with stored text: its id, edit
   * time, length, type and the cap applied. Null for anything else.
   */
  bodyVersion: string | null;
  notes: string;
  kinds: number;
  readAt: number | null;
  savedAt: number | null;
  highlightedAt: number | null;
}

export interface BuildResult {
  upserts: IndexDoc[];
  /** Keys whose document should be removed: nothing touched them any more, or they were aliases. */
  deletes: string[];
  /**
   * Canonical keys left for another call: the saves' text this call would have
   * had to load ran past MAX_BUILD_CONTENT_CHARS. Never all of the keys.
   */
  deferred: string[];
}

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

// --- eligibility ---------------------------------------------------------------

export interface SearchAccess {
  /** The operator switch is on in this environment. */
  enabled: boolean;
  /** The reader's plan includes search. */
  entitled: boolean;
}

/** One query: the operator switch and the reader's plan. */
export async function getSearchAccess(env: Env, did: string): Promise<SearchAccess> {
  const row = await env.DB.prepare(
    `SELECT (SELECT value FROM sync_state WHERE key = ?) AS switch_value,
            (SELECT tier FROM users WHERE did = ?) AS tier`
  )
    .bind(SEARCH_ENABLED_KEY, did)
    .first<{ switch_value: string | null; tier: string | null }>();
  return {
    enabled: row?.switch_value === '1',
    entitled: getLimitsForTier(row?.tier ?? 'free').fullTextSearch,
  };
}

/** Just the operator switch, for clients deciding whether to offer search at all. */
export async function isSearchEnabled(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM sync_state WHERE key = ?`)
      .bind(SEARCH_ENABLED_KEY)
      .first<{ value: string }>();
    return row?.value === '1';
  } catch {
    // A failed read hides search; it never breaks sign-in.
    return false;
  }
}

/** The search index's stub for one reader: one Durable Object per DID. */
export function searchIndexStub(env: Env, did: string) {
  return env.SEARCH_INDEX.get(env.SEARCH_INDEX.idFromName(did));
}

/**
 * Tell a reader's index that something it covers may have changed. Runs after
 * the response (ctx.waitUntil), so it never slows a write; a failure is logged
 * and otherwise harmless, because the next sync's cursors still see the change.
 */
export async function nudgeSearchIndex(
  env: Env,
  did: string,
  opts: { reconcileSaved?: boolean } = {}
): Promise<void> {
  try {
    const access = await getSearchAccess(env, did);
    if (!access.enabled || !access.entitled) return;
    await searchIndexStub(env, did).nudge(did, opts);
  } catch (error) {
    log.warn('search_index_nudge_failed', serializeError(error));
  }
}

/** Write routes whose success can change what a reader's index holds. */
export function searchNudgeFor(
  method: string,
  pathname: string
): { reconcileSaved: boolean } | null {
  if (method === 'GET' || method === 'OPTIONS') return null;
  if (pathname.startsWith('/api/reading/mark-') || pathname.startsWith('/api/labels')) {
    return { reconcileSaved: false };
  }
  if (pathname.startsWith('/api/saved')) {
    // Saves are hard-deleted, so no cursor ever sees a removal: a delete asks the
    // index to diff its saved set against D1.
    return { reconcileSaved: method === 'DELETE' };
  }
  return null;
}

// --- change feed ---------------------------------------------------------------

interface SavedKeyRow {
  id: number;
  rkey: string;
  record_uri: string | null;
  item_guid: string | null;
}

/** The key the index (and the reader's highlights) file a save under: the guid when it bridges to one. */
export function savedItemKey(row: Pick<SavedKeyRow, 'rkey' | 'record_uri' | 'item_guid'>): string {
  return row.item_guid || row.record_uri || `saved:${row.rkey}`;
}

/**
 * How far behind "now" the cursors stay. `item_labels_cache.updated_at` has
 * one-second resolution, and a row re-written within the same second as the
 * cursor (read, then unread) would compare equal to it and never be seen again.
 * Rows newer than this are still processed, just not passed: the next sync
 * rebuilds them once more, which is idempotent.
 */
export const CURSOR_LAG_MS = 2_000;

export interface ChangePage {
  keys: string[];
  cursors: SyncCursors;
  /** More changes remain past this page. */
  more: boolean;
  /** Some rows were too recent to pass (CURSOR_LAG_MS): sync again once they settle. */
  unsettled: boolean;
}

/**
 * The next page of item keys touched since `cursors`, from all three cursors.
 * Keys are raw (a label may be filed under a save's URI); `buildIndexDocs`
 * canonicalizes them.
 */
export async function collectChangedKeys(
  env: Env,
  did: string,
  cursors: SyncCursors,
  pageSize: number,
  nowMs = Date.now()
): Promise<ChangePage> {
  const settledSec = Math.floor((nowMs - CURSOR_LAG_MS) / 1000);
  const settledMs = nowMs - CURSOR_LAG_MS;
  const [labels, savedAt, savedUpdated] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, item_key, updated_at FROM item_labels_cache
        WHERE user_did = ? AND label IN ('read', 'highlights')
          AND ${afterCursorSql()}
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`
    ).bind(did, ...afterCursorParams(cursors.labels), pageSize + 1),
    env.DB.prepare(
      `SELECT id, rkey, record_uri, item_guid, saved_at AS at FROM saved_articles
        WHERE user_did = ? AND ${afterCursorSql('saved_at')}
        ORDER BY saved_at ASC, id ASC
        LIMIT ?`
    ).bind(did, cursors.savedAt.at, cursors.savedAt.at, cursors.savedAt.id, pageSize + 1),
    env.DB.prepare(
      `SELECT id, rkey, record_uri, item_guid, updated_at AS at FROM saved_articles
        WHERE user_did = ? AND updated_at IS NOT NULL AND ${afterCursorSql('updated_at')}
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`
    ).bind(
      did,
      cursors.savedUpdated.at,
      cursors.savedUpdated.at,
      cursors.savedUpdated.id,
      pageSize + 1
    ),
  ]);

  const keys = new Set<string>();
  const next: SyncCursors = {
    labels: { ...cursors.labels },
    savedAt: { ...cursors.savedAt },
    savedUpdated: { ...cursors.savedUpdated },
  };
  let more = false;
  let unsettled = false;

  const labelRows = (labels.results ?? []) as {
    id: number;
    item_key: string;
    updated_at: number;
  }[];
  if (labelRows.length > pageSize) more = true;
  for (const row of labelRows.slice(0, pageSize)) {
    keys.add(row.item_key);
    if (row.updated_at < settledSec) next.labels = { updatedAt: row.updated_at, id: row.id };
    else unsettled = true;
  }

  for (const [result, field] of [
    [savedAt, 'savedAt'],
    [savedUpdated, 'savedUpdated'],
  ] as const) {
    const rows = (result.results ?? []) as (SavedKeyRow & { at: number })[];
    if (rows.length > pageSize) more = true;
    for (const row of rows.slice(0, pageSize)) {
      keys.add(savedItemKey(row));
      if (row.at < settledMs) next[field] = { at: row.at, id: row.id };
      else unsettled = true;
    }
  }

  return { keys: [...keys], cursors: next, more, unsettled };
}

/** Every key the reader's saves are filed under, for diffing out hard-deleted saves. */
export async function listSavedKeys(env: Env, did: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT rkey, record_uri, item_guid FROM saved_articles WHERE user_did = ?`
  )
    .bind(did)
    .all<SavedKeyRow>();
  return new Set((rows.results ?? []).map(savedItemKey));
}

// --- document builder ----------------------------------------------------------

interface SavedRow extends SavedKeyRow {
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  /** Not in the first read: loaded per batch by loadSavedContent, within a budget. */
  content?: string | null;
  content_chars: number | null;
  content_type: string | null;
  updated_at: number | null;
  saved_at: number;
}

interface LabelRow {
  item_key: string;
  item_type: string;
  label: string;
  props: string | null;
  updated_at: number;
}

interface ReadProps {
  readAt?: number;
  itemUrl?: string | null;
  itemTitle?: string | null;
}

interface StoredHighlight {
  selector?: { exact?: string };
  note?: string;
  createdAt?: number;
  sourceUrl?: string;
  sourceTitle?: string;
}

interface FeedItemRow {
  feed_url: string;
  guid: string;
  item_json: string;
}

interface DocumentRow {
  record_uri: string;
  title: string | null;
  description: string | null;
  text_content: string | null;
  canonical_url: string | null;
}

/**
 * Rebuild the documents for `rawKeys` from D1 (and R2 for long bodies). An item
 * the reader no longer reads, saves or highlights comes back as a delete, as does
 * a raw key that turned out to be an alias of another item's canonical key.
 */
export async function buildIndexDocs(
  env: Env,
  did: string,
  rawKeys: string[],
  /** The body version the index holds for a canonical key, so unchanged text isn't reloaded. */
  indexedVersion: (key: string) => string | null = () => null
): Promise<BuildResult> {
  if (rawKeys.length === 0) return { upserts: [], deletes: [], deferred: [] };
  const deletes = new Set<string>();

  // 1. Saves touching these keys, by either of the keys a save can be filed under.
  const savedByCanonical = new Map<string, SavedRow>();
  const canonicalOf = new Map<string, string>();
  for (const keys of chunk(rawKeys, IN_CHUNK / 2)) {
    const rows = await env.DB.prepare(
      `SELECT id, rkey, record_uri, item_guid, url, title, author, description, length(content) AS content_chars, content_type, updated_at, saved_at
         FROM saved_articles
        WHERE user_did = ? AND (item_guid IN (${placeholders(keys.length)})
                                OR record_uri IN (${placeholders(keys.length)}))`
    )
      .bind(did, ...keys, ...keys)
      .all<SavedRow>();
    for (const row of rows.results ?? []) {
      const canonical = savedItemKey(row);
      savedByCanonical.set(canonical, row);
      for (const alias of [row.item_guid, row.record_uri]) {
        if (alias) canonicalOf.set(alias, canonical);
      }
    }
  }
  // Rows under `saved:<rkey>` keys have no alias column to match on.
  for (const key of rawKeys) {
    if (!key.startsWith('saved:') || savedByCanonical.has(key)) continue;
    const row = await env.DB.prepare(
      `SELECT id, rkey, record_uri, item_guid, url, title, author, description, length(content) AS content_chars, content_type, updated_at, saved_at
         FROM saved_articles WHERE user_did = ? AND rkey = ?`
    )
      .bind(did, key.slice('saved:'.length))
      .first<SavedRow>();
    if (row) savedByCanonical.set(savedItemKey(row), row);
  }

  const canonicalKeys = new Set<string>();
  for (const key of rawKeys) {
    const canonical = canonicalOf.get(key) ?? key;
    canonicalKeys.add(canonical);
    // A label filed under a save's URI belongs to the guid-keyed item: drop any
    // document the index built under the alias before the save bridged.
    if (canonical !== key) deletes.add(key);
  }

  // 2. Live read/highlight labels under every alias of each item.
  const aliasesOf = new Map<string, string[]>();
  for (const canonical of canonicalKeys) {
    const saved = savedByCanonical.get(canonical);
    const aliases = [canonical, saved?.item_guid, saved?.record_uri].filter(
      (k, i, all): k is string => !!k && all.indexOf(k) === i
    );
    aliasesOf.set(canonical, aliases);
  }
  const allAliases = [...new Set([...aliasesOf.values()].flat())];
  const labelsByKey = new Map<string, LabelRow[]>();
  for (const keys of chunk(allAliases, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT item_key, item_type, label, props, updated_at FROM item_labels_cache
        WHERE user_did = ? AND item_key IN (${placeholders(keys.length)})
          AND label IN ('read', 'highlights') AND deleted_at IS NULL`
    )
      .bind(did, ...keys)
      .all<LabelRow>();
    for (const row of rows.results ?? []) {
      const list = labelsByKey.get(row.item_key) ?? [];
      list.push(row);
      labelsByKey.set(row.item_key, list);
    }
  }

  // 3. What each item is, before fetching any text.
  interface Draft {
    key: string;
    itemType: string;
    kinds: number;
    readAt: number | null;
    savedAt: number | null;
    highlightedAt: number | null;
    fallbackUrl: string | null;
    fallbackTitle: string;
    notes: string;
    saved: SavedRow | undefined;
  }
  const drafts: Draft[] = [];
  for (const canonical of canonicalKeys) {
    const saved = savedByCanonical.get(canonical);
    const labels = (aliasesOf.get(canonical) ?? []).flatMap((k) => labelsByKey.get(k) ?? []);
    let kinds = saved ? KIND_SAVED : 0;
    let readAt: number | null = null;
    let highlightedAt: number | null = null;
    let itemType = saved && !saved.item_guid ? 'saved' : 'article';
    let fallbackUrl: string | null = saved?.url || null;
    let fallbackTitle = saved?.title ?? '';
    const noteParts: string[] = [];
    for (const label of labels) {
      if (label.item_type === 'document') itemType = 'document';
      if (label.label === 'read') {
        kinds |= KIND_READ;
        const props = parseJson<ReadProps>(label.props);
        const at = props?.readAt ?? label.updated_at * 1000;
        readAt = Math.max(readAt ?? 0, typeof at === 'number' ? at : Date.parse(at) || 0);
        fallbackUrl ??= props?.itemUrl || null;
        fallbackTitle ||= props?.itemTitle ?? '';
      } else {
        const highlights =
          parseJson<{ highlights?: StoredHighlight[] }>(label.props)?.highlights ?? [];
        if (highlights.length === 0) continue;
        kinds |= KIND_HIGHLIGHTED;
        for (const h of highlights) {
          if (h.selector?.exact) noteParts.push(h.selector.exact);
          if (h.note) noteParts.push(h.note);
          highlightedAt = Math.max(highlightedAt ?? 0, h.createdAt ?? label.updated_at * 1000);
          fallbackUrl ??= h.sourceUrl || null;
          fallbackTitle ||= h.sourceTitle ?? '';
        }
      }
    }
    if (kinds === 0) {
      deletes.add(canonical);
      continue;
    }
    drafts.push({
      key: canonical,
      itemType,
      kinds,
      readAt,
      savedAt: saved ? saved.saved_at : null,
      highlightedAt,
      fallbackUrl,
      fallbackTitle,
      notes: truncateText(noteParts.join('\n'), MAX_NOTES_CHARS),
      saved,
    });
  }

  // 4. Text: the save's own body first; else the feed archive (and R2 for long
  //    bodies); standard.site documents from their record.
  const needsFeedItem = drafts.filter((d) => d.itemType !== 'document' && d.itemType !== 'saved');
  const feedItems = await lookupFeedItems(
    env,
    did,
    needsFeedItem.map((d) => d.key)
  );
  const documents = await lookupDocuments(
    env,
    drafts.filter((d) => d.itemType === 'document').map((d) => d.key)
  );
  const feedTitles = await lookupFeedTitles(env, [
    ...new Set([...feedItems.values()].map((r) => r.feed_url)),
  ]);

  // A save whose text the index already holds isn't loaded: a highlight on a
  // book would otherwise re-read and re-strip a megabyte of HTML.
  const bodyCharsOf = (d: Draft) => {
    const full = (d.kinds & (KIND_SAVED | KIND_HIGHLIGHTED)) !== 0;
    const book = d.saved?.content_type === 'pdf' || d.saved?.content_type === 'epub';
    return book ? BOOK_BODY_CHARS : full ? FULL_BODY_CHARS : READ_BODY_CHARS;
  };
  const versions = new Map<string, string>();
  const kept = new Set<string>();
  for (const d of drafts) {
    const saved = d.saved;
    // A document's body comes from its record's text, not the save's HTML.
    if (!saved?.content_chars || d.itemType === 'document') continue;
    const version = [
      BODY_EXTRACTOR_VERSION,
      saved.id,
      saved.updated_at ?? '',
      saved.content_chars,
      saved.content_type ?? '',
      bodyCharsOf(d),
    ].join(':');
    versions.set(d.key, version);
    if (indexedVersion(d.key) === version) {
      kept.add(d.key);
      saved.content = null; // never loaded
    }
  }

  let r2Budget = MAX_R2_BODIES_PER_BUILD;
  let contentBudget = MAX_BUILD_CONTENT_CHARS;
  const upserts: IndexDoc[] = [];
  const deferred: string[] = [];
  for (const [i, d] of drafts.entries()) {
    if (d.saved && d.saved.content === undefined) {
      if (i > 0 && (d.saved.content_chars ?? 0) > contentBudget) {
        deferred.push(...drafts.slice(i).map((rest) => rest.key));
        break;
      }
      contentBudget -= await loadSavedContent(env, did, drafts.slice(i), contentBudget);
    }
    const full = (d.kinds & (KIND_SAVED | KIND_HIGHLIGHTED)) !== 0;
    const bodyChars = bodyCharsOf(d);
    const feedRow = feedItems.get(d.key);
    const item = feedRow ? parseJson<FeedItem>(feedRow.item_json) : null;
    const doc = documents.get(d.key);

    let body: string | null = null;
    if (!kept.has(d.key)) {
      let html = d.saved?.content || '';
      if (d.saved) d.saved.content = null; // done with it; don't hold a book for the batch
      if (!html && item) {
        if (full && item.bodyStored && env.ITEM_BODIES && r2Budget > 0) {
          r2Budget--;
          html = (await readStoredBody(env, feedRow!.feed_url, d.key)) ?? '';
        }
        html ||= item.content || item.contentLead || '';
      }
      const lead = d.saved?.description || item?.summary || doc?.description || '';
      const bodyText = doc?.text_content
        ? truncateText(doc.text_content, bodyChars)
        : htmlToText(html, bodyChars);
      body = stripControlChars(bodyText || htmlToText(lead, bodyChars));
      // Fell back to the lead: the version describes the save's HTML, not this.
      if (!bodyText) versions.delete(d.key);
    }

    upserts.push({
      key: d.key,
      itemType: d.itemType,
      url: d.saved?.url || item?.url || doc?.canonical_url || d.fallbackUrl,
      feedUrl: feedRow?.feed_url ?? null,
      feedTitle: stripControlChars((feedRow && feedTitles.get(feedRow.feed_url)) || ''),
      title: stripControlChars(
        truncateText(d.saved?.title || item?.title || doc?.title || d.fallbackTitle || '', 500)
      ),
      author: stripControlChars(truncateText(d.saved?.author || item?.author || '', 200)),
      body,
      bodyVersion: versions.get(d.key) ?? null,
      notes: stripControlChars(d.notes),
      kinds: d.kinds,
      readAt: d.readAt,
      savedAt: d.savedAt,
      highlightedAt: d.highlightedAt,
    });
  }

  return { upserts, deletes: [...deletes], deferred };
}

/**
 * Load the saved HTML for the saves among `drafts`, in order, while it fits in
 * `budget` characters (the first always loads). Returns the characters loaded.
 */
async function loadSavedContent(
  env: Env,
  did: string,
  drafts: { saved: SavedRow | undefined }[],
  budget: number
): Promise<number> {
  const batch: SavedRow[] = [];
  let used = 0;
  for (const { saved } of drafts) {
    if (!saved || saved.content !== undefined) continue;
    const chars = saved.content_chars ?? 0;
    if (batch.length > 0 && used + chars > budget) break;
    used += chars;
    if (chars === 0) saved.content = null;
    else batch.push(saved);
    if (batch.length >= IN_CHUNK) break;
  }
  if (batch.length === 0) return used;
  const rows = await env.DB.prepare(
    `SELECT id, content FROM saved_articles
      WHERE user_did = ? AND id IN (${placeholders(batch.length)})`
  )
    .bind(did, ...batch.map((saved) => saved.id))
    .all<{ id: number; content: string | null }>();
  const contentById = new Map((rows.results ?? []).map((row) => [row.id, row.content]));
  for (const saved of batch) saved.content = contentById.get(saved.id) ?? null;
  return used;
}

/**
 * Feed items by guid, scoped to the reader's subscriptions. Read labels don't
 * record their feed, and `feed_items` is only indexed on `(feed_url, guid)`, so
 * the lookup walks the reader's subscriptions and probes that unique index once
 * per (subscription, guid) — the same shape as the timeline's read join, in
 * reverse. An item from a feed the reader has since unsubscribed from isn't
 * found; its document keeps the title and URL the read label carries.
 */
async function lookupFeedItems(
  env: Env,
  did: string,
  guids: string[]
): Promise<Map<string, FeedItemRow>> {
  const found = new Map<string, FeedItemRow>();
  for (const keys of chunk(guids, GUID_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT fi.feed_url, fi.guid, fi.item_json
         FROM subscriptions_cache s
         JOIN feed_items fi ON fi.feed_url = s.feed_url AND fi.guid IN (${placeholders(keys.length)})
        WHERE s.user_did = ?`
    )
      .bind(...keys, did)
      .all<FeedItemRow>();
    for (const row of rows.results ?? []) {
      if (!found.has(row.guid)) found.set(row.guid, row);
    }
  }
  return found;
}

async function lookupDocuments(env: Env, uris: string[]): Promise<Map<string, DocumentRow>> {
  const found = new Map<string, DocumentRow>();
  for (const keys of chunk(uris, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT record_uri, canonical_url,
              json_extract(record_json, '$.title') AS title,
              json_extract(record_json, '$.description') AS description,
              json_extract(record_json, '$.textContent') AS text_content
         FROM documents_v2 WHERE record_uri IN (${placeholders(keys.length)})`
    )
      .bind(...keys)
      .all<DocumentRow>();
    for (const row of rows.results ?? []) found.set(row.record_uri, row);
  }
  return found;
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
    log.warn('search_index_body_read_failed', serializeError(error));
    return null;
  }
}
