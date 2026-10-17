# Archive records: D1 as a cache of future records

Saves, highlights and their notes live in D1. The plan is for them to live in the reader's own
**private atproto space**, with D1 as the cache in front of it and the fallback for a PDS that has
no spaces. This note covers the step that makes that move cheap. Every row gets a record key and a
record shape now, and the shape maps back to the row exactly. With that in place, moving the
source of truth is a sync job (write each row's record, compare CIDs) rather than a schema
migration.

The code is `backend/src/services/archive/` (`records.ts` for the mapping, `dag-cbor.ts` for the
content hash). `backend/test/archive-records.spec.ts` covers it.

## What this does not change

- **Saves are still not public PDS records.** The "saves live only in D1" stance (root
  `CLAUDE.md`) exists because PDS records are public. A space is private, so it removes that reason
  for space data only. Public `app.skyreader.feed.saved` records stay off.
- Nothing writes these records yet. That is the "Write private records and blobs to the user's
  space" goal, which builds on this.
- The NSIDs below are drafts. They get lexicon files (`lexicons/app/skyreader/archive/`) when
  something first writes them, not before, so nothing gets published that might still change.

## Collections

| Collection                        | One record per                                  | Record key                            |
| --------------------------------- | ----------------------------------------------- | ------------------------------------- |
| `app.skyreader.archive.save`      | `saved_articles` row (+ its `saved_files` row)  | the save's `rkey` (a TID)             |
| `app.skyreader.archive.highlight` | element of a `highlights` label's props array   | the highlight's `id`                  |
| `app.skyreader.archive.snapshot`  | captured snapshot (no rows yet; proposed below) | the save's `rkey`, plus a capture TID |

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

`subject` is the label row's `item_key` and `item_type`. The record key is the highlight's `id`.
Every id Skyreader mints (`Date.now()` base36 + a random suffix) and every Margin import id
(`margin:<rkey>`) is already a valid record key. An id that isn't one gets
`h-<first 16 bytes of sha256(id), hex>`. That key is deterministic, so every device and every sync
pass derives the same one. The record always carries `id`, so nothing depends on which form the
key took.

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
Decoding applies `extra` last. On real rows `extra` should almost never appear. It exists so the
mapping is total and the round-trip claim holds unconditionally. It also means a highlight field
the frontend adds later is preserved before this module learns about it.

Encoding throws in only these cases, none of them a row the app can address:

- a save whose `rkey` isn't a record key (every write path validates rkeys)
- a save row missing a column, or NULL in a NOT NULL one (a caller's query bug, not data)
- a highlight element with no string `id` (the frontend merges by id, and the merge path already
  refuses id-less elements)

Decoding is the exact inverse and accepts nothing else, so re-encoding a decoded record gives back
the same record and CID, and the CID-equality sync never churns. It rejects:

- an unknown field (on a save, its `file`, a highlight, or its `subject`): a field from a newer
  writer fails loudly rather than being dropped and written back without it
- a missing NOT NULL column (`url`, `savedAt`, `createdAt`, `source`; on a file, every column but
  `filename`)
- a datetime not in the exact form encoding writes (`toISOString`: millisecond precision, `Z`)
- an `extra` key that encoding wouldn't have put there: an unknown column, a column also present
  natively, or a value its native field could carry. So `extra` can't set `rkey`, `id`,
  `user_did` or any other column the record shape doesn't have; the caller's `rkey` always wins.
- a highlight whose record key isn't the one its `id` derives

## Content hashes

`recordCid(record)` is the CIDv1 (dag-cbor, sha2-256, base32) a PDS would report for the record,
computed locally from a minimal DAG-CBOR encoder. The test checks its output byte-for-byte against
`@ipld/dag-cbor` + `multiformats`. The sync job's diff is CID equality: compare a row's CID with
the space record's CID, and write only on a mismatch. The hash is computed on demand, not stored.
A stored hash would need every write path (there are many) to keep it current, and computing one
is cheap.

## Snapshots (proposed)

There are no snapshot rows yet. "Snapshot every save at capture time" adds them. To land in this
shape, a snapshot should be its own record:

```
app.skyreader.archive.snapshot
{ $type, save: <save rkey>, capturedAt, url, contentType, body: blob, sha256, extractor? }
```

The record key is a TID, so a save can hold several captures. The page body is a blob, not an
inline string. Its D1 row should mirror that: `(user_did, rkey, save_rkey, captured_at, sha256,
r2_key, …)`, keyed by its own TID. The mapping then follows the same pattern as `saved_files`.

## Not yet verified against production

Rkey validity and id presence are enforced on every write path in the code. The Skyreader D1
database wasn't reachable from the session that wrote this, so production rows haven't been
checked yet. Before the sync job ships, run the mapping over every row once (counting throws and
rows that needed `extra`) and fix whatever turns up.
