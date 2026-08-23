/**
 * Mapping between a `saved_articles` row and an `app.skyreader.feed.saved`
 * record in the user's saved space, plus the diff used by the dev read-back
 * route. Pure functions, no I/O — unit-tested in `test/spaces-record.spec.ts`.
 */

import { SAVED_COLLECTION } from './refs';

/** The subset of `saved_articles` the space record is built from. */
export interface SavedRowForSpace {
  rkey: string;
  url: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  content_type: string | null;
  domain: string | null;
  image: string | null;
  word_count: number | null;
  published_at: number | null;
  saved_at: number;
  source: string | null;
  item_guid: string | null;
}

export interface SavedSpaceRecord {
  $type: typeof SAVED_COLLECTION;
  url?: string;
  title?: string;
  author?: string;
  description?: string;
  contentType?: string;
  domain?: string;
  image?: string;
  wordCount?: number;
  publishedAt?: string;
  savedAt: string;
  source?: string;
  itemGuid?: string;
}

/** D1 stores epoch ms; records want ISO datetimes. Junk timestamps are dropped. */
function toIso(epochMs: number | null | undefined): string | undefined {
  if (epochMs === null || epochMs === undefined) return undefined;
  if (!Number.isFinite(epochMs)) return undefined;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** Empty strings are as absent as nulls, and an absent field is left off entirely. */
function text(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Build the space record for a saved row.
 *
 * Metadata only, by design: `content` is never read here. The extracted article
 * body stays in D1 — the same content split the (now removed) public-repo export
 * observed, and the thing that keeps a record inside sane size limits.
 */
export function savedRowToSpaceRecord(row: SavedRowForSpace): SavedSpaceRecord {
  const record: SavedSpaceRecord = {
    $type: SAVED_COLLECTION,
    // A row always has saved_at; fall back to "now" rather than emitting an
    // invalid record if a legacy row somehow carries a bad timestamp.
    savedAt: toIso(row.saved_at) ?? new Date().toISOString(),
  };

  const url = text(row.url, 2048);
  if (url) record.url = url;
  const title = text(row.title, 1024);
  if (title) record.title = title;
  const author = text(row.author, 512);
  if (author) record.author = author;
  const description = text(row.description, 2048);
  if (description) record.description = description;
  const contentType = text(row.content_type, 64);
  if (contentType) record.contentType = contentType;
  const domain = text(row.domain, 512);
  if (domain) record.domain = domain;
  const image = text(row.image, 2048);
  if (image) record.image = image;
  const source = text(row.source, 64);
  if (source) record.source = source;
  const itemGuid = text(row.item_guid, 2048);
  if (itemGuid) record.itemGuid = itemGuid;

  if (
    typeof row.word_count === 'number' &&
    Number.isFinite(row.word_count) &&
    row.word_count >= 0
  ) {
    record.wordCount = Math.round(row.word_count);
  }

  const publishedAt = toIso(row.published_at);
  if (publishedAt) record.publishedAt = publishedAt;

  return record;
}

export interface SavedDiff {
  /** rkeys present in D1 with no record in the space. */
  onlyInD1: string[];
  /** rkeys present in the space with no D1 row (a stale mirror). */
  onlyInSpace: string[];
  /** rkeys present in both whose field values disagree. */
  mismatched: Array<{ rkey: string; field: string; d1: unknown; space: unknown }>;
}

/**
 * The spike's truth meter: does the mirror actually reflect D1?
 *
 * Only the fields the mapping produces are compared, and only for rkeys present
 * on both sides — a field the space record carries but the mapping never emits
 * would be someone else's write, which is out of scope for a drift check.
 */
export function diffSavedRecords(
  rows: SavedRowForSpace[],
  spaceRecords: Array<{ rkey: string; value: Record<string, unknown> }>
): SavedDiff {
  const spaceByRkey = new Map(spaceRecords.map((r) => [r.rkey, r.value]));
  const diff: SavedDiff = { onlyInD1: [], onlyInSpace: [], mismatched: [] };

  for (const row of rows) {
    const remote = spaceByRkey.get(row.rkey);
    if (!remote) {
      diff.onlyInD1.push(row.rkey);
      continue;
    }
    const expected = savedRowToSpaceRecord(row) as unknown as Record<string, unknown>;
    for (const field of Object.keys(expected)) {
      if (expected[field] !== remote[field]) {
        diff.mismatched.push({ rkey: row.rkey, field, d1: expected[field], space: remote[field] });
      }
    }
  }

  const d1Rkeys = new Set(rows.map((r) => r.rkey));
  for (const record of spaceRecords) {
    if (!d1Rkeys.has(record.rkey)) diff.onlyInSpace.push(record.rkey);
  }

  return diff;
}
