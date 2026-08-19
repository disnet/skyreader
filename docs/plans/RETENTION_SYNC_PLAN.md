# Durable Item Retention: Catch Everything Since Last Visit

> **Superseded in part by `D1_FEED_TIMELINE.md`.** Everything below shipped and still runs — but
> the durable log's *serving* role has moved to D1. The proxy log is now the crawler's **outbox**
> (a bounded K = 200 delivery window pushed into D1); the **archive** clients read from is
> `feed_items` in D1, which never prunes, and the cursor clients hold is a single global one
> against that table rather than one per feed.

> Supersedes `BATCH_CURSOR_PLAN.md`. That plan optimized the *request payload* (500 GUIDs →
> a cursor) but kept the proxy's replace-the-blob storage model, which structurally cannot
> retain items beyond the source feed's live window. This plan changes the storage model so
> the proxy becomes a **durable item log**, then layers a monotonic cursor on top. Smaller
> payloads fall out for free; they're no longer the point.

## Primary goal

**A returning reader catches every item published while they were away** — even from a feed
that only keeps its latest handful of items live in its XML. Today this is impossible at any
buffer/window setting, because the proxy mirrors the source: it parses the feed and *replaces*
its cache (`app.ts:755`), so anything that aged out of the source between a user's polls is
gone. The warm loop keeps the cache fresh but never accumulates.

We make the proxy **retain** items it has observed, bounded by a **per-feed row cap**, and serve
each client a **monotonic cursor** so it can drain everything new since its last visit across one
or more polls.

Read the promise honestly: it is bounded by **two** things, not one — what the proxy actually
watches, *and* how far back the per-feed cap retains. It holds for feeds the proxy keeps observing
and **lapses for feeds that go cold** — a feed nobody requests for long enough that the warm loop
drops it (see *The real invariants*). On top of that, even a continuously-watched feed only retains
its newest `K` items (the cap, below), so an absence that spans more than `K` items on a single feed
loses the oldest of them. So the precise guarantee is **"catch everything since last visit, bounded
by `min(warm-observation-window, K items per feed)`"** — not an unconditional one. Both bounds fall
hardest on exactly the long-absent, niche-feed reader this goal names: the cold-feed bound because
an away reader generates no requests to keep their feeds warm, and the K bound because a long absence
is the case most likely to exceed `K`.

### Non-goals / deliberate limits

- **Don't dump the full backlog on a brand-new client.** Cold start serves a recent slice
  (`COLD_START_LIMIT`) and jumps the cursor to the feed's max — older retained items are simply
  never delivered to someone who was never subscribed. This keeps the "calm, focused, quiet"
  default (PRODUCT.md): catch-up is for *returning* readers, not a firehose for new ones.
- **Don't re-deliver edits.** A re-published item (same GUID, changed content) updates in place;
  its cursor position doesn't move. (Reversible later — see Open questions.)
- **Don't promise coverage for feeds that go cold.** Retention only spans the window where the proxy
  is actually observing a feed, and observation is request-driven (warm loop, 14-day active window).
  A feed nobody requests for long enough drops out of the warm loop and stops being observed, so
  items it publishes-and-drops during that cold window are missed — the same loss this plan otherwise
  closes. This is a deliberate limit of a poll-based design, detailed (with levers) in *The real
  invariants*.

## Why this works where the old model couldn't

The proxy already re-polls active feeds on its own (`warmStaleFeeds`, `app.ts:872`) — any feed
requested within the warm active window, without needing a fresh request each cycle. Once it
*retains* what it sees, that continuous observation is what captures items that appear and drop out
within a user's poll gap. This is the coverage the old `BATCH_CURSOR_PLAN` *claimed* but couldn't
deliver — it only becomes true with retention. The catch is that "active" is request-driven, so the
observation isn't unconditional — see *The real invariants* for where it lapses.

### The real invariants (state them honestly)

Retention catches everything **the proxy observed** — and that hinges on two conditions, not one.

**1. The proxy has to be observing the feed at all.** It observes a feed only while that feed is
*warm*, and `warmStaleFeeds` keeps a feed warm only while some client requested it within
`WARM_ACTIVE_WINDOW` (**14 days**, `index.ts`). A feed nobody requests for 14 days falls out of the
warm loop: the proxy stops fetching it, and `cleanupCache` then evicts its `cache` row (and, here,
its `feed_items`) ~7 days later. During that cold window the proxy sees nothing, so anything the
source publishes and then drops is gone — the exact loss this plan otherwise closes. **This is where
the headline promise lapses**, and it lapses precisely for the long-absent reader of a niche,
solo-subscribed feed — the persona the primary goal names — because "active" is *request-driven* and
a reader who is away generates no requests to keep their feeds warm. A feed some client touches
within any 14-day span stays warm and is fully covered; a solo feed across a >14-day absence is not.
Levers: widen `WARM_ACTIVE_WINDOW` (linear cost in feeds kept warm), or adopt WebSub (appendix) so
cooperating feeds stay observed by *push* even with zero requests. Polling alone can't fully close
it — observation is tied to traffic, and the absent reader is the one not generating any.

**2. While observing, a fetch must not overflow.** The proxy observes a feed on each fetch, roughly
every **~13 min** (warm-refresh threshold ≈ `cacheTtl − margin`, `index.ts:19-21`; sooner when a user
request finds the cache expired). Each fetch parses at most `MAX_ITEMS_TO_PARSE` items
(`feed-parser.ts:19`). So, *for a feed the proxy is observing*, the guarantee is precisely:

> **No miss as long as the source publishes ≤ `MAX_ITEMS_TO_PARSE` items per ~13-min fetch
> interval.**

Invariant 1 is the load-bearing one for the primary goal; invariant 2 only bites high-velocity
feeds. Both are real; neither is absolute.

This plan **raises `MAX_ITEMS_TO_PARSE` from 30 → 100** (see Implementation §1). That widens the
no-miss envelope from ≈138 to **≈460 posts/hr sustained** before a single interval can overflow,
and — importantly for retention — means the *first* time the proxy sees a feed it seeds up to 100
items of history immediately, instead of 30. 100 aligns with the existing `DEFAULT_LIMIT`, sits
below the per-feed retention cap (K = 200, so retention still accumulates across parses), and costs
only a longer extraction loop (the XML is fully parsed regardless). It's decoupled from
`defaultLimit` and the frontend `COLD_START_LIMIT`, so cold-start payload is unaffected.

Even at 100 a genuine firehose can overflow one interval; the per-feed cap (below) bounds those
regardless, and the warm-refresh threshold can be shortened for high-velocity feeds if needed.
Document both invariants; don't pretend either is absolute.

---

## Architecture

Keep the existing `cache` row doing **exactly** what it does today — feed-level metadata
(title/siteUrl/description/image), `etag`/`last_modified`, TTL, error/backoff, warm-loop
bookkeeping (`last_requested_at`/`fetched_at`). None of that machinery changes. **Add** a durable
item log beside it.

### New table: `feed_items`

```sql
CREATE TABLE IF NOT EXISTS feed_items (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,  -- global monotonic cursor
  url_hash      TEXT    NOT NULL,                    -- which feed (matches cache.url_hash)
  guid          TEXT    NOT NULL,
  item_json     TEXT    NOT NULL,                    -- the FeedItem, serialized
  published_at  INTEGER,                             -- for display sort / optional age eviction
  first_seen_at INTEGER NOT NULL,                    -- when the proxy first observed it
  content_hash  TEXT,                                -- detect edits without re-delivering
  UNIQUE(url_hash, guid)
);
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_seq   ON feed_items(url_hash, seq);
CREATE INDEX IF NOT EXISTS idx_feed_items_first_seen ON feed_items(first_seen_at);
```

(Note: `types.ts` already carries vestigial `FeedRow`/`ItemRow` interfaces from an earlier design
— unused anywhere. Repurpose or delete them.)

**Why `INTEGER PRIMARY KEY AUTOINCREMENT` is the whole trick.** SQLite's rowid is globally
monotonic for the life of the DB file, and `AUTOINCREMENT` guarantees a value is **never reused**
even after deletes (it tracks the high-water mark in `sqlite_sequence`). So:

- A client cursor never collides with a recycled seq after eviction.
- A client cursor can only ever be *behind* the live max, never ahead — so the "cursor exceeds
  maxSeq → silently receive nothing" failure from the old plan **cannot occur within a DB
  lifetime**. The only reset is total loss of the DB file (volume wipe), guarded by a single
  generation token (below) — not the old plan's fragile per-feed epochs.
- seqs interleave across feeds (they share one counter). Harmless: within a feed they're still
  strictly increasing in first-seen order, and the read always filters by `url_hash`.

### Generation token (volume-wipe guard)

One token for the whole DB, minted once at init, stored in the existing `sync_state` table:

```sql
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('items_generation', <random-id>);
```

Returned in every response. The client stores it with its cursors. On mismatch (DB was recreated
→ `sqlite_sequence` reset → seqs restart at 1) the client discards cursors and cold-starts. This
is load-bearing but trivial: **one** token, **one** reset condition.

Use a fresh random id at each genuine init (e.g. crypto-random), so a recreated DB always mints a
value distinct from the previous one — a fixed/seeded id would collide and defeat the guard.

**The one case the token does *not* cover: restore-to-an-older-state.** The guard assumes the only
way seqs move backward is a full wipe (empty DB → new token). A Fly **volume snapshot restore**
breaks that assumption: the DB returns with the *same* persisted `items_generation` but *rewound*
seqs. A client holding a cursor above the restored max then hits exactly the "cursor ahead of
maxSeq → `seq > cursor` returns nothing" failure this design otherwise eliminates — silently, until
each feed organically re-accumulates past the old cursor. Low probability, but it's the single path
that reintroduces the failure mode the cursor was chosen to kill, so handle it explicitly:
**bump `items_generation` as part of any restore runbook** (or mint it from volume-creation time
rather than first-init, so a restored older volume carries an older token and clients cold-start).

### Per-feed row cap = the hard bound on growth

Retention turns storage from "bounded by ≤30 × feeds" into "needs active management." The cap is
the guarantee. After each write, trim the feed to its newest `K` (propose **K = 200**):

```sql
DELETE FROM feed_items
WHERE url_hash = ?
  AND seq NOT IN (SELECT seq FROM feed_items WHERE url_hash = ? ORDER BY seq DESC LIMIT ?);
```

This runs after every write on every parse path (~every 13 min per warm feed), so prefer the
cheaper cutoff form — compute the K-th-newest seq once, then range-delete below it — over the
`NOT IN (subquery)` anti-join, which re-scans the feed's rows twice per call:

```sql
DELETE FROM feed_items
WHERE url_hash = ?
  AND seq <= (SELECT seq FROM feed_items WHERE url_hash = ? ORDER BY seq DESC LIMIT 1 OFFSET ?);
-- OFFSET = K; the subquery yields nothing when the feed has ≤ K rows, so the DELETE is a no-op.
```

Single-writer SQLite makes both forms correct; this is purely a per-parse cost choice.

This single rule also defuses the **GUID-mutation pathology** (a publisher that rewrites GUIDs
every poll would otherwise insert "new" rows forever): a mutating feed just churns within its
K-row budget. Total storage ≤ `K × active feeds`, hard.

**Size the volume for it — this is the one operational risk that bites in prod, not review.** The
cap bounds *rows*, but the proxy is a fixed-size Fly volume, so bound *bytes* too. Going from ≤30 to
K=200 full `item_json` rows per feed is ~6.7× the per-feed item storage, plus the `feed_items`
indexes. At the appendix's own ~10k-unique-feed figure: 200 × 10k = 2M rows × ~1–5 KB/row ≈ **2–10 GB**
for `feed_items` alone, on top of the existing `cache`/`document_cache` blobs. Compute the estimate
from real `item_json` sizes and confirm `proxy_data` is provisioned with headroom before enabling
retention; if it's tight, K is the lever (storage is linear in K). Don't ship this without checking
the volume size — the current model's ~30×feeds footprint won't have forced the question yet.

Secondary eviction (defense in depth, not the primary bound):

- **Cascade on feed eviction.** When `cleanupCache` deletes a `cache` row (7-day idle,
  `app.ts:1898`), delete that feed's items too (`DELETE FROM feed_items WHERE url_hash = ?`).
- **Optional age cap** in `cleanupCache`: `DELETE FROM feed_items WHERE first_seen_at < threshold`
  if we want items to expire even on still-active feeds.

---

## Read path: `filterItems` becomes a query

The scan over the blob's items (`app.ts:254`) is replaced by a query against `feed_items`. Three
cases, and the cold/incremental split is what implements the product intent:

**Incremental (cursor present, generation matches) — "catch everything":** drain oldest-unseen
first so a backlog larger than `limit` is never skipped, just paged across polls.

```sql
SELECT item_json, seq FROM feed_items
WHERE url_hash = ? AND seq > :sinceSeq
ORDER BY seq ASC
LIMIT :limit;
```

- Advance the client cursor to the **max seq returned**.
- Set `hasMore = true` when more rows remain above that (so the client re-polls promptly to drain
  rather than waiting a full interval).
- ASC arrival order is irrelevant to UX — the client merges by GUID and re-sorts by published
  date for display, accumulating in IndexedDB.

**Cold start (no cursor, or generation mismatch):** recent slice, newest first, then jump the
cursor past the delivered slice.

```sql
SELECT item_json, seq FROM feed_items
WHERE url_hash = ?
ORDER BY seq DESC
LIMIT :limit;            -- limit = COLD_START_LIMIT from the client
```

- Set cursor to the **max seq among the rows actually returned**, *not* a separate
  `SELECT MAX(seq)` over the whole feed. The retained items older than that max are intentionally
  **not** delivered (cold start is a recent slice, not a backlog dump), and `seq > cursor` will pick
  them up never — which is the intent.
- **Why not `MAX(seq)` for the feed:** a separate `MAX(seq)` query is a TOCTOU race against the
  warm loop. Between this `ORDER BY seq DESC LIMIT` SELECT and a separate `MAX(seq)`, a warm-loop
  write can insert a newer row; `MAX(seq)` then returns a seq the client never received, and the
  next poll's `seq > cursor` skips it **permanently**. Deriving the cursor from the returned rows
  closes the race (any row written after the snapshot has `seq > cursor` and is delivered next poll)
  and needs only the one query. The incremental case already does exactly this ("advance to the max
  seq returned"); cold start must match.

**Backlog evicted below the cursor:** if a returning client's `sinceSeq` is below the feed's
lowest surviving seq (its catch-up window was trimmed by the cap), the `seq > sinceSeq` query
simply returns everything surviving — bounded over-delivery, never a *cursor-mechanics* failure
(the client never silently receives nothing). Be precise about what this does and doesn't promise:
the items between `sinceSeq` and the lowest surviving seq — the ones trimmed by the cap during the
absence — **are gone**. That's the K-window bound stated up front, not a regression; the cursor
machinery just never compounds it with a skip. "Never silent loss" means *the cursor never loses
items the cap kept*, not that the cap keeps everything.

### Writing items in `fetchParseAndCache`

After a successful parse (`app.ts:755`, before/alongside the existing `cache` upsert), insert the
parsed items **oldest → newest** (feeds are newest-first, so reverse) so seq order within a parse
matches feed order:

```sql
INSERT INTO feed_items (url_hash, guid, item_json, published_at, first_seen_at, content_hash)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(url_hash, guid) DO UPDATE SET
  item_json    = excluded.item_json,
  content_hash = excluded.content_hash
WHERE feed_items.content_hash <> excluded.content_hash;   -- edit updates in place, seq unchanged
```

**Always populate `content_hash` on insert.** SQLite `<>` is NULL (not true) when either operand is
NULL, so a row with a NULL `content_hash` would never match the update predicate — silently
disabling edit-in-place for that item forever. The schema makes the column nullable for forward
flexibility, but the writer must compute a hash on every insert; treat a NULL `content_hash` as a
writer bug, not a valid state.

Then enforce the per-feed cap (above). This runs on **every** path that writes the cache — fresh
MISS, REVALIDATED, and the warm-loop refresh — because they all funnel through
`fetchParseAndCache`. The 304-not-modified path (`app.ts:651`) writes nothing new, so seqs are
preserved untouched. ✓

Single-writer SQLite (the enforced Fly singleton) means no race on the counter or the
read-modify-write of the cap — one authoritative writer, survives restarts.

---

## Response shape

Each feed result gains:

- `cursor` — the max seq returned (client stores this, sends it back as `since_seq`).
- `generation` — the DB generation token.
- `hasMore` — backlog not fully drained for this feed.

Items still carry `guid` (client dedup + the backend's inline read-annotation join, which keys on
GUID and is unaffected). The client does **not** need per-item seq — only the batch max (`cursor`).

---

## Implementation

Three surfaces. The proxy is the real work; backend and frontend are mechanical once the contract
is fixed. **Keep `since_guids` working throughout** — and it doubles as the migration path.

### 1. feed-proxy (`feed-proxy/src/app.ts`) — the work

- **Parse cap.** Raise `MAX_ITEMS_TO_PARSE` from 30 → 100 (`feed-parser.ts:19`; the four loop
  guards already reference the constant, so it's a one-line change). Widens the no-miss invariant
  and seeds more history on first observation. Update the existing cap test
  (`feed-parser.test.ts:462-488`), which generates 50 items and asserts `toHaveLength(30)` /
  `items[29] === 'Post 30'` — bump its fixture above 100 (e.g. 120 items) and assert
  `toHaveLength(100)` / `items[99] === 'Post 100'` so it still exercises the cap.
- **Schema.** Add the `feed_items` table + indexes in `initDatabase` (`app.ts:292`). Mint
  `items_generation` into `sync_state`.
- **Write.** In `fetchParseAndCache`, after the successful `cache` upsert, upsert items
  (oldest→newest) and enforce the per-feed cap. `cache.parsed_json` keeps the feed-level metadata;
  it no longer needs to be the source of truth for items (can keep storing them during transition
  for zero-risk rollback, or stop — items now live in `feed_items`).
- **Read.** Replace `filterItems` with a `feed_items` query supporting `{ generation, sinceSeq,
  limit }` per the three cases above. Wire into both `/feed` (`app.ts:1246`) and the `/feeds`
  batch (`app.ts:1578`).
- **Backward-compat / migration — `since_guids` as sugar over the cursor.** When a request sends
  `since_guids` (and no `since_seq`), resolve a boundary seq and reuse the same delta query:

  ```sql
  SELECT MAX(seq) AS boundary FROM feed_items WHERE url_hash = ? AND guid IN (...);
  -- found    → return seq > boundary  (ASC, limit, hasMore)
  -- no match → cold start (newest limit)
  ```

  So existing GUID clients keep working unchanged, and their first post-deploy poll gets a
  `cursor` back — after which they switch to `since_seq`. The compat path *is* the migration.

  Caveat (acceptable, worth stating): the client sends its newest-*by-published-date* GUIDs, but
  `seq` is first-*seen* order, so `MAX(seq)` over them isn't an exact boundary when a feed publishes
  out of order (a backdated or late-appearing post can sit below the client's display-newest item
  yet carry a higher seq). The failure mode is bounded *over*-delivery (a few already-seen items
  re-sent, caught by GUID dedup), never loss. Fine for a transitional path — don't represent the
  boundary as exact.
- **Cleanup.** Cascade `feed_items` deletes from `cleanupCache` (`app.ts:1895`) when a `cache` row
  is evicted; optional age cap.
- **Tests** (`integration.test.ts`):
  - **Headline:** item observed by the warm loop, then dropped from the source, is still delivered
    to a client that polls after the drop. (The thing the old architecture could not do.)
  - seq monotonic across re-parses; a re-seen GUID keeps its seq (no re-delivery).
  - delta returns `seq > cursor`, ASC, capped at `limit`, `hasMore` set when backlog remains.
  - per-feed cap trims to newest K; a GUID-mutating feed stays within budget.
  - cold start returns newest `limit` and jumps cursor to max (no full-backlog dump).
  - `since_guids` resolves to a boundary seq; no-match → cold start.
  - generation mismatch → cold start.
  - edit (same GUID, new content) updates `item_json` in place, seq unchanged, not re-delivered.
  - backlog drains across successive polls with no skipped items.

### 2. backend (`backend/src/`) — passthrough, mechanical

- `routes/feeds-v2.ts`: thread `since_seq` + `generation` through the request body type (`:152`)
  and single-feed parse (`:55`); return `cursor`/`generation`/`hasMore` in `V2BatchFeedResult`
  and the single-feed path. The inline read-annotation join (`:248`) keys on GUID — unaffected.
- `services/feed-proxy-client.ts`: forward the new params (`:249`, `:313`).
- `types.ts`: extend the request/result types with `since_seq`, `cursor`, `generation`, `hasMore`.

### 3. frontend (`frontend/src/lib/`) — store a cursor, drain the backlog

- **Dexie** (`db.ts`): add a small `feedCursors` table `{ subscriptionId, generation, cursor }`
  (or columns on the subscription record). **Update `clearAllData()`** and bump the Dexie version
  (currently 35).
- **`feedFetcher.ts`:**
  - Replace `liveDb.getRecentGuids(sub.id, GUIDS_PER_FEED)` (`:106`, `:298`) with a stored-cursor
    lookup. Send `{ since_seq, generation }` when present; on cold start send neither (+ keep
    `COLD_START_LIMIT`).
  - After merging a feed's items, advance the stored cursor to the response `cursor` and store
    `generation`. On generation mismatch, reset the cursor.
  - **Drain loop:** when a feed result has `hasMore`, re-poll that feed (bounded, e.g. until
    `hasMore` clears or a small max-rounds cap) so a returning reader catches up promptly instead
    of one `limit`-sized page per poll interval. Log if the cap is hit (no silent truncation).
  - Keep the GUID send-path as cold-start/fallback until the proxy + backend are deployed
    (feature-detect on whether the response carries `cursor`/`generation`).
  - Retire `liveDb.getRecentGuids` (`liveDb.svelte.ts:276`) once nothing else uses it.

---

## Rollout order

1. **Proxy:** add `feed_items` + generation, write on all parse paths, read via the cursor query,
   accept **both** `since_guids` (→ boundary) and `since_seq`, always emit
   `cursor`/`generation`/`hasMore`. No client impact — existing GUID clients keep working and start
   receiving cursors.
2. **Backend** passthrough.
3. **Frontend:** start storing cursors from emitted `cursor`/`generation`; switch send-path to
   `since_seq` once a cursor exists (GUIDs as cold-start/fallback); add the drain loop.
4. After a release cycle with no GUID-path traffic, retire `since_guids` from all three surfaces.

## Payload impact (the freebie)

~500 GUID strings/batch → ~50 integers + one shared generation token/batch. Real, but secondary to
the capability. The cursor's robustness no longer depends on a buffer size — within a generation it
is exact.

## Documents (standard.site / `atproto.documents`) — out of scope for the log, in scope for the contract

This plan is RSS-only. Documents share the *symptom* (a blob-replace cache) but not the *cause*, so
they get a different, lighter treatment.

**The symptom.** Documents cache the old way: `document_cache` is a per-author blob
(`feed-proxy/src/app.ts:402`), capped at `MAX_DOCUMENTS_PER_AUTHOR = 100`
(`standard-site.ts:22`), replaced wholesale on each fetch (`fetchDocumentsForAuthor`,
`standard-site.ts:274`). The frontend deliberately sends no `since_uris` and full-replaces per
scope every poll (`reconcileDocuments`, `documentSync.ts:52`; the no-op `filterSinceUris`,
`standard-site.ts:341`). So the cache exhibits the same replace-the-blob shape this plan removes for
feeds.

**Why the cause is different — the source is lossless.** RSS retention exists because the *source
forgets*: a feed serves its latest N items and the rest is gone forever, so if the proxy doesn't
retain, nobody can. Documents come from the author's PDS via `listRecords` with a real `cursor`
(`standard-site.ts:286-304`) over the `site.standard.document` collection, which keeps **every**
record permanently and pages arbitrarily far back. A document a returning reader missed is never
gone; it is one more `listRecords` page away. The 100-cap is a *cache* bound, not a
data-availability bound. On top of that, firehose-covered authors (the active `wantedDids` set,
`jetstream.ts`) have their creates *pushed*, so they don't even have the polling-gap that RSS does.

**Consequence: a `feed_items`-style durable log is the wrong tool here.** It would build durability
to compensate for source loss that doesn't exist — the PDS already *is* the durable log. The real
document gap is narrower (cold non-firehose authors, an author with >100 docs, a long-absent reader)
and the right fix, if catch-up is wanted, is to **page deeper against the PDS** keyed on its own
ordering (`listRecords` cursor / record `rev` / `createdAt`), not a synthesized first-seen seq.
Whether document catch-up is even a goal is a product call: documents are linkblog/social content,
and the "calm default" (PRODUCT.md) arguably wants the live window, not a backlog firehose.

**Chosen direction: unify the response *contract*, not the storage.** Once feed results carry
`cursor` / `generation` / `hasMore`, leaving documents on full-replace-every-poll means two sync
paradigms in one client (`feedFetcher.ts`): feeds drain incrementally by cursor, documents
re-download wholesale. We give the document endpoint the **same incremental shape** so the frontend
has one mental model and one drain loop, while the document *storage* stays the per-author blob for
now.

- **Proxy:** the document endpoint emits `cursor` / `generation` / `hasMore` alongside its results.
  Backing it with the blob is fine initially — `cursor` can be a position over the author's PDS
  ordering rather than a `feed_items` seq; `generation` can be shared with the feed token.
  **In phase 1, force `hasMore = false` for documents.** This matters: with blob-replace storage
  (the whole live ≤100 set served every poll, no deeper paging — deferred below), there is no older
  slice to drain *to*. If the endpoint reported `hasMore = true`, the reused feed drain loop would
  either spin fruitlessly or demand the deferred PDS deep-paging. So phase 1 is a **pure
  contract-shape change** — documents emit the same three fields for one client mental model, but
  `hasMore` stays false and behavior is identical to today. `hasMore` only becomes meaningful (and
  the drain loop only does real work for documents) once deep-paging past the cap lands.
- **Backend/frontend:** thread the same fields documents already pass through (`feeds-v2.ts`,
  `documentSync.ts`) and reuse the feed drain loop. `since_uris` / `filterSinceUris` become the
  document analog of the `since_guids` compat path and can be retired the same way.
- **Deferred:** actually paging deeper than the 100-cap (true >100 catch-up) and any `document_items`
  table. Only pursue if real authors exceed the cap *and* product wants long-absence catch-up for
  documents. The unified contract is forward-compatible with that change — it would swap the
  cursor's backing without touching the client.

## Open questions / decisions

- **Per-feed cap K.** Proposed 200. It sets both the catch-up window (how far back a returning
  reader can recover) and the storage ceiling (`K × active feeds`). Pick with real feed-velocity
  data; expose as a tunable.
- **Edit re-delivery.** Chosen: update in place, don't re-deliver (cursor stable). Reversible — to
  re-surface edits, bump seq on content change instead. Decide if "this was updated" is a feature.
- **Cold-start backlog.** Chosen: serve `COLD_START_LIMIT`, jump cursor to max (calm default).
  Reconsider only if "show me everything from the moment I subscribed" becomes a goal.
- **Warm cadence for firehose feeds.** Parse cap is settled at 100 (Implementation §1). The
  remaining knob is the warm-refresh threshold — shortening it for high-velocity feeds further
  widens the no-miss invariant. Optional; revisit only if real feeds are seen overflowing 100 per
  ~13-min interval. **A third lever exists for cooperating feeds: WebSub push** — see the appendix.
- **Keep `cache.parsed_json` items during transition?** Cheapest rollback is to keep writing them
  (read from `feed_items`, fall back to the blob if the table is empty), then drop the blob's items
  once `feed_items` is proven in production.

---

## Appendix: WebSub push as a complement (and why not a third-party feed API)

Before committing to build, we checked whether a third-party feed service could deliver retention
off the shelf instead. The conclusion is **build the log, but adopt one idea from the survey —
WebSub — as a complement, not a replacement.**

### Why not buy: the read-annotation join pins this in-house

No external feed API knows anything about Skyreader's read state. The proxy/backend already do an
**inline read-state annotation** keyed on GUID, joined against our own server-side read state in D1
(`feeds-v2.ts:248`). So a vendor can only ever replace the **fetch + retain + cursor** layer; we
still own the read join on top. That structurally caps the upside of buying, and it's why a
"reader-backend" API (Inoreader, NewsBlur) is the wrong shape — those carry *their own* server-side
read/unread model, which directly conflicts with the read state we already own.

The survey shook out into three buckets:

- **Parsing proxies** (rssapi.net ~€9–599/mo, RSS.app, Feedity, rss2json). These normalize live
  feeds to JSON, optionally with new-item webhooks — a managed version of our *parse* step. But
  their "retention" is delivery/webhook **logs**, not a guaranteed item archive: they do **not**
  retain past the source's live window in a way we can rely on. They'd let us delete
  `feed-parser.ts` while leaving this plan's entire reason for existing unsolved. Not worth a vendor
  dependency to replace the one part of the stack that already works.
- **Reader-backend APIs.** Feedly's Cloud API is now enterprise-only (a ~$2,400/mo add-on) — dead on
  arrival. Inoreader/NewsBlur have dev APIs but the read-state conflict above rules them out.
- **Push/retention hubs** — the only category that actually solves *retention*. Covered next.

### Superfeedr: the near-exact managed version of this plan, and why we still build

[Superfeedr](https://superfeedr.com/subscriber) is, on paper, almost exactly what this document
proposes, already built:

- **Durable retention** ("cave storage" of past feed content), so items aged out of the source XML
  remain retrievable — the precise capability our headline test exists to prove.
- **Real-time push** via WebSub/PubSubHubbub webhooks; it polls feeds that don't support WebSub on
  its side.
- A **`retrieve` API with `before`/`after` pagination** — a cursor over history, the same shape as
  our `since_seq` drain loop.

Pricing is per **distinct feed** (first 10 free, then ~$0.10/feed for the first 50, ~$0.05 to 5k,
~$0.02 to 50k). Because we dedupe subscriptions to unique feeds, cost scales with unique-feed count,
not users — order-of-magnitude ~$350/mo at ~10k feeds. Affordable in isolation.

**Why we don't go with it:** Superfeedr was acquired by Medium in **2016** and has been in evident
maintenance-only mode for ~a decade — no SLA story, no sign of active development. Putting the
durability guarantee of a product whose entire pitch is *the owned, portable library* (PRODUCT.md)
behind a single unmaintained vendor is a poor trade. Vendor death would silently reintroduce exactly
the gap this plan closes, on the one axis we most need to be able to promise. And per the join
argument above, buying it wouldn't even retire the layer we most want help with.

### The idea worth keeping: WebSub as a per-feed push complement

The genuinely useful takeaway from Superfeedr is the **mechanism**, not the service. Both invariants
above come down to *when and whether we poll*: invariant 2 (don't overflow a ~13-min interval) and
the load-bearing invariant 1 (a feed is observed only while it's request-warm). For the subset of
feeds that advertise a hub (`<link rel="hub" href="...">` in the feed XML), we can subscribe and have
new items **pushed** to the proxy as they publish. That collapses the poll-gap to near-zero
(invariant 2) and — **if the hub subscription is kept alive independent of request-recency** — keeps
a feed observed even when nobody is requesting it, which is the one thing that closes the cold-feed
hole in invariant 1 short of polling every known feed forever.

Crucially this is **additive and changes nothing in the core design**: `feed_items`, the per-feed
cap, the monotonic seq, and the cursor all stay exactly as specified. A WebSub callback just becomes
another path into `fetchParseAndCache` — the same write/retain/cap funnel every other path uses —
making observation *continuous* for cooperating feeds instead of every ~13 min. It composes with the
two existing levers (the parse cap, raised to 100; the warm-refresh threshold) as a third, applied
only where the feed opts in.

Sketch, if pursued (deferred — land the durable log first):

- **Detect** a hub during parse (the `<link rel="hub">` / `Link: rel=hub` header) and record it on
  the `cache` row.
- **Subscribe** the proxy's public callback to the hub; persist the subscription + lease and renew
  before expiry (WebSub leases are time-bounded). The key lifecycle choice: renew only for
  request-warm feeds (cheap, but inherits the invariant-1 cold-feed hole) or for any feed with a
  known hub (closes invariant 1 for those feeds, at the cost of unbounded subscription bookkeeping).
- **Receive** pushed payloads at the callback, verify the HMAC signature, and route the parsed items
  straight through `fetchParseAndCache` (write → retain → cap), unchanged.
- **Keep polling as the floor.** WebSub hubs are best-effort and not every feed has one, so the warm
  loop stays the baseline; push only *narrows* the gap where available. No feed depends on it.

Cost is proxy complexity (a public callback endpoint, signature verification, lease bookkeeping), not
dollars or a vendor. Revisit only if real feeds are seen overflowing 100 per ~13-min interval and a
shortened warm threshold isn't enough — at which point push is the cleaner fix than polling those
feeds ever-faster.
