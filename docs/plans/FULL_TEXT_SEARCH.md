# Full-text search over everything read

Goal: a reader can find something they read months ago by a phrase they remember, across what they
read, saved and highlighted, including their own notes. It is a Supporter feature (`fullTextSearch`
in `backend/src/config/tier-limits.ts`) and is tracked as the atplan goal _Full-text search over
everything read_.

**Done when:** search returns ranked results in under a second at p95, measured on staging, for an
index of 100k items, from a keyboard-reachable search surface (`/`).

## Design

**One index per reader.** Each reader gets a SQLite-backed Durable Object (`SearchIndex`,
`backend/src/durable-objects/search-index.ts`) holding an external-content FTS5 index. D1 was ruled
out by the spike in `backend/spikes/search-index`, for three reasons:

- Per-user indexes total far more than D1's 10 GB.
- A shared index has to filter every match by user.
- `wrangler d1 export` refuses any database that contains an FTS5 table.

**What gets indexed.** Only items the reader has touched. How much text is kept depends on the
item:

| Item                | Title, author, feed | Body                                                    | Notes column             |
| ------------------- | ------------------- | ------------------------------------------------------- | ------------------------ |
| Read only           | yes                 | the first 2 KB (`READ_BODY_CHARS`)                      | —                        |
| Saved / highlighted | yes                 | full text up to 64 KB, from the save, R2 or the archive | highlight text and notes |

Notes that exist only in Margin or Semble are out of scope for v1.

**Ranking.**

- bm25 with column weights: title 10, author 3, feed 2, body 1, notes 5.
- A lift for highlighted items (2) and saved items (1), and for items touched in the last 30 days
  (0.5).
- Snippets are computed only for the page of results, never inside the ranked SELECT. In the spike
  that was up to 5× slower on common terms.
- Counts are capped at 1,000, shown as "1,000+".

## Keeping it current: pull, don't push

The index is derived data. It keeps three cursors over D1:

- `item_labels_cache` rows with label `read` or `highlights`, by `(updated_at, id)`
- `saved_articles` by `saved_at`
- `saved_articles` by `updated_at`

Every key a cursor yields is rebuilt from scratch by `buildIndexDocs`
(`backend/src/services/search-index.ts`). Rebuilding is idempotent, which gives three properties:

- A lost nudge or a replayed page costs work, never correctness.
- An item no longer read, saved or highlighted drops out of the index.
- The first sync from cursor zero is the backfill. The alarm keeps rescheduling itself until the
  backlog is drained.

Triggers:

- **Writes nudge.** A successful write to `/api/reading/mark-*`, `/api/labels*` or `/api/saved*`
  calls `nudgeSearchIndex` after the response. Only readers with search get nudged. The nudge
  debounces a sync onto an alarm 2 seconds out.
- **Search catches up first.** Before querying, a search syncs for up to 1.5 s. Writes that never
  nudge are still picked up: an XRPC save, a backed-collection sync. If a backlog remains, the
  search answers from what's already indexed with `index.building: true`.

Details that matter:

- **Cursor lag.** `updated_at` has one-second resolution, so a row re-written within the same
  second as the cursor would never be seen again. Cursors stay 2 s behind now. Newer rows are
  indexed but not passed, and a settle pass is scheduled for them.
- **Hard-deleted saves.** Saves are deleted outright, so no cursor sees a removal. A saved DELETE
  asks the index to diff its saved set against D1, and the diff also runs every 6 h.
- **Aliases.** A highlight on a saved feed article may be filed under the save's AT-URI. Following
  `resolveHighlightAliases` in the frontend, the index files the item under the guid the save
  bridges to, and drops any document built under the alias.
- **Feed-item lookup.** Read labels don't record their feed, and `feed_items` is indexed only on
  `(feed_url, guid)`. The builder probes that index once per subscription for each guid, scoped to
  the reader's subscriptions. An item from a feed the reader has since left keeps the title and
  URL its read label carries.

## API

`GET /api/search?q=&kind=read,saved,highlighted&since=<ms>&limit=&offset=`

- The response carries `results[]`: item key, type, URL, title, feed, kind flags, timestamps, and a
  `snippet` of `{ text, match }` runs. Matches are marked with control characters stripped from all
  indexed text, so the client gets text runs and never HTML.
- It also carries `total` (capped), `totalCapped`, and `index: { items, building }`.
- Status codes: 404 while the operator switch is off; 403 `upgrade_required` without the plan; 400
  `empty_query`.
- Queries go through `parseSearchQuery`. Every term is quoted, so FTS5 operators are literal.
  Supported forms: words, `"phrases"`, `prefix*`, `-exclusions`.

## Rollout

1. **Index, sync and API, behind `sync_state.search_enabled`** (this change). Only an explicit
   `'1'` turns it on. Turn it on in staging first.
2. **Staging measurement.** Seed a reader with 100k items. Check p95 including a cold DO, and the
   billed rows written per item; locally it is 5, while the cost estimate budgets up to 25.
3. **The `/` search surface in the frontend**, with an offline fallback to the client-side Saved
   search, and a docs-site page (`docs-site/src/content/docs/guide/search.md`). Shipped behind the
   same switch: `GET /api/auth/me` reports `searchEnabled`, and the client offers search only when
   that and `limits.fullTextSearch` are both true.
4. **Admin.** Index size and backlog on the ops panel, and a per-user rebuild action
   (`SearchIndex.reset`).

## Cost

From the spike README:

- Storage dominates the bill.
- A typical Supporter (20k items, 300 searches a month) costs about $0.06 a month.
- A heavy reader (100k items) costs about $0.24 a month.
- Backfill is a one-time cost of $0.10–0.50 per reader.
