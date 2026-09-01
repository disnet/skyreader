# D1-Served Feed Timeline (ingest-push architecture)

> Supersedes, in part, `RETENTION_SYNC_PLAN.md`. That plan made the Fly proxy a durable item
> log with a monotonic cursor and it stays exactly as built — but its **serving** role moves
> to D1. The proxy is now the **crawler and outbox**; D1 is the **archive and read path**.

## What changed

A refresh used to be `1 + ceil((N−8)/50)` sequential `POST /api/v2/feeds/batch` calls, each
hopping Worker → Fly proxy and then paying `ceil(GUIDs/88)` sequential D1 queries to annotate
read state (`getReadKeys`). Now:

```
                 ┌────────────── crawl set (pull, every ~5 min) ──────────────┐
                 ▼                                                            │
  Fly proxy (crawler only)                    Cloudflare Worker + D1 (serving store)
  ┌──────────────────────────┐   push deltas   ┌──────────────────────────────────────┐
  │ warm loop / etag /       │ ──────────────▶ │ POST /api/internal/ingest            │
  │ backoff / UA fallback    │  (at-least-once,│   upsert feeds + feed_items          │
  │ feed_items = outbox      │   seq order,    │   (archive: no pruning; sanity cap)  │
  │  (bounded, K = 200)      │   ONE target)   │                                      │
  └──────────────────────────┘                 │ GET /api/v2/timeline?since_seq=&…    │
                                               │   ONE query: feed_items ⋈ subs ⋈ read│
  Client ◀───────────────── one paged request ─┴──────────────────────────────────────┘

           (× 2: one such pair for prod, one for staging — no cross-links)
```

- **Reads never touch Fly.** If the Fly box is down, refresh still works from D1 (freshness
  stalls, serving doesn't).
- **D1 is the archive; the proxy log is a window.** The proxy keeps its K = 200 recent items per
  feed as a delivery buffer; D1 keeps everything it has ever ingested. Prod D1 is therefore the
  system of record for feed history — its Time Travel / export story matters.
- The proxy keeps `/extract`, `/discover`, `/documents`, `/social-context`, `/mentions`, and the
  single-feed `/feed` (now only for subscribe-time pull-through).

## Shipped in this change

**Backend** (`backend/`)

- Migration `0068_feed_timeline.sql`: drops the dormant pre-Fly trio (`feed_items`, `feed_cache`,
  `feed_metadata` — zero references in `src/`), creates `feeds` + `feed_items` (AUTOINCREMENT
  `seq`, `UNIQUE(feed_url, guid)`, `content_hash NOT NULL`), the `(user_did, feed_url)`
  subscription index, and mints `sync_state.items_generation`.
- `routes/ingest.ts`: `POST /api/internal/ingest` and `GET /api/internal/crawl-set`, both
  authenticated by a constant-time compare against `FEED_PROXY_SECRET` and **fail-closed** when
  it is unset. Idempotent upsert (edit-in-place keeps the seq), per-item content cap
  (`MAX_ITEM_CONTENT_BYTES = 8 KB`, drops `content` and sets `contentTruncated`), and the per-feed
  `SANITY_CAP = 5000` trim — the only pruning that ever runs. Both endpoints stamp a **crawler
  heartbeat** (`sync_state.crawler_heartbeat_at`); the crawl-set pull runs every 5 minutes, so the
  stamp is fresh even when no feed produced an item.
- `routes/timeline.ts`: `GET /api/v2/timeline?since_seq=&generation=&limit=&cold_offset=` —
  incremental drain (cursor derived from returned rows, `hasMore` via `limit+1`) and a **paged**
  per-feed newest-30 cold start (feeds walked in a stable order, `COLD_START_MAX_ITEMS` per page,
  continuation via `nextColdOffset`). Read state is an `EXISTS` probe in the same query;
  `getReadKeys` is never called on the feed path. Every response carries `ingestActive` — the AND of
  a fresh crawler heartbeat (this deployment has a crawler filling D1) and the `timeline_enabled`
  rollout gate (an operator has admitted readers to it; see Phase 4). False on either half means
  clients stay on the legacy batch path, and the request short-circuits rather than building a page
  they will discard. A cursor above the archive head cold-starts (rewound-archive guard).
- `routes/ingest.ts` also serves `POST /api/internal/feed-health`: the crawler's periodic report of
  every feed it currently considers broken, which the timeline hands to readers. On the batch path
  a failing feed came back with `status: 'error'` inline; reads no longer touch the proxy, and a
  broken feed pushes no items, so without this a dead feed and a quiet feed look identical to the
  client. The payload is the **complete trouble set, not a delta** — recovery is inferred from a
  feed's absence, so nothing has to announce that it started working. `feeds` carries the state
  (`error_count`, `last_error`, `last_error_at`, `next_retry_at`, `last_fetch_at`, `crawl_stale`,
  migration `0070`), and a report inserts rather than assumes a row, because a feed broken from its
  first crawl has never ingested an item. Two distinct faults ride the same report: `error_count`
  (the fetch fails — readers see this) and `crawl_stale` (the feed is in the crawl set but going
  unfetched for hours — an operator signal only, invisible to readers and deliberately excluded from
  `feed_health_rev` so crawl-capacity churn can't make every client re-download the payload).
- `GET /api/v2/feeds/fetch` re-backed with D1 + **pull-through**: if a feed isn't in the archive
  yet (first subscriber), fetch it from the proxy once, ingest it, then serve. The pull-through is
  gated on the caller's own subscription, so the shared never-pruned archive can't be written with
  arbitrary feeds. Subscribe time already crawls + ingests the feed (`warmFeedIntoArchive`, which
  replaced the old warm-and-discard), so the pull-through is normally not needed at all. The
  response carries the feed's `health` when it has any, and a successful pull-through clears it
  (`clearFeedHealth`) — that path _is_ the user's "retry this feed" action, so it must show a result
  now rather than after the crawler's next report.

**Proxy** (`feed-proxy/`)

- `ingest-push.ts`: the durable log _is_ the outbox. `push_state(seq, pushed_hash)` marks what has
  been delivered; a row is dirty when it's missing there or the hashes differ (race-free against a
  mid-flight edit). Seq-ordered batches of 100 every 15 s, capped exponential backoff on failure.
- Crawl-set pull every 5 min: registers each feed's `cache` row and stamps `last_requested_at`, so
  the existing warm loop / active window / eviction machinery keeps working now that read traffic
  no longer stamps anything.
- A feed-health report rides the same 5-minute timer, sent right **after** the crawl-set pull so a
  feed registered this cycle is already in the set. `selectFeedHealth` reads the crawl-set `cache`
  rows that are either erroring (`error_count > 0`) or unfetched for `CRAWL_STALE_MS` (2 h — the
  warm loop works on a minutes-long cadence, so hours means the feed is losing its turn every tick),
  converting its millisecond timestamps to seconds once, at this boundary.
- `INGEST_URL` unset ⇒ both loops disabled. `push_state` cascades on the K = 200 cap trim, the
  redelivery delete, and `cleanupCache` eviction. `/stats` reports `ingest.{items,pushed,pending}`.

**Frontend** (`frontend/`)

- `feedFetcher.fetchAllFeeds` prefers one `GET /api/v2/timeline` (plus drain pages) with a single
  global cursor in Dexie `metadata` (`timelineCursor`). Pure helpers live in `timelineSync.ts`.
- Falls back to the legacy `/api/v2/feeds/batch` path when the timeline 404s (old or rolled-back
  backend) **or** whenever the server reports `ingestActive: false`. The cursor is never committed
  in that case. (An `ingestActive`-less backend keeps the old empty-cold-start heuristic.)
- A paged cold start commits only the FIRST page's cursor, and only after its last page merges, so
  an interrupted bootstrap starts over instead of skipping feeds it never delivered.
- Subscriptions that arrive from another device sit below the global cursor, so each is backfilled
  once through the per-feed endpoint (`backfillMissingSubscriptions`, ≤ 10 per sync, attempts
  recorded in Dexie `metadata.timelineBackfilledFeeds`).
- OPML import backfills via the per-feed endpoint: a freshly imported feed's items sit below the
  global cursor, so only the single-feed path can deliver them. The requests are paced (3 at a
  time, 1 s apart) and no longer force a crawl, so a 250-feed import stays inside the rate limit.
- An article whose body was dropped at ingest (`contentTruncated`) is extracted automatically when
  its card opens, so the reader shows the whole article rather than an RSS summary.
- Per-feed error badges come from the response's `feedHealth` (`reconcileFeedHealth` →
  `feedStatusStore.applyHealthSnapshot`). Absence from that map is what CLEARS an error, so the
  reconcile runs after the "these feeds delivered items, so they're fine" pass and overrides it — a
  cold start replays archived items from feeds that may have broken since. To keep the steady-state
  poll at one query, the payload is only sent when the client's echoed `health_rev` is stale, plus
  unconditionally on a cold start (whose status store may be empty).

**Admin** (`admin/`) — feed health is re-pointed at `feeds`/`feed_items`: crawled feeds, archived
item count, estimated archive size with a 6 GB alert, and a churn detector for feeds nearing the
sanity cap. Health itself is the **crawler's verdict**, not an inference:

- **Subscribed Feeds Erroring** (`error_count > 0`) and **Subscribed Feeds Not Being Crawled**
  (`crawl_stale = 1`) replace the single "Subscribed Feeds Not Ingesting" tile. That tile keyed off
  `last_ingest_at`, which only moves when a fetch yields a NEW item — so it counted every feed that
  simply hadn't published in an hour, warned permanently, and told an operator nothing.
- The Feeds page filters on All / Erroring / Not Crawled / OK, sorts by `error_count`, and shows the
  crawler's actual message, failure count, retry time and last good fetch on the row. `last_ingest_at`
  stays, relabelled "Last Item", as what it really is: publishing cadence.
- The existing "Proxy Feeds in Error" tile and its trend series are untouched. They count the
  proxy's whole cache, orphaned feeds included, and stay sourced from `proxy_stats` so the series
  keeps matching its tile; the new tiles are subscriber-scoped and read D1.

## Operator steps (not code)

### Phase 0 — measure (before enabling prod ingest)

Snapshot prod so the growth math becomes a projection: proxy `feed_items` count and `item_json`
size distribution (drives backfill time and confirms the 8 KB content cap), per-feed new-item
velocity over a sample window (items/day, and it flags existing GUID-churn feeds), and current
refresh request counts from logs (the baseline the win is measured against).

### Phase 3 — provision the staging Fly proxy, then soak

```bash
# 1. Create the app (same org as skyreader-feed-proxy)
fly apps create skyreader-feed-proxy-staging

# 2. Create its volume (same region as primary_region; 1 GB is ample for staging)
fly volumes create proxy_data -a skyreader-feed-proxy-staging -r sjc -s 1

# 3. Mint a DISTINCT staging secret (don't reuse prod's — smaller blast radius)
openssl rand -hex 32   # → <STAGING_SECRET>
fly secrets set PROXY_SECRET=<STAGING_SECRET> -a skyreader-feed-proxy-staging

# 4. Set the same value on the staging Worker (it is both the outbound proxy auth
#    and the inbound ingest auth)
cd backend && npx wrangler secret put FEED_PROXY_SECRET --env staging

# 5. First deploy (CI takes over afterwards, on every push to main)
cd feed-proxy && fly deploy --remote-only --config fly.staging.toml
```

Sequencing matters: today's staging Worker authenticates to the **prod** proxy with prod's secret,
so provision + deploy the staging proxy first, then flip `FEED_PROXY_URL` in
`backend/wrangler.toml` (`[env.staging]`, still pointing at the prod proxy on purpose) and rotate
`FEED_PROXY_SECRET` together in one staging Worker deploy. The CI staging Fly job skips itself with
a notice until the app exists, so nothing breaks in the meantime.

Verify: `fly status -a skyreader-feed-proxy-staging` shows exactly **one** machine (the singleton
invariant applies to this app too — never `fly scale count`); `/stats` answers and its
`ingest.pending` trends to ~0; staging D1 `feed_items` counts rise monotonically; the prod proxy's
logs show no staging-origin traffic.

**Then enable prod:** uncomment `INGEST_URL` in `feed-proxy/fly.toml` and cut a release. Prod's
backfill drains through the normal pusher loop (≤ 200 × active feeds at 100 items / 15 s). Until
that happens, prod clients keep using the legacy batch path automatically: with no crawler pushing,
nothing stamps `crawler_heartbeat_at`, so `/api/v2/timeline` answers `ingestActive: false` and no
client commits a cursor. That signal is server-side on purpose — subscribe-time ingest and the
pull-through both write to the archive, so "the archive is empty for this user" would stop being
true long before the crawler existed.

### Phase 4 — open the gate

The heartbeat means a crawler is attached; it does **not** mean the initial archive backfill is
complete, and the first stamp lands _seconds_ after the release (the proxy pulls the crawl set
immediately at boot). On its own it would therefore switch every reader onto the timeline at the
moment the archive is emptiest, and each of them would then drag the entire backfill through the
incremental drain — the fan-out-on-read scan at its worst case, for the hours the drain takes,
surfacing back-catalogue items as unread along the way.

`sync_state.timeline_enabled` (migration `0071`) separates the two. `ingestActive` is the AND of a
fresh heartbeat and this flag, so:

1. Enable `INGEST_URL`; the crawler fills the archive while every client stays on the batch path.
2. Watch `/stats` until `ingest.pending` trends to ~0.
3. Open the gate — one `UPDATE sync_state`, no deploy (commands in
   [`RUNBOOK.md` §4d](../RUNBOOK.md)). Clients switch on their next poll.

Only an explicit `'0'` gates; an absent row means enabled, so a hand-built schema or a future
environment is never silently held back. The migration writes `'0'` for a database that already has
users, so prod and staging start shut while local dev, e2e and CI start open.

Setting it back to `'0'` is the **fast rollback for the read path** — every client returns to the
batch path at its next poll, with no Worker deploy and no waiting out the 30-minute heartbeat
freshness window, and the crawler keeps ingesting throughout. A gated timeline request
short-circuits: it answers with the state and an empty page rather than building one the client is
about to discard, so the gated window costs one `sync_state` read per poll.

### Phase 5 — cleanup (a later release, once no legacy traffic remains)

Remove `/api/v2/feeds/batch`'s proxy passthrough + its `getReadKeys` call (keep it for documents),
the proxy's `POST /feeds` batch read endpoint, the `since_guids`/`since_seq` client plumbing, Dexie
`feedCursors`, `liveDb.getRecentGuids`, and `fetchAllFeedsViaBatch`. Optionally add an hourly cron
step deleting `feeds`/`feed_items` rows whose feed has had **zero active subscribers for > 90 days**
— the one deliberate deletion path, and skippable if even orphans should stay.

## Invariants worth keeping

- **The incremental cursor comes from returned rows, never `MAX(seq)`** — the latter races ingest
  and silently skips rows. A cold start is the one exception, and only because it reads the head
  BEFORE its per-feed slices: anything ingested while it pages lands above that head and arrives on
  the next poll.
- **The heartbeat and the gate answer different questions.** "Is a crawler attached?" is not "is
  the archive ready for readers?" — the first stamp arrives seconds into a backfill that takes
  hours. Anything that collapses the two back into one signal reintroduces a rollout where every
  client switches at the emptiest moment and then drains the entire backfill.
- **Any D1 restore bumps `items_generation`** (one `UPDATE sync_state`): Time Travel rewinds seqs
  while the token would otherwise stay the same. The timeline also self-heals a cursor that sits
  above the head by cold-starting that client, so a forgotten bump degrades to one extra cold start
  rather than a silent, permanent stall.
- **Per-feed recency comes from `published_at`, then `seq`.** A proxy feed is newest-first, so each
  ingest call still writes oldest→newest. But subscribe-time pull-through and the crawler backlog
  can interleave, making archive `seq` different from publication order; per-feed slices must remain
  correct in that case. Incremental delivery continues to use `seq` as its cursor.
- **Writes to the archive need a subscription.** Ordinary ingest deletes nothing, so every
  user-triggered write path (subscribe-time ingest, the pull-through) is gated on the caller's own
  subscription list.
- **The pusher sends `cache.url`**, the registered URL, never a post-redirect one: the timeline
  joins on that exact string.
- **Ordinary ingest deletes nothing.** A feed at the sanity cap is a bug signal (GUID churn), not
  steady state — investigate the feed rather than letting it rotate.
- **A health report is the whole trouble set, never a delta.** Recovery is inferred from absence,
  so a partial report silently marks feeds healthy. The recovery sweep is a set difference against
  the currently flagged feeds (small, partially indexed) rather than a `NOT IN` list of every
  healthy feed, which at ~1,300 feeds is the bound-parameter wall `/batch` already hit once.
- **`last_ingest_at` is publishing cadence, not health.** It only moves when a fetch produces a new
  or edited item, so a healthy monthly newsletter looks identical to a feed that 404s. Anything
  asking "is this feed alive?" has to read `error_count` / `crawl_stale`, which is exactly what the
  admin's old stale-ingest alarm got wrong.
- **`nextRetryAt` is milliseconds everywhere the client sees it.** The crawler computes it as
  `Date.now() + backoff`; D1 stores seconds like the rest of the backend and converts back on the
  way out. Rescaling it a second time is what put every retry ~50,000 years out and made
  `canFetch` retire a feed permanently after one transient error.
- **One K, enforced in three places.** `ARTICLE_WINDOW_PER_FEED` (`backend/src/config/window.ts`)
  is the cold start's per-feed slice, the window the server's `unread_counts` are computed over, and
  the client's `MAX_ARTICLES_PER_FEED`. They were 30 / — / 100, which meant a fresh device and an
  established one were counting unread over different sets: the same feed showed different numbers
  on a phone and a laptop no matter how well read state synced, and no amount of sync work could
  have fixed it. Changing one without the others reintroduces exactly that.
- **Unread counts are the server's, not each device's.** `include_counts=1` on the first page of a
  refresh returns a per-feed count over the newest-K window (per-feed index seeks, bounded by
  K × subscriptions). Clients display it when online and fall back to their local derivation
  offline; a mismatch after a completed refresh is reported as `unread_count_drift` telemetry, so
  divergence is something we see rather than something a user reports.
- **Mark-all-read is a server operation.** `POST /api/reading/mark-feed-read` writes read rows for
  the canonical window (≤ K per feed, `beforeSeq` bounding it to what the client saw), because a
  client-side loop can only mark what THAT device holds — leaving items another device held below
  its window unread there.
- **Eviction is not deletion.** D1 still never prunes; the client's per-feed cap is a cache bound.
  `GET /api/v2/feeds/fetch?offset=K` pages below the local window ("Show older"), so an evicted
  unread item is a cache miss rather than something the reader experiences as lost. Starred, tagged
  and highlighted items are exempt from eviction; unread deliberately is not, since exempting it
  would let each device's set grow past K and diverge again.

## Known scaling knob

The incremental drain scans the `feed_items` rowid range above the caller's cursor and probes the
subscription set per row, so its cost tracks **global** ingest above the cursor rather than the
caller's own new items: a 5-feed reader returning after a week pays for everything the whole system
ingested that week. That is the accepted fan-out-on-read trade at ~1,330 feeds. If D1 row-reads or
CPU ever become the constraint, bound the scan with per-feed `(feed_url, seq)` seeks against the
subscription set (`idx_feed_items_feed_seq` already supports them) rather than materializing
per-user timelines.
