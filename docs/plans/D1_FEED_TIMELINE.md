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

- Migration `0061_feed_timeline.sql`: drops the dormant pre-Fly trio (`feed_items`, `feed_cache`,
  `feed_metadata` — zero references in `src/`), creates `feeds` + `feed_items` (AUTOINCREMENT
  `seq`, `UNIQUE(feed_url, guid)`, `content_hash NOT NULL`), the `(user_did, feed_url)`
  subscription index, and mints `sync_state.items_generation`.
- `routes/ingest.ts`: `POST /api/internal/ingest` and `GET /api/internal/crawl-set`, both
  authenticated by a constant-time compare against `FEED_PROXY_SECRET` and **fail-closed** when
  it is unset. Idempotent upsert (edit-in-place keeps the seq), per-item content cap
  (`MAX_ITEM_CONTENT_BYTES = 8 KB`, drops `content` and sets `contentTruncated`), and the per-feed
  `SANITY_CAP = 5000` trim — the only pruning that ever runs.
- `routes/timeline.ts`: `GET /api/v2/timeline?since_seq=&generation=&limit=` — incremental drain
  (cursor derived from returned rows, `hasMore` via `limit+1`) and a per-feed newest-30 cold start.
  Read state is an `EXISTS` probe in the same query; `getReadKeys` is never called on the feed path.
- `GET /api/v2/feeds/fetch` re-backed with D1 + **pull-through**: if a feed isn't in the archive
  yet (first subscriber), fetch it from the proxy once, ingest it, then serve.

**Proxy** (`feed-proxy/`)

- `ingest-push.ts`: the durable log *is* the outbox. `push_state(seq, pushed_hash)` marks what has
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
  backend) **or** when a cold start returns nothing for a subscribed user (the environment's
  crawler isn't pushing yet). The cursor is never committed in that case.
- OPML import now backfills via the per-feed endpoint: a freshly imported feed's items sit below
  the global cursor, so only the single-feed path (with its pull-through) can deliver them.

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
so provision + deploy the staging proxy first, then flip `FEED_PROXY_URL` (already committed) and
rotate `FEED_PROXY_SECRET` together in one staging Worker deploy.

Verify: `fly status -a skyreader-feed-proxy-staging` shows exactly **one** machine (the singleton
invariant applies to this app too — never `fly scale count`); `/stats` answers and its
`ingest.pending` trends to ~0; staging D1 `feed_items` counts rise monotonically; the prod proxy's
logs show no staging-origin traffic.

**Then enable prod:** uncomment `INGEST_URL` in `feed-proxy/fly.toml` and cut a release. Prod's
backfill drains through the normal pusher loop (≤ 200 × active feeds at 100 items / 15 s). Until
that happens, prod clients keep using the legacy batch path automatically — the frontend's
empty-archive fallback covers exactly this window.

### Phase 5 — cleanup (a later release, once no legacy traffic remains)

Remove `/api/v2/feeds/batch`'s proxy passthrough + its `getReadKeys` call (keep it for documents),
the proxy's `POST /feeds` batch read endpoint, the `since_guids`/`since_seq` client plumbing, Dexie
`feedCursors`, `liveDb.getRecentGuids`, and `fetchAllFeedsViaBatch`. Optionally add an hourly cron
step deleting `feeds`/`feed_items` rows whose feed has had **zero active subscribers for > 90 days**
— the one deliberate deletion path, and skippable if even orphans should stay.

## Invariants worth keeping

- **Cursor from returned rows, never `MAX(seq)`** — the latter races ingest and silently skips rows.
- **Any D1 restore bumps `items_generation`** (one `UPDATE sync_state`): Time Travel rewinds seqs
  while the token would otherwise stay the same, so clients would sit above the head forever.
- **The pusher sends `cache.url`**, the registered URL, never a post-redirect one: the timeline
  joins on that exact string.
- **Ordinary ingest deletes nothing.** A feed at the sanity cap is a bug signal (GUID churn), not
  steady state — investigate the feed rather than letting it rotate.
