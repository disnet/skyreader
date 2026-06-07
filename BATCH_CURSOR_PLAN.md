# Batch Sync: GUID Set → Server-Synthesized Cursor

## Problem

The `/api/v2/feeds/batch` incremental-sync mechanism is **payload-heavy**. For each feed
the frontend sends the 10 most-recent GUIDs it already has (`GUIDS_PER_FEED = 10` in
`frontend/src/lib/services/feedFetcher.ts`). With up to 50 feeds per batch, a single request
body carries **up to ~500 GUIDs** — and RSS GUIDs are frequently full URLs, so this is real
weight on every poll.

### Why it's a GUID *set* today, and why that isn't redundant

The proxy's `filterItems` (`feed-proxy/src/app.ts:254`) is a boundary scan: it walks the feed's
items newest→oldest and returns everything *above* the first item whose GUID is in the client's
set.

```
sinceGuids empty   → newest `limit` items   ("LIMITED", cold start)
first known GUID   → items above it          ("MATCHED")
no GUID matches    → full backlog            ("FULL", fallback → client re-downloads)
```

The set is 10 (not 1) purely as a robustness buffer: if the single newest GUID drops out of the
feed's window between polls (publishers keep only the latest N items, reorder, or mutate GUIDs),
a 1-GUID cursor finds no match → FULL refetch. Sending 10 means all 10 newest items must vanish
in one interval to trigger that. Fewer GUIDs is safe for *correctness* (a missed boundary only
causes over-fetch, deduped by GUID on merge — never missed items), but increases full-refetch
frequency. So the set is a deliberate bandwidth-vs-refetch tradeoff, not redundancy.

### Why a feed-supplied `pubDate` cursor won't work — but a *synthesized* one will

A naive single-value cursor (the feed's own `pubDate` high-water mark) fails for RSS: pubDates
are routinely missing, wrong, non-monotonic, backdated, or wrong-timezone. **But the proxy can
synthesize its own monotonic ordering** — a per-feed first-seen sequence number assigned when
the proxy first observes each GUID. That value is trustworthy because the proxy controls it.

## Why the proxy architecture makes this viable (and better)

Two facts from `feed-proxy/fly.toml` remove the usual objections to a server-side cursor:

1. **Enforced singleton.** Exactly one Fly machine, one SQLite DB on the persistent
   `proxy_data` volume (the file has a "SINGLETON INVARIANT" banner forbidding horizontal
   scaling). So a per-feed monotonic counter has **one authoritative writer** and survives
   restarts. The "which instance did I hit?" consistency problem does not exist here.

2. **Self-warming loop.** `warmStaleFeeds` (`app.ts:872`) re-polls every active feed every 60s
   independent of user requests. The proxy therefore *observes* each feed continuously, so
   first-seen assignment catches items that appear and drop out within a user's poll gap. This
   is **strictly better coverage** than the current GUID scan, which only sees what's in the
   feed at request time.

## The one genuine cost: self-healing → epoch-guarding

Today's scheme is **stateless on the server**: the client supplies identity (GUIDs), so any
proxy cache state can be wiped and sync self-heals (the next GUID match re-establishes the
boundary). A synthesized cursor is only meaningful **within a cache epoch**. If a feed's `cache`
row is evicted (cleanup-by-`fetched_at` at `app.ts:875`) or the volume is wiped, `maxSeq` resets
and old client cursors become meaningless — a client whose cursor exceeds the new `maxSeq` would
silently receive nothing.

**Mitigation (load-bearing — do not skip):** tag each feed with an **epoch token** assigned once
at row birth. The client stores and sends `{ epoch, since_seq }`. On epoch mismatch the proxy
ignores `since_seq` and returns the full backlog (LIMITED). This is harmless because the client
dedups by GUID on merge — so we keep GUID-style robustness exactly at the rare moment a cache
reset needs it, and pay the compact-integer cost the other 99.9% of the time.

---

## Design

### Synthetic sequence, not timestamp

Use a **per-feed monotonic integer**, not wall-clock first-seen. Many items can land in one parse;
a timestamp ties them and breaks cursor ordering. A counter is strictly monotonic and tie-free.

- Each feed cache row carries `maxSeq` (in the `parsed_json` blob) and an `epoch` token.
- Each item carries a `seq` assigned when first observed.
- When a single parse surfaces multiple new GUIDs, assign seqs in **reverse feed order** (oldest
  new item gets the lowest seq) so a client's "newest seq I have" cursor advances monotonically
  and item order is preserved.

### Filter becomes a comparison

`filterItems` stops being a scan and becomes: return `items where seq > cursor` (capped at
`limit`). Cold start (no cursor) and epoch mismatch both fall back to newest-`limit` (LIMITED).

---

## Implementation

Three surfaces. The proxy contract is load-bearing; backend and frontend are mechanical once it's
fixed. **Keep `since_guids` working throughout** so rollout is backward-compatible (client opts
into `since_seq` only after it has a stored cursor).

### 1. feed-proxy (`feed-proxy/src/app.ts`) — the real work

- **Types.** Add `seq: number` to `FeedItem` (or a parallel map in the blob to avoid touching the
  parser's `FeedItem` in `feed-parser.ts`). Add `maxSeq: number` and `epoch: string` to
  `ParsedFeed` / the cached blob. No SQL migration needed — all of this lives inside
  `parsed_json`. (Optional later: promote `epoch`/`maxSeq` to real columns if we want to filter
  in SQL; not required for v1.)
- **Synthesis in `fetchParseAndCache`** (`app.ts:624`), right after `parseFeed` succeeds
  (~line 755, before `JSON.stringify`):
  - Load the prior blob's `{ guid → seq }` map and `maxSeq`/`epoch` (or mint a fresh `epoch` if
    no prior row — i.e. cache birth).
  - For each freshly parsed item, reuse its existing `seq` if the GUID is known; otherwise assign
    `++maxSeq` (iterating new items oldest→newest).
  - Persist updated `maxSeq` and the per-item seqs into the new blob.
  - Apply on **all** parse paths that write the cache: fresh MISS, REVALIDATED, and the warm-loop
    refresh (they all funnel through `fetchParseAndCache`, so one change covers them — verify the
    304-not-modified path at `app.ts:651` preserves seqs since it returns the cached blob as-is ✓).
- **Rewrite `filterItems`** (`app.ts:254`) to accept `{ epoch, sinceSeq }`:
  - no cursor / cold start → newest `limit` (`LIMITED`)
  - epoch mismatch → newest `limit` (`LIMITED`, treat as cold)
  - else → `items.filter(i => i.seq > sinceSeq).slice(0, limit)` (`MATCHED`/`DELTA`)
  - Keep the old `sinceGuids` branch alongside for the transition.
- **Endpoints.** `/feed` (`app.ts:1152`) and `/feeds` batch (`app.ts:~1446`): accept
  `since_seq` + `epoch` params/fields in addition to `since_guids`. Always return the current
  `epoch` and each item's `seq` in the response so the client can store the next cursor.
- **Tests** (`feed-proxy/src/integration.test.ts`): seq assignment across re-parses, new-items
  delta, epoch-mismatch fallback, cold start, and the warm-loop refresh assigning seqs to items
  that appear between user requests.

### 2. backend (`backend/src/`) — passthrough, mechanical

- `routes/feeds-v2.ts`: thread `since_seq`/`epoch` through the request body type (`:152`) and the
  single-feed query parse (`:55`). Return `seq`/`epoch` in `V2BatchFeedResult` (and the
  single-feed path). The inline read-annotation join (`:248`) is unaffected — it keys on GUID,
  which items still carry.
- `services/feed-proxy-client.ts`: forward the new params (`:249`, `:313`).
- `types.ts`: extend `V2BatchFeedResult` / request types with `seq`, `epoch`, `since_seq`.

### 3. frontend (`frontend/src/lib/`) — store a cursor instead of deriving GUIDs

- Persist a per-subscription `{ epoch, lastSeq }`. Natural home: a column on the subscription
  record or a small `feedCursors` table in Dexie (db.ts) — **remember to update `clearAllData()`**
  and add a Dexie version bump.
- `feedFetcher.ts`:
  - Replace `getRecentGuids(sub.id, GUIDS_PER_FEED)` (`:106`) with a stored-cursor lookup; send
    `{ since_seq, epoch }` when present, nothing on cold start.
  - After merging a feed's items, advance the stored cursor to the max `seq` seen (and store the
    response `epoch`). On epoch change, reset `lastSeq` to the new max.
  - `liveDb.getRecentGuids` (`liveDb.svelte.ts:276`) can be retired once nothing else uses it.
  - Keep the GUID path behind a fallback until the proxy/backend are deployed (feature-detect on
    whether the response carries `seq`/`epoch`).

---

## Rollout order

1. Ship proxy: synthesize seqs + epoch, accept **both** `since_guids` and `since_seq`, always
   emit `seq`/`epoch`. (No client impact yet — existing GUID clients keep working.)
2. Ship backend passthrough.
3. Ship frontend: start storing cursors from emitted `seq`/`epoch`; switch send-path to
   `since_seq` once a cursor exists, GUIDs as cold-start/fallback only.
4. After a release cycle with no GUID-path traffic, retire `since_guids` from all three surfaces.

## Payload impact

~500 GUID strings/batch → ~50 integers + 50 short epoch tokens/batch. The robustness GUIDs bought
is preserved by the epoch-guard, which fires only on cache reset (rare) and self-heals via
client-side dedup.

## Open questions

- **Epoch token shape.** Random id minted at row birth, or `cached_at` of the birth insert?
  A dedicated random id is unambiguous; `cached_at` risks collision if a row is re-created within
  the same ms. Lean random.
- **Blob size growth.** Storing `seq` per item is negligible, but confirm `MAX_ITEMS_TO_PARSE`
  caps the per-feed item count so the `{guid→seq}` map can't grow unbounded for high-churn feeds.
- **Should `seq` survive a feed that drops below its item window and an item later reappears?**
  With first-seen semantics a reappearing GUID keeps its old (low) seq only if still in the blob;
  if it aged out of the blob it gets a new high seq and is re-delivered. That's the desired
  behavior (treat reappearance as new) — just document it.
