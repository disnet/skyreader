// A reader's saves and highlights, gathered for export.
//
// Built over the archive records (services/archive/records.ts), not raw rows:
// each save and highlight goes through the same mapping a space sync will use,
// so when the source of truth moves to the reader's space, this reads records
// from there and nothing downstream changes.

import type { Env } from '../../types';
import { getUserSettings } from '../../routes/settings';
import { listBackedSaved, type SavedArticleView } from '../backing/sync';
import {
  highlightEntriesFromLabel,
  highlightToRecord,
  saveToRecord,
  type ArchiveRecord,
  type SaveRow,
  type SavedFileRow,
} from '../archive/records';
import { log } from '../../utils/logger';
import { idsFromUrl, scholarlyIds } from './identifiers';
import type { ExportDocument, ExportHighlight, ExportSource } from './render';

// How much of a saved PDF's body is read for its first page. A first page is a
// few thousand characters of text; the HTML around it roughly doubles that.
export const FIRST_PAGE_HTML_CHARS = 20_000;

const IN_CHUNK = 90;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type RecordValue = ArchiveRecord['record'][string];

// A record field, or the column's value from `extra` when it rode there (a
// string with a lone surrogate, say). Export only reads strings.
function stringField(record: ArchiveRecord['record'], field: string, column = field) {
  const value: RecordValue = record[field];
  if (typeof value === 'string') return value || undefined;
  if (typeof record.extra !== 'string') return undefined;
  try {
    const extra = JSON.parse(record.extra) as Record<string, unknown>;
    const raw = extra[column];
    if (typeof raw === 'string') return raw.toWellFormed() || undefined;
    // A datetime column that rode in extra is a number of ms.
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
  } catch {
    // extra is canonical JSON by construction; nothing to read if it isn't.
  }
  return undefined;
}

interface SaveRowWithHead extends SaveRow {
  id: number;
  first_page_html: string | null;
}

function sourceFromSaveRecord(
  { record }: ArchiveRecord,
  firstPageHtml: string | null
): ExportSource {
  const url = stringField(record, 'url');
  const contentType = stringField(record, 'contentType', 'content_type');
  const file = record.file as ArchiveRecord['record'] | undefined;
  return {
    kind: 'save',
    title: stringField(record, 'title'),
    url,
    author: stringField(record, 'author'),
    domain: stringField(record, 'domain'),
    publishedAt: stringField(record, 'publishedAt', 'published_at'),
    savedAt: stringField(record, 'savedAt', 'saved_at'),
    filename: file ? stringField(file, 'filename') : undefined,
    contentType,
    ...scholarlyIds({
      url: url ?? '',
      doi: stringField(record, 'doi'),
      contentType,
      firstPageHtml,
    }),
    highlights: [],
  };
}

interface HighlightLabelRow {
  id: number;
  item_key: string;
  item_type: string;
  props: string | null;
  deleted_at: number | null;
  updated_at: number;
}

interface PendingHighlight {
  id: string;
  createdAt: number;
  entry: ExportHighlight;
  sourceUrl?: string;
  sourceTitle?: string;
}

async function exportHighlight(
  entry: ReturnType<typeof highlightEntriesFromLabel>[number]
): Promise<PendingHighlight | null> {
  let record: ArchiveRecord['record'];
  try {
    ({ record } = await highlightToRecord(entry));
  } catch {
    return null; // no string id: the frontend can't hold one either
  }
  const selector = record.selector as { exact?: string } | undefined;
  let text = typeof selector?.exact === 'string' ? selector.exact : undefined;
  if (text === undefined) {
    const raw = entry.highlight.selector as { exact?: unknown } | undefined;
    if (typeof raw?.exact === 'string') text = raw.exact.toWellFormed();
  }
  const note = stringField(record, 'note');
  if (!text?.trim() && !note?.trim()) return null;
  const createdAt = stringField(record, 'createdAt');
  const id = entry.highlight.id as string;
  return {
    id,
    // A createdAt that rode in extra can be any string; NaN would break the sort.
    createdAt: (createdAt && Date.parse(createdAt)) || 0,
    entry: {
      id,
      text: text ?? '',
      ...(note?.trim() ? { note } : {}),
      ...(createdAt ? { createdAt } : {}),
    },
    sourceUrl: stringField(record, 'sourceUrl'),
    sourceTitle: stringField(record, 'sourceTitle'),
  };
}

const byCreated = (a: PendingHighlight, b: PendingHighlight) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isWebUrl = (value: string | null | undefined): value is string =>
  !!value && /^https?:\/\//i.test(value);

export interface CollectOptions {
  /**
   * Only pages whose highlights changed at or after this time (unix seconds,
   * the label rows' `updated_at`), each with all of its highlights, including
   * pages whose last highlight was just deleted (with none). Saves nobody
   * highlighted are left out, unless `collections` asks for them. For a sync
   * that keeps a copy up to date (services/zotero.ts) rather than a
   * whole-library download.
   */
  since?: number;
  /**
   * Only the saves in these Shelf collections, every one of them, highlighted
   * or not. Pages highlighted without a save are left out. With `since`, a
   * save added to one of them since then counts as changed.
   */
  collections?: string[];
  /**
   * With `since`, also every save made since then, highlighted or not: for a
   * reference manager, where a save is a reference on its own.
   */
  everySave?: boolean;
}

const SAVE_COLUMNS = `id, rkey, record_uri, url, url_normalized, url_key, title, author, description,
              NULL AS content, content_type, domain, image, word_count, published_at,
              saved_at, created_at, updated_at, source, item_guid, doi, edited_fields,
              imported_from,
              CASE WHEN content_type = 'pdf' THEN substr(content, 1, ?) END AS first_page_html`;

const LABEL_COLUMNS = 'id, item_key, item_type, props, deleted_at, updated_at';

// Rows arrive oldest first, so a newer alias row's copy of a highlight wins.
const byUpdated = (a: HighlightLabelRow, b: HighlightLabelRow) =>
  a.updated_at - b.updated_at || a.id - b.id;

const marks = (items: unknown[]) => items.map(() => '?').join(',');

/**
 * The saves filed under `keys` (a highlight's item key: a guid or a save's
 * record uri) or with an rkey in `rkeys`, and every live highlight row for
 * all of their keys, so each page comes back whole, not just the alias row
 * that changed.
 */
async function rowsFor(env: Env, did: string, keys: string[], rkeys: string[]) {
  const saves = new Map<number, SaveRowWithHead>();
  for (const batch of chunk(keys, IN_CHUNK / 2)) {
    const rows = await env.DB.prepare(
      `SELECT ${SAVE_COLUMNS} FROM saved_articles
        WHERE user_did = ? AND (item_guid IN (${marks(batch)}) OR record_uri IN (${marks(batch)}))`
    )
      .bind(FIRST_PAGE_HTML_CHARS, did, ...batch, ...batch)
      .all<SaveRowWithHead>();
    for (const row of rows.results ?? []) saves.set(row.id, row);
  }
  for (const batch of chunk(rkeys, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT ${SAVE_COLUMNS} FROM saved_articles WHERE user_did = ? AND rkey IN (${marks(batch)})`
    )
      .bind(FIRST_PAGE_HTML_CHARS, did, ...batch)
      .all<SaveRowWithHead>();
    for (const row of rows.results ?? []) saves.set(row.id, row);
  }
  const saveRows = [...saves.values()].sort((a, b) => b.saved_at - a.saved_at || b.id - a.id);

  // A `saved:<rkey>` row whose save is gone still holds that page's highlights.
  const labelKeys = new Set([...keys, ...rkeys.map((rkey) => `saved:${rkey}`)]);
  for (const row of saveRows) {
    for (const key of [row.item_guid, row.record_uri, `saved:${row.rkey}`]) {
      if (key) labelKeys.add(key);
    }
  }
  const labels: HighlightLabelRow[] = [];
  for (const batch of chunk([...labelKeys], IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT ${LABEL_COLUMNS} FROM item_labels_cache
        WHERE user_did = ? AND label = 'highlights' AND deleted_at IS NULL
          AND item_key IN (${marks(batch)})`
    )
      .bind(did, ...batch)
      .all<HighlightLabelRow>();
    labels.push(...(rows.results ?? []));
  }
  labels.sort(byUpdated);

  const fileRows = await env.DB.prepare(
    'SELECT rkey, r2_key, filename, mime_type, size, sha256, created_at FROM saved_files WHERE user_did = ?'
  )
    .bind(did)
    .all<SavedFileRow & { rkey: string }>();
  return { saveRows, labels, fileRows: fileRows.results ?? [] };
}

async function allRows(env: Env, did: string) {
  // `content` stays NULL: the export carries no bodies, and a PDF's first page
  // (for its identifiers) is read as a prefix rather than the whole book.
  const [savesResult, filesResult, labelsResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${SAVE_COLUMNS} FROM saved_articles WHERE user_did = ?
        ORDER BY saved_at DESC, id DESC`
    ).bind(FIRST_PAGE_HTML_CHARS, did),
    env.DB.prepare(
      `SELECT rkey, r2_key, filename, mime_type, size, sha256, created_at
         FROM saved_files WHERE user_did = ?`
    ).bind(did),
    env.DB.prepare(
      `SELECT ${LABEL_COLUMNS} FROM item_labels_cache
        WHERE user_did = ? AND label = 'highlights' AND deleted_at IS NULL
        ORDER BY updated_at ASC, id ASC`
    ).bind(did),
  ]);
  return {
    saveRows: (savesResult.results ?? []) as SaveRowWithHead[],
    labels: (labelsResult.results ?? []) as HighlightLabelRow[],
    fileRows: (filesResult.results ?? []) as (SavedFileRow & { rkey: string })[],
  };
}

/** The saves in these Shelf collections, by rkey, with when each was added (unix seconds). */
async function collectionMembers(env: Env, did: string, ids: string[]) {
  const members = new Map<string, number>();
  for (const batch of chunk(ids, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT saved_rkey, MAX(added_at) AS added_at FROM shelf_collection_items
        WHERE user_did = ? AND collection_id IN (${marks(batch)}) GROUP BY saved_rkey`
    )
      .bind(did, ...batch)
      .all<{ saved_rkey: string; added_at: number }>();
    for (const row of rows.results ?? []) {
      members.set(row.saved_rkey, Math.max(row.added_at, members.get(row.saved_rkey) ?? 0));
    }
  }
  return members;
}

/**
 * Every save on the reader's Saved list, newest first (a backed collection's
 * members with no save time last), then every other page
 * they highlighted, most recently highlighted first. Each carries its
 * highlights (with notes) in reading order and any DOI or arXiv id.
 * `options` narrows that to what changed, or to some Shelf collections.
 */
export async function collectExport(
  env: Env,
  did: string,
  options: CollectOptions = {}
): Promise<ExportDocument> {
  const exportedAt = new Date().toISOString();
  let skipped = 0;
  const { since, collections } = options;

  // What changed: the keys whose highlights did, and the saves added to a
  // chosen collection. Null when everything is asked for.
  let touched: Set<string> | null = null;
  const settings = await getUserSettings(env, did);
  const backed = settings.backing.provider !== 'skyreader';
  const members = collections ? await collectionMembers(env, did, collections) : null;
  let rows;
  if (since !== undefined) {
    const changed = await env.DB.prepare(
      `SELECT DISTINCT item_key FROM item_labels_cache
        WHERE user_did = ? AND label = 'highlights' AND updated_at >= ?`
    )
      .bind(did, since)
      .all<{ item_key: string }>();
    touched = new Set((changed.results ?? []).map((r) => r.item_key));
    for (const [rkey, addedAt] of members ?? []) {
      if (addedAt >= since) touched.add(`saved:${rkey}`);
    }
    if (options.everySave && !members) {
      // saved_articles times are ms; label times are seconds.
      const made = await env.DB.prepare(
        'SELECT rkey FROM saved_articles WHERE user_did = ? AND created_at >= ?'
      )
        .bind(did, since * 1000)
        .all<{ rkey: string }>();
      for (const row of made.results ?? []) touched.add(`saved:${row.rkey}`);
    }
    const keys = [...touched];
    // From the start, everything has changed: three statements, not one per
    // key. With a backed list, highlights are filed under the foreign item's
    // uri, which no column here holds, so the changed keys can't pick the saves.
    rows =
      (since <= 0 && !members) || backed
        ? await allRows(env, did)
        : await rowsFor(
            env,
            did,
            keys.filter((k) => !k.startsWith('saved:')),
            keys.flatMap((k) => (k.startsWith('saved:') ? [k.slice('saved:'.length)] : []))
          );
  } else if (members) {
    rows = await rowsFor(env, did, [], [...members.keys()]);
  } else {
    rows = await allRows(env, did);
  }
  const { labels, fileRows } = rows;
  const saveRows = members ? rows.saveRows.filter((r) => members.has(r.rkey)) : rows.saveRows;
  const files = new Map(fileRows.map(({ rkey, ...file }) => [rkey, file]));

  // With Semble or Margin backing, the Saved list is the collection, and a row
  // whose item left it is enrichment, not a save. Members with no row here
  // (added in the other app) are on the list too. A backed save has no
  // record_uri, so the client files its highlights under the foreign item's
  // uri (or its guid): the view's `uri` and `itemGuid` are its keys.
  let views: SavedArticleView[] | null = null;
  if (settings.backing.provider !== 'skyreader') {
    views = await listBackedSaved(env, did, settings.backing);
  }
  const viewByRkey = new Map(views?.flatMap((v) => (v.rkey ? [[v.rkey, v] as const] : [])));

  // Each save under every key its highlights can be filed under.
  const saves: { source: ExportSource; listed: boolean }[] = [];
  const saveByKey = new Map<string, number>();
  const addSave = (source: ExportSource, listed: boolean, keys: (string | null | undefined)[]) => {
    const index = saves.length;
    const known = [...new Set(keys.filter((k): k is string => !!k))];
    source.id = known[0];
    source.keys = known;
    saves.push({ source, listed });
    for (const key of known) if (!saveByKey.has(key)) saveByKey.set(key, index);
  };
  for (const row of saveRows) {
    const { id: _id, first_page_html, ...saveRow } = row;
    let record: ArchiveRecord;
    try {
      record = saveToRecord(saveRow, files.get(row.rkey) ?? null);
    } catch (err) {
      skipped++;
      log.warn('export_save_unreadable', { rkey: row.rkey, error: String(err) });
      continue;
    }
    const view = viewByRkey.get(row.rkey);
    // `saved:<rkey>` first: it's the save's id, whichever key it's highlighted under.
    addSave(sourceFromSaveRecord(record, first_page_html), !views || !!view, [
      `saved:${row.rkey}`,
      row.item_guid,
      row.record_uri,
      view?.uri,
      view?.itemGuid,
    ]);
  }
  for (const view of views ?? []) {
    // A Shelf collection holds only rows; a member added in the other app isn't in one.
    if (view.rkey || members) continue;
    // No row means no save time: the view's savedAt is a stand-in for "now".
    addSave(
      {
        kind: 'save',
        title: view.title ?? undefined,
        url: view.url || undefined,
        author: view.author ?? undefined,
        domain: view.domain ?? undefined,
        publishedAt: view.publishedAt ?? undefined,
        contentType: view.contentType,
        ...idsFromUrl(view.url),
        highlights: [],
      },
      true,
      [view.uri, view.itemGuid]
    );
  }

  // Highlights, merged by id across a save's alias rows the way the client
  // merges them: rows arrive oldest first, so a newer row's copy wins.
  const highlightsBySave = new Map<number, Map<string, PendingHighlight>>();
  const highlightsByKey = new Map<string, Map<string, PendingHighlight>>();
  for (const row of labels) {
    const saveIndex = saveByKey.get(row.item_key);
    // Asked for some collections: a page outside them stays out.
    if (saveIndex === undefined && members) continue;
    let target: Map<string, PendingHighlight>;
    if (saveIndex !== undefined) {
      target = highlightsBySave.get(saveIndex) ?? new Map();
      highlightsBySave.set(saveIndex, target);
    } else {
      target = highlightsByKey.get(row.item_key) ?? new Map();
      highlightsByKey.set(row.item_key, target);
    }
    for (const entry of highlightEntriesFromLabel(row)) {
      const highlight = await exportHighlight(entry);
      if (highlight) target.set(highlight.id, highlight);
    }
  }

  const sources: ExportSource[] = [];
  const highlightedPages: { source: ExportSource; latest: number }[] = [];
  saves.forEach(({ source, listed }, index) => {
    const highlights = [...(highlightsBySave.get(index)?.values() ?? [])].sort(byCreated);
    source.highlights = highlights.map((h) => h.entry);
    // A sync asked only for what changed.
    if (touched && !source.keys?.some((key) => touched.has(key))) return;
    if (listed) sources.push(source);
    // A save no longer on a backed list keeps its highlights, as a highlighted page.
    else if (highlights.length > 0) {
      highlightedPages.push({
        source: { ...source, kind: 'highlighted', savedAt: undefined },
        latest: Math.max(...highlights.map((h) => h.createdAt)),
      });
    }
  });

  // Pages highlighted but not saved: named by the source fields stamped on
  // their highlights, else by the read label the page left, else by the key
  // itself when it's a URL (a feed item's guid often is).
  const readProps = await readLabelProps(
    env,
    did,
    [...highlightsByKey].filter(([, h]) => h.size > 0).map(([key]) => key)
  );
  for (const [key, byId] of highlightsByKey) {
    const highlights = [...byId.values()].sort(byCreated);
    if (highlights.length === 0) continue;
    const read = readProps.get(key);
    const url =
      highlights.find((h) => isWebUrl(h.sourceUrl))?.sourceUrl ??
      (isWebUrl(read?.itemUrl) ? read?.itemUrl : undefined) ??
      (isWebUrl(key) ? key : undefined);
    const title =
      highlights.find((h) => h.sourceTitle?.trim())?.sourceTitle ?? read?.itemTitle ?? undefined;
    highlightedPages.push({
      source: {
        kind: 'highlighted',
        id: key,
        keys: [key],
        title: title || undefined,
        url,
        ...(url ? idsFromUrl(url) : {}),
        highlights: highlights.map((h) => h.entry),
      },
      latest: Math.max(...highlights.map((h) => h.createdAt)),
    });
  }
  // A changed page with no save, whose highlights were all deleted.
  for (const key of touched ?? []) {
    if (members || saveByKey.has(key) || highlightsByKey.get(key)?.size) continue;
    highlightedPages.push({
      source: { kind: 'highlighted', id: key, keys: [key], highlights: [] },
      latest: 0,
    });
  }
  highlightedPages.sort((a, b) => b.latest - a.latest);
  sources.push(...highlightedPages.map((p) => p.source));

  return { sources, exportedAt, skipped };
}

interface ReadProps {
  itemUrl?: string | null;
  itemTitle?: string | null;
}

async function readLabelProps(
  env: Env,
  did: string,
  keys: string[]
): Promise<Map<string, ReadProps>> {
  const found = new Map<string, ReadProps>();
  for (const batch of chunk(keys, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      `SELECT item_key, props FROM item_labels_cache
        WHERE user_did = ? AND label = 'read' AND deleted_at IS NULL
          AND item_key IN (${batch.map(() => '?').join(',')})`
    )
      .bind(did, ...batch)
      .all<{ item_key: string; props: string | null }>();
    for (const row of rows.results ?? []) {
      try {
        const props = JSON.parse(row.props ?? 'null') as ReadProps | null;
        if (props && typeof props === 'object') found.set(row.item_key, props);
      } catch {
        // a read label without props names nothing
      }
    }
  }
  return found;
}
