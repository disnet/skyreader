# Archive records: D1 as a cache of future records

Saves, highlights and their notes live in D1. The plan is for them to live in the reader's own
**private atproto space**, with D1 as the cache in front of it and the fallback for a PDS that has
no spaces. This note covers the step that makes that move cheap. Every row gets a record key and a
record shape now, and the shape maps back to the row exactly. With that in place, moving the
source of truth is a sync job (write each row's record, compare CIDs) rather than a schema
migration.

The code is `backend/src/services/archive/` (`records.ts` for the mapping, `dag-cbor.ts` for the
content hash, `snapshots.ts` for capturing snapshots). `backend/test/archive-records.spec.ts` and
`backend/test/saved-snapshots.spec.ts` cover it.

## What this does not change

- **Saves are still not public PDS records.** The "saves live only in D1" stance (root
  `CLAUDE.md`) exists because PDS records are public. A space is private, so it removes that reason
  for space data only. Public `app.skyreader.feed.saved` records stay off.
- Nothing writes these records yet. That is the "Write private records and blobs to the user's
  space" goal, which builds on this.
- The NSIDs below are drafts. They get lexicon files (`lexicons/app/skyreader/archive/`) when
  something first writes them, not before, so nothing gets published that might still change.

## Collections

| Collection                        | One record per                                 | Record key                |
| --------------------------------- | ---------------------------------------------- | ------------------------- |
| `app.skyreader.archive.save`      | `saved_articles` row (+ its `saved_files` row) | the save's `rkey` (a TID) |
| `app.skyreader.archive.highlight` | element of a `highlights` label's props array  | the highlight's `id`      |
| `app.skyreader.archive.snapshot`  | `saved_snapshots` row (one capture of a body)  | the capture's own TID     |

**Notes are not a collection.** A note is a highlight's `note` field, as on Margin's
`at.margin.note`, where the note is the annotation's body. It moves with its highlight.

## Saves

The record carries every `saved_articles` column except D1's own `id` and `user_did`, which is the
repo the record lives in. The `rkey` is the record key, not a field.

| Column                                                 | Field                | Notes                                                    |
| ------------------------------------------------------ | -------------------- | -------------------------------------------------------- |
| `record_uri`                                           | `legacyUri`          | the old `app.skyreader.feed.saved` uri. Labels key on it |
| `url`                                                  | `url`                | `''` for an upload                                       |
| `url_normalized`                                       | `urlNormalized`      | the backed-save dedup key, NULL on most rows             |
| `title` … `image`                                      | same name, camelCase | strings                                                  |
| `word_count`                                           | `wordCount`          | integer                                                  |
| `published_at`, `saved_at`, `created_at`, `updated_at` | `…At`                | ms → datetime string                                     |
| `source`                                               | `source`             | `url` / `feed` / `document` / `upload`                   |
| `item_guid`                                            | `itemGuid`           |                                                          |
| `saved_files.*`                                        | `file`               | `{ r2Key, filename, mimeType, size, sha256, createdAt }` |

A NULL column is an absent field. `content` (the extracted body) rides inline for now. Before a
space write, a body over the record size limit has to become a blob, and that blob is the snapshot
(below). `file.r2Key` becomes a blob ref the same way. The converter is the one place either change
happens.

## Highlights

A highlight is an opaque JSON element in `item_labels_cache.props.highlights`, owned by the
frontend (`Highlight` in `frontend/src/lib/types`). Its record is:

```
{ $type, subject: { itemKey, itemType }, id, selector, createdAt, note?, marginUri?,
  marginRkey?, lastReviewedAt?, reviewIntent?, sourceUrl?, sourceTitle?, extra? }
```

`subject` is the label row's `item_key` and `item_type` (plus its own `extra` for one that isn't
well-formed text, as on a save's `file`). The record key is the highlight's `id`. Every id
Skyreader mints (`Date.now()` base36 + a random suffix) and every Margin import id
(`margin:<rkey>`) is already a valid record key. An id that isn't one gets
`h-<first 16 bytes of sha256(JSON.stringify(id)), hex>`. That key is deterministic, so every device
and every sync pass derives the same one; hashing the JSON form keeps two ids that differ only in a
lone surrogate apart. The record always carries `id`, so nothing depends on which form the key
took.

**Soft-deleted rows.** `DELETE /api/labels` sets `deleted_at` and keeps `props`, so a tombstoned
row still holds the highlights the reader deleted. `highlightEntriesFromLabel` takes `deleted_at`
and yields nothing for such a row; the sync job must select the column.

**Per highlight, not per row.** The mapping covers each highlight element, not the label row
around it. The row's `created_at` / `updated_at` / `client_updated_at` are D1 bookkeeping that the
labels write path stamps afresh, the array's order isn't carried (rebuild a row in a fixed order,
e.g. by `createdAt` then `id`), and `props` keys other than `highlights` aren't carried (the
merge upsert already rebuilds props as `{ highlights }` alone). A non-object array element has no
`id` to key a record by and is skipped; the frontend's merge can't hold one either.

**Alias rows.** One article can have highlight rows under more than one key (its guid and its save
uri, `utils/highlightAliases.ts`), and the client merges them by id. So the same id can appear in
two rows. The mapping is per element and doesn't dedupe. The sync job should collapse duplicates
with the client's rule before writing one record per id.

## Lossless round-trip

The contract is `fromRecord(toRecord(row))` deep-equals `row` for any row D1 can hold, and that
includes values the record shape can't carry natively:

- The atproto data model has no floats, and a datetime is limited to years 0000–9999.
- A string with a lone UTF-16 surrogate (text cut mid-emoji) has no UTF-8 form. `JSON.stringify`
  escapes it, so it rides in `extra`; the DAG-CBOR encoder refuses one rather than hashing it as
  U+FFFD.
- A highlight can carry keys a newer client added, or a `null` where a string belongs.

Any such value goes verbatim into `extra`, a JSON string, instead of being dropped or coerced.
`extra` is canonical JSON (every object's keys sorted), so the same content always gives the same
string and CID, whatever order its keys arrived in.
Decoding applies `extra` last. On real rows `extra` should almost never appear. It exists so the
mapping is total and the round-trip claim holds unconditionally. It also means a highlight field
the frontend adds later is preserved before this module learns about it.

Encoding throws in only these cases, none of them a row the app can address:

- a save whose `rkey` isn't a record key (every write path validates rkeys)
- a save row missing a column, or NULL in a NOT NULL one (a caller's query bug, not data)
- a highlight element with no string `id` (the frontend merges by id, and the merge path already
  refuses id-less elements)
- a non-finite number (`Infinity` in a REAL column): JSON has no form for it, so it can't ride in
  `extra`, and SQLite stores NaN as NULL anyway

Decoding is the exact inverse and accepts nothing else, so re-encoding a decoded record gives back
the same record and CID, and the CID-equality sync never churns. It rejects:

- an unknown field (on a save, its `file`, a highlight, or its `subject`): a field from a newer
  writer fails loudly rather than being dropped and written back without it
- a missing NOT NULL column (`url`, `savedAt`, `createdAt`, `source`; on a file, every column but
  `filename`)
- a datetime not in the exact form encoding writes (`toISOString`: millisecond precision, `Z`)
- an `extra` that isn't the canonical JSON encoding writes
- an `extra` key that encoding wouldn't have put there: an unknown column, a column also present
  natively, or a value its native field could carry. So `extra` can't set `rkey`, `id`,
  `user_did` or any other column the record shape doesn't have; the caller's `rkey` always wins.
- a highlight whose record key isn't the one its `id` derives

## Content hashes

`recordCid(record)` is the CIDv1 (dag-cbor, sha2-256, base32) a PDS would report for the record,
computed locally with `@ipld/dag-cbor` + `multiformats`, behind a check that the value fits the
atproto data model (no floats, no lone surrogates). The test pins bytes and CIDs, so a library
upgrade that changed either fails there rather than churning every record. The sync job's diff is CID equality: compare a row's CID with
the space record's CID, and write only on a mismatch. The hash is computed on demand, not stored.
A stored hash would need every write path (there are many) to keep it current, and computing one
is cheap.

## Snapshots

A snapshot is one capture of a save's body, kept as it was. `saved_articles.content` is the body
the reader reads, and a later capture can replace it (the extension's live-DOM upgrade of a paywall
stub); the snapshot of the earlier body stays. Every path that writes a body captures it
(`captureSnapshot`, under `waitUntil` so it never fails or slows the save): URL, feed and document
saves, the `updateContent` upgrade, backed saves, background extraction (`fillExtractedContent`)
and uploads. A body identical to the save's latest snapshot (same SHA-256) isn't stored again, and
the failed-fetch note (`data-skyreader-note="fetch-failed"`) is never a capture. A save keeps at most 20 captures (`MAX_SNAPSHOTS_PER_SAVE`): past that, a new one replaces the newest, so the first captures stay and the last always matches what the reader shows. Snapshots are
deleted with their save.

The row is `saved_snapshots (user_did, rkey, save_rkey, captured_at, url, content_type, sha256,
size, r2_key, method)`, keyed by its own TID, so a save holds several. The body is in R2
(`SAVED_FILES`, `snapshots/<did>/<save rkey>/<rkey>.html`), not inline. The record:

```
app.skyreader.archive.snapshot
{ $type, save: <save rkey>, capturedAt, url, contentType, sha256, size, r2Key, method? }
```

`r2Key` becomes a `body` blob ref at the space write, as a save's `file.r2Key` does.
`snapshotToRecord` / `snapshotFromRecord` follow the save mapping's rules. `method` says how the
body was captured: `live-dom` (the extension, from the open tab), `server` (Skyreader fetched the
page), `feed`, `record` (a standard.site document) or `upload`; absent when unknown. A client can
claim only `live-dom` or `server`.

`GET /api/saved/<rkey>/snapshots` lists a save's captures (no bodies), and the reader shows the
latest under the article ("Captured on …"). A save whose capture failed links to the Wayback
Machine's copy nearest its save time instead.

**Not captured yet:** images (a snapshot's body still points at the page's own image URLs) and
saves made before snapshots existed (no backfill: a body captured at an unknown time would claim a
capture time it doesn't have). A PDF's or EPUB's original is already kept in `saved_files`.

## Not yet verified against production

Rkey validity and id presence are enforced on every write path in the code. The Skyreader D1
database wasn't reachable from the session that wrote this, so production rows haven't been
checked yet. Before the sync job ships, run the mapping over every row once (counting throws and
rows that needed `extra`) and fix whatever turns up.
