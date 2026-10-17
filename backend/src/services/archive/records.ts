// D1 rows as the atproto records they will become.
//
// Saves and highlights live in D1 today. When atproto spaces arrive they move to
// the reader's own (private) space, and D1 stays the cache, plus the fallback for
// a PDS without spaces. Moving them is then a sync job, not a migration, provided
// every row already has a record key and a record shape that maps back to the row
// exactly. This module is that mapping; docs/plans/ARCHIVE_RECORDS.md is the design.
//
// Lossless is the contract: fromRecord(toRecord(row)) deep-equals row for every
// row D1 can hold. A value the record shape can't carry natively (a float where
// an integer belongs, a timestamp outside the datetime range, an unknown key on a
// highlight) rides verbatim in `extra`, a JSON string, rather than being dropped.
//
// Decoding is the exact inverse and nothing more: it accepts only records toRecord
// could have produced, so re-encoding a decoded record yields the same record (and
// CID), and a record can't smuggle a key or column the shape doesn't have.
//
// Notes are not a record of their own: a note is a highlight's `note`, as on
// Margin's at.margin.note. Snapshots have no rows yet; their shape is in the plan.

import type { CborValue } from './dag-cbor';
import { sha256Hex } from '../linked-originals';

export const SAVE_COLLECTION = 'app.skyreader.archive.save';
export const HIGHLIGHT_COLLECTION = 'app.skyreader.archive.highlight';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordObject = { [key: string]: CborValue | undefined };

// atproto record-key syntax (https://atproto.com/specs/record-key).
const RKEY_REGEX = /^[A-Za-z0-9._:~-]{1,512}$/;

export function isRecordKey(value: unknown): value is string {
  return typeof value === 'string' && RKEY_REGEX.test(value) && value !== '.' && value !== '..';
}

// The atproto datetime range: year 0000 through 9999, which toISOString renders
// as a plain four-digit year that Date.parse reads back to the same millisecond.
const MAX_DATETIME_MS = 253402300799999;

function msToDatetime(value: unknown): string | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_DATETIME_MS
    ? new Date(value as number).toISOString()
    : undefined;
}

// Only the form msToDatetime writes: anything else Date.parse accepts (no offset,
// an expanded year, a non-ISO date) would re-encode to a different string.
function datetimeToMs(value: unknown, field: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (msToDatetime(ms) !== value) throw new TypeError(`archive record: ${field} is not a datetime`);
  return ms;
}

type FieldKind = 'string' | 'int' | 'datetime';

function encodeValue(kind: FieldKind, value: unknown): CborValue | undefined {
  switch (kind) {
    case 'string':
      // A lone surrogate has no UTF-8 form; JSON.stringify escapes it, so it rides in extra.
      return typeof value === 'string' && value.isWellFormed() ? value : undefined;
    case 'int':
      return Number.isSafeInteger(value) ? (value as number) : undefined;
    case 'datetime':
      return msToDatetime(value);
  }
}

function decodeValue(kind: FieldKind, value: unknown, field: string): Json {
  switch (kind) {
    case 'string':
      if (typeof value !== 'string' || !value.isWellFormed())
        throw new TypeError(`archive record: ${field} is not a string`);
      return value;
    case 'int':
      if (!Number.isSafeInteger(value))
        throw new TypeError(`archive record: ${field} is not an integer`);
      return value as number;
    case 'datetime':
      return datetimeToMs(value, field);
  }
}

function parseExtra(record: RecordObject): Record<string, Json> {
  if (record.extra === undefined) return {};
  if (typeof record.extra !== 'string')
    throw new TypeError('archive record: extra is not a string');
  const parsed = JSON.parse(record.extra) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('archive record: extra is not an object');
  }
  // toRecord never writes an empty extra, so one isn't a record it produced.
  if (Object.keys(parsed).length === 0) throw new TypeError('archive record: extra is empty');
  return parsed as Record<string, Json>;
}

// Plain assignment of a `__proto__` key (an own key JSON.parse can produce) would
// set the object's prototype instead of the field.
function setField(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function assertKnownKeys(record: RecordObject, known: Set<string>, what: string): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new TypeError(`archive record: unknown ${what} field ${key}`);
  }
}

function assertType(record: RecordObject, type: string): void {
  if (record.$type !== type) throw new TypeError(`archive record: expected $type ${type}`);
}

// ─── Saves ────────────────────────────────────────────────────────────────────

/** A saved_articles row, less the two columns that are D1's own: `id` and `user_did` (the repo). */
export interface SaveRow {
  rkey: string;
  record_uri: string | null;
  url: string;
  url_normalized: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  content_type: string | null;
  domain: string | null;
  image: string | null;
  word_count: number | null;
  published_at: number | null;
  saved_at: number;
  created_at: number;
  updated_at: number | null;
  source: string;
  item_guid: string | null;
}

/** The saved_files row behind an uploaded or kept-original save, less `user_did` and `rkey`. */
export interface SavedFileRow {
  r2_key: string;
  filename: string | null;
  mime_type: string;
  size: number;
  sha256: string;
  created_at: number;
}

// Column → record field. A NULL column is an absent field; a NOT NULL column
// (`required`) is always present, in its field or in `extra` when it can't be
// carried natively.
type ColumnSpec<Row> = [column: keyof Row, field: string, kind: FieldKind, required?: 'required'];

const SAVE_FIELDS: ColumnSpec<Omit<SaveRow, 'rkey'>>[] = [
  ['record_uri', 'legacyUri', 'string'],
  ['url', 'url', 'string', 'required'],
  ['url_normalized', 'urlNormalized', 'string'],
  ['title', 'title', 'string'],
  ['author', 'author', 'string'],
  ['description', 'description', 'string'],
  ['content', 'content', 'string'],
  ['content_type', 'contentType', 'string'],
  ['domain', 'domain', 'string'],
  ['image', 'image', 'string'],
  ['word_count', 'wordCount', 'int'],
  ['published_at', 'publishedAt', 'datetime'],
  ['saved_at', 'savedAt', 'datetime', 'required'],
  ['created_at', 'createdAt', 'datetime', 'required'],
  ['updated_at', 'updatedAt', 'datetime'],
  ['source', 'source', 'string', 'required'],
  ['item_guid', 'itemGuid', 'string'],
];

const FILE_FIELDS: ColumnSpec<SavedFileRow>[] = [
  ['r2_key', 'r2Key', 'string', 'required'],
  ['filename', 'filename', 'string'],
  ['mime_type', 'mimeType', 'string', 'required'],
  ['size', 'size', 'int', 'required'],
  ['sha256', 'sha256', 'string', 'required'],
  ['created_at', 'createdAt', 'datetime', 'required'],
];

const SAVE_RECORD_KEYS = new Set(['$type', 'extra', 'file', ...SAVE_FIELDS.map((f) => f[1])]);
const FILE_RECORD_KEYS = new Set(['extra', ...FILE_FIELDS.map((f) => f[1])]);

function encodeColumns<Row extends object>(
  row: Row,
  fields: ColumnSpec<Row>[],
  out: RecordObject,
  extra: Record<string, unknown>
): void {
  for (const [column, field, kind, required] of fields) {
    const value = row[column];
    // A column the caller didn't select is a bug, not a NULL: guessing would change the CID.
    if (value === undefined) throw new TypeError(`archive row: missing column ${String(column)}`);
    if (value === null) {
      if (required) throw new TypeError(`archive row: ${String(column)} is null`);
      continue;
    }
    const encoded = encodeValue(kind, value);
    if (encoded === undefined) extra[column as string] = value;
    else out[field] = encoded;
  }
}

function decodeColumns<Row extends object>(
  record: RecordObject,
  fields: ColumnSpec<Row>[],
  extra: Record<string, Json>
): Row {
  const row: Record<string, Json> = {};
  for (const [column, field, kind] of fields) {
    const value = record[field];
    row[column as string] = value === undefined ? null : decodeValue(kind, value, field);
  }
  // Only a column toRecord would have put there: a known one, absent from the
  // record proper, holding a value its field can't carry.
  const columns = new Map(
    fields.map(([column, field, kind]) => [column as string, { field, kind }])
  );
  for (const [column, value] of Object.entries(extra)) {
    const spec = columns.get(column);
    if (!spec) throw new TypeError(`archive record: extra has unknown column ${column}`);
    if (
      record[spec.field] !== undefined ||
      value === null ||
      encodeValue(spec.kind, value) !== undefined
    ) {
      throw new TypeError(`archive record: extra.${column} belongs in ${spec.field}`);
    }
    row[column] = value;
  }
  for (const [column, field, , required] of fields) {
    if (required && row[column as string] === null) {
      throw new TypeError(`archive record: ${field} is missing`);
    }
  }
  return row as Row;
}

export interface SaveRecord {
  rkey: string;
  record: RecordObject;
}

export function saveToRecord(row: SaveRow, file?: SavedFileRow | null): SaveRecord {
  if (!isRecordKey(row.rkey)) throw new TypeError(`save rkey ${row.rkey} is not a record key`);
  const record: RecordObject = { $type: SAVE_COLLECTION };
  const extra: Record<string, unknown> = {};
  encodeColumns(row, SAVE_FIELDS, record, extra);
  if (file) {
    const fileRecord: RecordObject = {};
    const fileExtra: Record<string, unknown> = {};
    encodeColumns(file, FILE_FIELDS, fileRecord, fileExtra);
    if (Object.keys(fileExtra).length > 0) fileRecord.extra = JSON.stringify(fileExtra);
    record.file = fileRecord;
  }
  if (Object.keys(extra).length > 0) record.extra = JSON.stringify(extra);
  return { rkey: row.rkey, record };
}

export function saveFromRecord(
  rkey: string,
  record: RecordObject
): { row: SaveRow; file: SavedFileRow | null } {
  assertType(record, SAVE_COLLECTION);
  if (!isRecordKey(rkey)) throw new TypeError(`save rkey ${rkey} is not a record key`);
  assertKnownKeys(record, SAVE_RECORD_KEYS, 'save');
  const row: SaveRow = {
    ...decodeColumns(record, SAVE_FIELDS, parseExtra(record)),
    rkey,
  };
  let file: SavedFileRow | null = null;
  if (record.file !== undefined) {
    if (typeof record.file !== 'object' || record.file === null || Array.isArray(record.file)) {
      throw new TypeError('archive record: file is not an object');
    }
    const fileRecord = record.file as RecordObject;
    assertKnownKeys(fileRecord, FILE_RECORD_KEYS, 'file');
    file = decodeColumns(fileRecord, FILE_FIELDS, parseExtra(fileRecord));
  }
  return { row, file };
}

// ─── Highlights (and their notes) ─────────────────────────────────────────────

/**
 * One highlight as D1 holds it: an element of a `highlights` label's
 * `props.highlights` array, on the item that label row is keyed by. The element
 * is opaque JSON the frontend owns (frontend/src/lib/types `Highlight`).
 */
export interface HighlightEntry {
  itemKey: string;
  itemType: string;
  highlight: { [key: string]: Json };
}

// Keys the record carries natively. Anything else, or a known key whose value
// isn't the expected kind, rides in `extra`, so a field the frontend adds later
// survives without a change here.
const HIGHLIGHT_FIELDS = new Map<string, FieldKind>([
  ['id', 'string'],
  ['createdAt', 'datetime'],
  ['note', 'string'],
  ['marginUri', 'string'],
  ['marginRkey', 'string'],
  ['lastReviewedAt', 'datetime'],
  ['reviewIntent', 'string'],
  ['sourceUrl', 'string'],
  ['sourceTitle', 'string'],
]);

// What highlightToRecord puts in the record proper for `key`, or undefined when
// the value rides in extra instead.
function encodeHighlightField(key: string, value: unknown): CborValue | undefined {
  if (key === 'selector') return isPlainSelector(value) ? { ...value } : undefined;
  const kind = HIGHLIGHT_FIELDS.get(key);
  return kind ? encodeValue(kind, value) : undefined;
}

const SELECTOR_KEYS = new Set(['type', 'exact', 'prefix', 'suffix']);

function isPlainSelector(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, item]) => SELECTOR_KEYS.has(key) && typeof item === 'string' && item.isWellFormed()
    )
  );
}

/**
 * A highlight's record key: its id, which is already one for every highlight
 * Skyreader mints (base36) or imports from Margin (`margin:<rkey>`). An id that
 * isn't gets a key derived from it, so the key is still stable across devices and
 * syncs. The record always carries the id itself, so nothing depends on which.
 */
export async function highlightRkey(id: string): Promise<string> {
  if (isRecordKey(id)) return id;
  return 'h-' + (await sha256Hex(new TextEncoder().encode(id))).slice(0, 32);
}

export interface HighlightRecord {
  rkey: string;
  record: RecordObject;
}

export async function highlightToRecord(entry: HighlightEntry): Promise<HighlightRecord> {
  const { highlight } = entry;
  if (typeof highlight.id !== 'string' || !highlight.id) {
    throw new TypeError('highlight has no string id');
  }
  const record: RecordObject = {
    $type: HIGHLIGHT_COLLECTION,
    subject: { itemKey: entry.itemKey, itemType: entry.itemType },
  };
  const extra: Record<string, Json> = {};
  for (const [key, value] of Object.entries(highlight)) {
    const encoded = encodeHighlightField(key, value);
    if (encoded === undefined) setField(extra, key, value);
    else setField(record, key, encoded);
  }
  if (Object.keys(extra).length > 0) record.extra = JSON.stringify(extra);
  return { rkey: await highlightRkey(highlight.id), record };
}

export async function highlightFromRecord(
  rkey: string,
  record: RecordObject
): Promise<HighlightEntry> {
  assertType(record, HIGHLIGHT_COLLECTION);
  const subject = record.subject as RecordObject | undefined;
  if (
    typeof subject !== 'object' ||
    subject === null ||
    Array.isArray(subject) ||
    typeof subject.itemKey !== 'string' ||
    typeof subject.itemType !== 'string'
  ) {
    throw new TypeError('archive record: subject needs itemKey and itemType');
  }
  assertKnownKeys(subject, new Set(['itemKey', 'itemType']), 'subject');
  const highlight: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === '$type' || key === 'subject' || key === 'extra' || value === undefined) continue;
    if (key === 'selector') {
      if (!isPlainSelector(value)) throw new TypeError('archive record: selector is malformed');
      highlight.selector = { ...value };
      continue;
    }
    const kind = HIGHLIGHT_FIELDS.get(key);
    if (!kind) throw new TypeError(`archive record: unknown highlight field ${key}`);
    highlight[key] = decodeValue(kind, value, key);
  }
  // Only what highlightToRecord would have put there: a key absent from the
  // record proper whose value it couldn't carry natively.
  for (const [key, value] of Object.entries(parseExtra(record))) {
    if (Object.hasOwn(highlight, key) || encodeHighlightField(key, value) !== undefined) {
      throw new TypeError(`archive record: extra.${key} belongs in the record`);
    }
    setField(highlight, key, value);
  }
  if (typeof highlight.id !== 'string' || !highlight.id) {
    throw new TypeError('archive record: highlight has no id');
  }
  if (rkey !== (await highlightRkey(highlight.id))) {
    throw new TypeError(`archive record: highlight ${highlight.id} is not keyed ${rkey}`);
  }
  return { itemKey: subject.itemKey, itemType: subject.itemType, highlight };
}

/**
 * Every highlight in one `highlights` label row's props. A row whose props
 * aren't the expected shape yields nothing: there's no highlight in it to keep.
 */
export function highlightEntriesFromLabel(row: {
  item_key: string;
  item_type: string;
  props: string | null;
}): HighlightEntry[] {
  let props: unknown;
  try {
    props = row.props ? JSON.parse(row.props) : null;
  } catch {
    return [];
  }
  const highlights = (props as { highlights?: unknown } | null)?.highlights;
  if (!Array.isArray(highlights)) return [];
  return highlights
    .filter(
      (highlight): highlight is { [key: string]: Json } =>
        typeof highlight === 'object' && highlight !== null && !Array.isArray(highlight)
    )
    .map((highlight) => ({ itemKey: row.item_key, itemType: row.item_type, highlight }));
}
