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
  `getReadKeys` is never called on the feed path. Every response carries `ingestActive`, derived
  from the heartbeat: false means this deployment has no crawler filling D1, and clients stay on
  the legacy batch path. A cursor above the archive head cold-starts (rewound-archive guard).
- `GET /api/v2/feeds/fetch` re-backed with D1 + **pull-through**: if a feed isn't in the archive
  yet (first subscriber), fetch it from the proxy once, ingest it, then serve. The pull-through is
  gated on the caller's own subscription, so the shared never-pruned archive can't be written with
  arbitrary feeds. Subscribe time already crawls + ingests the feed (`warmFeedIntoArchive`, which
  replaced the old warm-and-discard), so the pull-through is normally not needed at all.

**Proxy** (`feed-proxy/`)

- `ingest-push.ts`: the durable log _is_ the outbox. `push_state(seq, pushed_hash)` marks what has
  been delivered; a row is dirty when it's missing there or the hashes differ (race-free against a
  mid-flight edit). Seq-ordered batches of 100 every 15 s, capped exponential backoff on failure.
- Crawl-set pull every 5 min: registers each feed's `cache` row and stamps `last_requested_at`, so
  the existing warm loop / active window / eviction machinery keeps working now that read traffic
  no longer stamps anything.
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

**Admin** (`admin/`) — feed health is re-pointed at `feeds`/`feed_items`: crawled feeds, subscribed
feeds not ingesting (the R1 alarm), archived item count, estimated archive size with a 6 GB alert,
and a churn detector for feeds nearing the sanity cap.

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

The heartbeat means a crawler is attached; it does **not** mean the initial archive backfill is
complete. After enabling prod, watch `/stats` and wait for `ingest.pending` to trend to ~0 before
announcing the rollout. New or cleared clients remain correct while it drains, but their first cold
start can be sparse and will fill in over subsequent syncs.

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

## Known scaling knob

The incremental drain scans the `feed_items` rowid range above the caller's cursor and probes the
subscription set per row, so its cost tracks **global** ingest above the cursor rather than the
caller's own new items: a 5-feed reader returning after a week pays for everything the whole system
ingested that week. That is the accepted fan-out-on-read trade at ~1,330 feeds. If D1 row-reads or
CPU ever become the constraint, bound the scan with per-feed `(feed_url, seq)` seeks against the
subscription set (`idx_feed_items_feed_seq` already supports them) rather than materializing
per-user timelines.
