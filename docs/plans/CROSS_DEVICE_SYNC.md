# Converging article sync state across devices

**Status:** Implemented.

The report ([userinput thread](https://userinput.app/d/did:plc:esmiuxk53vmsllayghrq676w/3mufwllspa42m)):

> "Subscribing to a feed syncs the subscription but doesn't sync the associated articles. In
> practice … the same feed will show different unread numbers on different devices. … I even lost
> data before I realized this syncing limitation."

Read state _did_ sync. Several separate mechanisms nonetheless guaranteed that two devices signed
into one account would disagree — persistently, not transiently — and one of them made an eviction
look like deletion. This is what each was and what replaced it.

## 1. Article membership was device-local, so the numbers could never agree

Unread counts were derived client-side over whatever articles the device happened to hold, and no
two devices held the same slice: a fresh device cold-started with the newest **30** per feed, an
established one accumulated up to **100**, and each trimmed at different moments against different
sets. A device holding 100 and a device holding 30 show different numbers for the same feed even
with read state perfectly in sync. No amount of sync work could have fixed that.

**Now:** one **K** (`backend/src/config/window.ts` → `ARTICLE_WINDOW_PER_FEED = 100`), enforced in
the cold start, the counts query, and the client's `MAX_ARTICLES_PER_FEED`. The server computes
per-feed unread counts over that window (`include_counts=1`, first page of a refresh only) and the
client displays those when online, falling back to its local derivation offline. A mismatch after a
completed refresh reports `unread_count_drift` telemetry — divergence is now something we observe
rather than something a user has to notice and write up.

K = 100 rather than 50: cold start is rare and paged; divergence was daily.

## 2. "Mark all read" only marked the acting device's window

It iterated the articles that device held. Items another device held below that window stayed
unread there — so the one action whose entire purpose is to force agreement didn't.

**Now:** `POST /api/reading/mark-feed-read { feedUrl?, beforeSeq? }` writes read rows for the
canonical window server-side (≤ K per feed), and they ride the existing forward delta out to every
device. The client keeps its optimistic local pass and still falls back to the per-item queue
offline. `beforeSeq` is the archive head the client saw, so items ingested after the press stay
unread — which is what the user meant.

_Rejected:_ a per-feed `readWatermark` label. O(1) per action, but it introduces a second read-state
authority needing precedence rules against per-item unread overrides — more invariants than it
removes, for rows that are already cheap.

## 3. The local cap silently deleted unread articles

Past 100 items a feed's older entries vanished with no trace and no way to page them back, even
though D1 keeps everything. Eviction from a cache is fine; eviction from the only _visible_ copy is
indistinguishable from data loss, and that is what the reporter experienced.

**Now:** `GET /api/v2/feeds/fetch?offset=K` pages below the local window, surfaced as a quiet "Show
older" at the end of a single-feed list with one line of copy. Those items are deliberately
**transient** — never merged into the capped Dexie set, because merging would push the local set
past K and re-open §1. Separately, items carrying a tag or a highlight are now exempt from eviction
alongside starred ones, so eviction can't orphan an annotation. Unread is deliberately **not**
exempt: that would let each device's set grow without bound and diverge again.

## 4. The label delta could lose rows silently

Four defects, all in the same "the cursor moved past something you never got" family:

- **Same-second loss.** Both deltas used `updated_at > since` against a one-second-resolution
  cursor, so any row written in the same wall-clock second as the cursor's max was dropped and never
  offered again. The cursor is now compound `(updated_at, id)` — base64 `updatedAt:id`, the encoding
  the label pagination cursor already used — which makes strictly-greater safe. Legacy numeric
  cursors are read as `(seconds, 0)`, re-delivering that one second exactly once; application is an
  idempotent upsert, so the cost is nil and the backend can deploy ahead of the frontend as usual.
- **Unpaginated read delta.** `GET /api/reading/positions` was `LIMIT 100000, ORDER BY updated_at
DESC` with no `hasMore`. Had it ever truncated, the client would have advanced its forward-only
  cursor to the newest row it saw and permanently skipped the older tail. It is now an ordinary
  paged, ascending delta the client drains.
- **Cursors committed before the write.** Both deltas persisted their cursor in a separate `try`
  from the Dexie write, so a failed write lost the batch and still advanced past it. The cursor now
  moves only on the success path.
- **Mixed time units.** Local labels stored `updatedAt` in ms, delta-written ones in unix seconds —
  a factor of a thousand between two values that were being compared. Converted once, at the
  boundary (`localTimestamps`); the store's invariant is milliseconds everywhere.

## 5. Last-write-wins was by HTTP arrival, not by user time

Every label write blindly overwrote, so the winner was whichever request landed last. A device
draining an offline queue an hour late therefore resurrected superseded intent — re-marking unread
something the user had since read elsewhere.

**Now:** `client_updated_at` (unix ms, migration `0076`) on every row, clamped server-side to now.
Every write path takes an optional `updatedAt` and the upsert is conditional:

```sql
ON CONFLICT(…) DO UPDATE SET … WHERE excluded.client_updated_at >= COALESCE(client_updated_at, 0)
```

`>=` rather than `>` so an idempotent retry still lands. The soft-delete paths carry the same guard,
so stale intent can't win in either direction. Clients send the sync queue's own enqueue time — the
moment the user acted. `updated_at` (server seconds) keeps its job unchanged as the delta cursor, so
the sync stream stays arrival-ordered and monotonic; `client_updated_at` is only the tiebreaker.

**Clock skew:** clamping bounds forward skew. A backward-skewed device loses ties, which is exactly
today's arrival-ordered behaviour — no regression, and it can't pin a row against every other
device the way an unclamped future timestamp could.

Inbound, `planReadDelta` applies the same comparison: a tombstone older than the local read label is
dropped, and a live row older than a local un-read is dropped (the un-read intent is remembered in a
small expiring map, since removing the label leaves nothing to compare against). A backend that
sends no `client_updated_at` degrades to the previous in-flight-only guard rather than guessing.

## 6. An open tab never saw another device's changes

Labels were pulled at app init, on manual refresh, on tab-visible-and-≥30-minutes-stale, and via
Chromium periodic background sync. The `online` event only drained the outbound queue. So a laptop
left open all afternoon showed its own reading and nobody else's.

**Now:** `itemLabelsStore.pullDelta()` also runs on `online` (after the queue drains, so our own
writes are already reflected in what comes back), on `visibilitychange`, and on a 5-minute
while-open timer — all gated to one pull a minute, all skipped when hidden or offline. A no-change
delta is one indexed query returning zero rows.

No push channel, deliberately: the delta is cheap, and the product is calm.

## 7. readProgress could move backwards and republish itself

The delta overwrote local progress unconditionally while a two-stage 500 ms debounce might still be
pending; the debounced push then won server-side. Merging is now by `props.lastReadAt` on both
sides, and the flush re-checks what is actually stored before writing. `lastReadAt` is the ordering
and `paragraphIndex` never is — position legitimately moves backwards on a re-read, and treating
"further along" as "newer" would make re-reading impossible to sync. The change guard also no longer
drops `totalParagraphs`-only updates, which is how an article's first (wrong) denominator used to
stick.

## Scope

standard.site documents ride the same label table and delta, so §4–§7 cover them. Their _membership_
is already authoritative (per-scope digest reconciliation), so §1–§3 are RSS-only. This answers the
maintainer's question on the thread: the persistent-divergence mechanism was the RSS window; the
staleness and LWW defects affected both.

**Deliberately out of scope**, listed so none reads as an oversight: per-highlight tombstones (union
merge can still resurrect a single deleted highlight — the documented gap in `itemLabels.svelte.ts`),
any push/real-time channel, and per-user timeline materialization.

## Verification

- `backend/test/unread-window.spec.ts` — K on cold start, counts over the window, mark-feed-read
  (scope, `beforeSeq`, idempotence, subscription gating), archive offset paging.
- `backend/test/labels.spec.ts`, `backend/test/reading-positions.spec.ts` — compound cursor,
  same-second delivery, pagination, and the LWW guard in both directions plus clamping.
- `frontend/src/lib/services/readDelta.test.ts` — the newer-local-intent guards and the
  `readProgress` merge; `articleMerge.test.ts` — the eviction exemption.
- `e2e/sync-convergence.spec.ts` — two browser contexts on one account: equal counts, a read on one
  reaching the other, mark-all converging both to zero, user-time LWW, and same-second delivery.

**Before production:** deploy backend first (as usual), run the two-device flow manually on phone +
desktop against staging, and watch `unread_count_drift` and D1 row-reads on the admin ops panel for
a few days. Note that counts may _drop_ for users whose fresh devices previously undercounted
against a 30-item window — that is the fix working.
