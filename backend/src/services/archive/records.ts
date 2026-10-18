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
// Margin's at.margin.note. A snapshot is a record of its own, one per capture of a
// save's body (services/archive/snapshots.ts writes the rows).

import type { CborValue } from './dag-cbor';
import { sha256Hex } from '../../utils/sha256';

export const SAVE_COLLECTION = 'app.skyreader.archive.save';
export const HIGHLIGHT_COLLECTION = 'app.skyreader.archive.highlight';
export const SNAPSHOT_COLLECTION = 'app.skyreader.archive.snapshot';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordObject = { [key: string]: CborValue | undefined };

// atproto record-key syntax (https://atproto.com/specs/record-key).
const RKEY_REGEX = /^[A-Za-z0-9._:~-]{1,512}$/;

export function isRecordKey(value: unknown): value is string {
  return typeof value === 'string' && RKEY_REGEX.test(value) && value !== '.' && value !== '..';
}

// The atproto datetime range: year 0000 through 9999, which toISOString renders
// as a plain four-digit year that Date.parse reads back to the same millisecond.
const MIN_DATETIME_MS = -62167219200000;
const MAX_DATETIME_MS = 253402300799999;

function msToDatetime(value: unknown): string | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= MIN_DATETIME_MS &&
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

// JSON with every object's keys sorted, so the same content is always the same
// string (and the record the same CID) whatever order its keys arrived in. A
// non-finite number has no JSON form (JSON.stringify writes null, which wouldn't
// decode back), so it throws.
function canonicalJson(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`archive row: ${value} has no JSON form`);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}'
    );
  }
  return JSON.stringify(value);
}

function writeExtra(target: RecordObject, extra: object): void {
  if (Object.keys(extra).length > 0) target.extra = canonicalJson(extra);
}

function parseExtra(record: RecordObject): Record<string, Json> {
  if (record.extra === undefined) return {};
  if (typeof record.extra !== 'string')
    throw new TypeError('archive record: extra is not a string');
  const parsed = JSON.parse(record.extra) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('archive record: extra is not an object');
  }
  // toRecord never writes an empty or non-canonical extra, so neither is a record it produced.
  if (Object.keys(parsed).length === 0) throw new TypeError('archive record: extra is empty');
  if (canonicalJson(parsed) !== record.extra) {
    throw new TypeError('archive record: extra is not canonical JSON');
  }
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

export interface ArchiveRecord {
  rkey: string;
  record: RecordObject;
}

export function saveToRecord(row: SaveRow, file?: SavedFileRow | null): ArchiveRecord {
  if (!isRecordKey(row.rkey)) throw new TypeError(`save rkey ${row.rkey} is not a record key`);
  const record: RecordObject = { $type: SAVE_COLLECTION };
  const extra: Record<string, unknown> = {};
  encodeColumns(row, SAVE_FIELDS, record, extra);
  if (file) {
    const fileRecord: RecordObject = {};
    const fileExtra: Record<string, unknown> = {};
    encodeColumns(file, FILE_FIELDS, fileRecord, fileExtra);
    writeExtra(fileRecord, fileExtra);
    record.file = fileRecord;
  }
  writeExtra(record, extra);
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

// ─── Snapshots ────────────────────────────────────────────────────────────────

/** A saved_snapshots row, less `user_did`: one capture of a save's body. */
export interface SnapshotRow {
  rkey: string;
  save_rkey: string;
  captured_at: number;
  url: string;
  content_type: string;
  sha256: string;
  size: number;
  r2_key: string;
  method: string | null;
}

// `r2Key` becomes the record's `body` blob ref at the space write, as a save's
// `file.r2Key` does; this is the one place that changes.
const SNAPSHOT_FIELDS: ColumnSpec<Omit<SnapshotRow, 'rkey'>>[] = [
  ['save_rkey', 'save', 'string', 'required'],
  ['captured_at', 'capturedAt', 'datetime', 'required'],
  ['url', 'url', 'string', 'required'],
  ['content_type', 'contentType', 'string', 'required'],
  ['sha256', 'sha256', 'string', 'required'],
  ['size', 'size', 'int', 'required'],
  ['r2_key', 'r2Key', 'string', 'required'],
  ['method', 'method', 'string'],
];

const SNAPSHOT_RECORD_KEYS = new Set(['$type', 'extra', ...SNAPSHOT_FIELDS.map((f) => f[1])]);

export function snapshotToRecord(row: SnapshotRow): ArchiveRecord {
  if (!isRecordKey(row.rkey)) throw new TypeError(`snapshot rkey ${row.rkey} is not a record key`);
  const record: RecordObject = { $type: SNAPSHOT_COLLECTION };
  const extra: Record<string, unknown> = {};
  encodeColumns(row, SNAPSHOT_FIELDS, record, extra);
  writeExtra(record, extra);
  return { rkey: row.rkey, record };
}

export function snapshotFromRecord(rkey: string, record: RecordObject): SnapshotRow {
  assertType(record, SNAPSHOT_COLLECTION);
  if (!isRecordKey(rkey)) throw new TypeError(`snapshot rkey ${rkey} is not a record key`);
  assertKnownKeys(record, SNAPSHOT_RECORD_KEYS, 'snapshot');
  return { ...decodeColumns(record, SNAPSHOT_FIELDS, parseExtra(record)), rkey };
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
  // Hash the id's JSON form: it escapes a lone surrogate, where UTF-8 would turn
  // every one into U+FFFD and give two different ids the same key.
  return 'h-' + (await sha256Hex(new TextEncoder().encode(JSON.stringify(id)))).slice(0, 32);
}

const SUBJECT_FIELDS: ColumnSpec<Pick<HighlightEntry, 'itemKey' | 'itemType'>>[] = [
  ['itemKey', 'itemKey', 'string', 'required'],
  ['itemType', 'itemType', 'string', 'required'],
];
const SUBJECT_RECORD_KEYS = new Set(['extra', 'itemKey', 'itemType']);

export async function highlightToRecord(entry: HighlightEntry): Promise<ArchiveRecord> {
  const { highlight } = entry;
  if (typeof highlight.id !== 'string' || !highlight.id) {
    throw new TypeError('highlight has no string id');
  }
  // The subject is two columns, so it carries a string it can't hold natively (an
  // item key cut mid-emoji) in its own extra, as a save's file does.
  const subject: RecordObject = {};
  const subjectExtra: Record<string, unknown> = {};
  encodeColumns(entry, SUBJECT_FIELDS, subject, subjectExtra);
  writeExtra(subject, subjectExtra);
  const record: RecordObject = { $type: HIGHLIGHT_COLLECTION, subject };
  const extra: Record<string, Json> = {};
  for (const [key, value] of Object.entries(highlight)) {
    const encoded = encodeHighlightField(key, value);
    if (encoded === undefined) setField(extra, key, value);
    else setField(record, key, encoded);
  }
  writeExtra(record, extra);
  return { rkey: await highlightRkey(highlight.id), record };
}

export async function highlightFromRecord(
  rkey: string,
  record: RecordObject
): Promise<HighlightEntry> {
  assertType(record, HIGHLIGHT_COLLECTION);
  const subjectRecord = record.subject as RecordObject | undefined;
  if (typeof subjectRecord !== 'object' || subjectRecord === null || Array.isArray(subjectRecord)) {
    throw new TypeError('archive record: subject is not an object');
  }
  assertKnownKeys(subjectRecord, SUBJECT_RECORD_KEYS, 'subject');
  const subject = decodeColumns(subjectRecord, SUBJECT_FIELDS, parseExtra(subjectRecord));
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
 * Every highlight in one `highlights` label row's props. A soft-deleted row
 * (`deleted_at` set; DELETE /api/labels keeps its props) yields nothing, nor does
 * a row whose props aren't the expected shape: there's no highlight in it to keep.
 * The mapping is per highlight, not per row; see "Highlights" in the plan.
 */
export function highlightEntriesFromLabel(row: {
  item_key: string;
  item_type: string;
  props: string | null;
  deleted_at: number | null;
}): HighlightEntry[] {
  // Unselected is a caller's bug, not a live row: guessing would resurrect deletions.
  if (row.deleted_at === undefined) throw new TypeError('archive row: missing column deleted_at');
  if (row.deleted_at !== null) return [];
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
