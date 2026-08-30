# Skyreader Backend Development Guide

**Important:** Always run `npm run check` before finishing work to verify types and formatting.

## Project Overview

Skyreader backend is a Cloudflare Workers API that serves as a gateway between the frontend and the AT Protocol ecosystem. It handles authentication, the feed timeline, social features, saved articles, labels, and background Jetstream polling.

**Feed reads are served from D1, not the proxy.** The Fly.io proxy is the crawler: it pushes new
and edited items into `feed_items` (`POST /api/internal/ingest`), pulls the set of feeds to
crawl (`GET /api/internal/crawl-set`), and reports which feeds are failing to crawl
(`POST /api/internal/feed-health`) — all authenticated with the shared `FEED_PROXY_SECRET`
(fail-closed when unset). A client refresh is one `GET /api/v2/timeline` — a single query joining
subscriptions and read state. Because reads never touch the crawler, a broken feed just goes quiet;
the health report is the only thing that tells a reader its feed is dead rather than idle, and its
payload is the COMPLETE unhealthy set (recovery = absence from the next report). All three internal
endpoints stamp `sync_state.crawler_heartbeat_at`, and the timeline reports `ingestActive` as the
AND of that heartbeat and `sync_state.timeline_enabled` — the operator's rollout gate. A crawler
heartbeat only says a crawler is attached; it arrives seconds into a backfill that takes hours, so
the gate is what actually admits readers to the archive (and, set back to `'0'`, is the fast
rollback that returns every client to the legacy batch path with no deploy). Either half false and
clients stay on `/batch`; the request short-circuits rather than building a page they will discard.
See `docs/plans/D1_FEED_TIMELINE.md`. The proxy is still on the path for `/api/extract`, feed
discovery, and social context — plus the one crawl per new subscription (`warmFeedIntoArchive`)
and the subscription-gated pull-through in `/api/v2/feeds/fetch`.

**standard.site documents are following feeds into D1.** The JetstreamPoller DO now drains
`site.standard.document` (+ its `app.standard-reader.collection` sidecar) straight into
`documents_v2`, filtered server-side to the subscribed-author DID set; `/api/v2/documents/batch`
and `/api/v2/documents/get` serve from D1 once `sync_state.documents_v2_enabled` is `'1'` and from
the proxy until then, wire-identical either way. Writes have their own switch
(`documents_ingest_enabled`) so a flood can be paused without touching reads or the subscriptions
stream; it stops every background write — the drain, the poller's back catalogues and the cron's
reconcile — leaving only the operator backfill endpoint. Every path that creates an
`atproto.documents` subscription — the API, the Atmosphere subscribe button, the Atmosphere graph
import, the PDS→local subscription pull, and a subscription mirrored in by the poller — goes
through `ensureAuthorDocuments`, because a subscription whose author was never listed serves
`status:'error'` on every poll until something lists them. (Those subscribe/sync paths are
deliberately **not** gated by `documents_ingest_enabled`: a reader subscribing during an incident
should still see their linkblog, and each walk is one author, deduped to one an hour. The switch
governs the background loops — the drain, the poller's queue, the cron's reconcile.)

**The budget everything here is sized against** is `D1_QUERIES_PER_INVOCATION`: 1,000 per Worker
invocation, counting each statement inside a `batch` separately _and_ sharing that ceiling with
outbound `fetch()`es (it is the read-subrequest limit), so `document-store.ts` counts both as
subrequests. A `QueryLedger` is per invocation, not per loop: the cron's two reconcile passes
share one, the operator endpoint's batch shares one, and `/api/sync` threads one through both of
its halves so the walks it schedules are admitted against what the request has already spent.
Each fan-out asks `canAffordBackfill` before starting an author and leaves the rest in the
reconcile queue rather than throwing halfway through a walk that has already written rows.
`BACKFILL_QUERY_COST` is a true worst case — every per-row term is either one statement (the
prune is a single `updated_at`-scoped DELETE; the sidecars are one read plus one capped batch) or
capped (`MAX_SITE_RESOLVES_PER_BACKFILL`, `MAX_COLLECTION_WRITES_PER_BACKFILL`). The same ceiling
is why an applied event costs a single statement: the cap eviction and bookkeeping settle once per
author at the end of a cycle. **Still unbounded:** the PDS→local subscription pull's insert batch
is one statement per restored row, capped only by the plan's mirror limit (1000/5000), so a very
large restore can exhaust the invocation on its own — it charges the ledger (which is what stops
walks being scheduled on top of it) and logs `subscription_pull_batch_large`, but nothing chunks
it. See `docs/plans/DOCUMENTS_TO_D1.md` and RUNBOOK §4e.

## Key Concepts

### AT Protocol Basics

- **DID**: Decentralized Identifier (e.g., `did:plc:abc123`) - permanent user ID
- **Handle**: Human-readable username (e.g., `user.bsky.social`)
- **PDS**: Personal Data Server - where user data is stored
- **Lexicon**: Schema definition language for record types (like JSON Schema)
- **NSID**: Namespaced identifier for schemas (e.g., `app.skyreader.feed.subscription`)

### OAuth Requirements

AT Protocol OAuth has specific requirements:

- **PKCE**: Required for all flows (S256 challenge)
- **DPoP**: Demonstrating Proof of Possession - tokens are bound to a key pair
- **Nonce**: Auth servers may require nonce in DPoP proofs (handle `use_dpop_nonce` error)

**Local Development:** Uses AT Protocol's [localhost client exception](https://atproto.com/specs/oauth#localhost-client-development) - a public client flow with virtual metadata, no tunnel or signing keys needed.

**Production:** Uses confidential client with `private_key_jwt` authentication. The `client_id` URL (`/.well-known/client-metadata`) must be publicly fetchable.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed documentation.

### Entry Point

**File:** `src/index.ts`

- Routes requests to handlers
- Adds CORS headers (validates against `ALLOWED_ORIGINS`)
- Checks per-user rate limits
- Handles scheduled triggers (cron)

### Routes

| File                          | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `src/routes/auth.ts`          | OAuth flow (login, callback, logout, client metadata)     |
| `src/routes/timeline.ts`      | `GET /api/v2/timeline` — the whole refresh, one query     |
| `src/routes/ingest.ts`        | Crawler endpoints: item ingest, crawl set, feed health    |
| `src/routes/documents.ts`     | Document backfill + proxy-vs-D1 shadow compare (internal) |
| `src/routes/feeds-v2.ts`      | Single-feed read (D1 + pull-through), discover, docs      |
| `src/routes/social.ts`        | Social feed, popular, grouped, detect-content             |
| `src/routes/shares.ts`        | User shares CRUD (with PDS sync)                          |
| `src/routes/subscriptions.ts` | Subscription CRUD (with PDS sync)                         |
| `src/routes/records.ts`       | PDS record listing                                        |
| `src/routes/reading.ts`       | Article + document read positions (forward delta)         |
| `src/routes/labels.ts`        | Unified item labels (read/starred/archived/tags)          |
| `src/routes/saved.ts`         | Saved articles CRUD                                       |
| `src/routes/integrations.ts`  | Semble/Margin writes to the user's PDS                    |
| `src/routes/settings.ts`      | User settings                                             |
| `src/routes/sync.ts`          | PDS full sync, subscription sync, sync status             |
| `src/routes/lexicons.ts`      | Serve lexicon schemas at /.well-known/lexicons            |
| `src/routes/health.ts`        | `/api/health` (shallow) + `/api/health/deep` (gated)      |
| `src/routes/telemetry.ts`     | `/api/telemetry/error` — sampled client error reports     |
| `src/routes/guest.ts`         | `/api/guest/*` — the unauthenticated reading surface      |

Guest reading mode is the only unauthenticated surface that reads the archive,
and it is **read-only**. `POST /api/guest/timeline` is a query over
caller-supplied feed URLs (≤50) that never fetches; the starter channels in
`src/config/starter-feeds.ts` are unioned into `GET /api/internal/crawl-set`, so
the curated feeds stay crawler-fresh with no subscriber behind them.

Adding a source needs an account, which is what keeps that invariant simple: the
only feeds a guest can name are ones the crawler already owns, so no
unauthenticated path can steer a fetch at a caller-chosen URL and nothing
relaxes the `callerSubscribes` rule in `feeds-v2.ts`. Preserve that if you ever
reopen guest adds — an earlier version had a bounded warm endpoint, and its
bounds (per-IP rate, a per-feed freshness claim, a global daily ceiling, and an
orphan reaper) all existed to contain exactly that one write path. See §4f of
[`docs/RUNBOOK.md`](../docs/RUNBOOK.md).

Integration writes are gated per-capability, not per-app: `POST /api/integrations/semble/connections`
(a `network.cosmik.connection` edge between two URLs) checks `SEMBLE_CONNECTION_SCOPES`, which is
deliberately **not** part of `SEMBLE_SCOPES` — folding it in would 403 every existing user's card
saves until they re-authed. `GET /api/integrations/status` reports the two separately
(`scopeStatus.semble` vs `scopeStatus.sembleConnections`). Same pattern as `PCKT_SCOPES` /
`ATMOSPHERE_SCOPES`; see `src/config/scopes.ts`.

### Services

| File                                | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `src/services/oauth.ts`             | PKCE, DPoP, handle resolution, session management            |
| `src/services/feed-parser.ts`       | RSS/Atom/RDF parsing                                         |
| `src/services/feed-proxy-client.ts` | Client for Fly.io feed proxy                                 |
| `src/services/standard-site.ts`     | standard.site record mapping, digest, publication cache      |
| `src/services/document-store.ts`    | The D1 document store: apply, backfill, reconcile, serve     |
| `src/services/document-flags.ts`    | `documents_v2_enabled` / `documents_ingest_enabled` switches |
| `src/services/pds-client.ts`        | PDS API client                                               |
| `src/services/client-auth.ts`       | Confidential client auth helpers                             |
| `src/services/share-sync.ts`        | Push/delete shares to/from PDS                               |
| `src/services/subscription-sync.ts` | Sync subscriptions to/from PDS                               |
| `src/services/rate-limit.ts`        | Per-user per-endpoint rate limiting (D1-backed)              |
| `src/services/user-tier.ts`         | Tier lookup (free/supporter)                                 |

### Observability

| File                               | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `src/observability/sentry.ts`      | SDK options + the `reportError()` wrapper every call site uses |
| `src/observability/scrub.ts`       | `beforeSend` credential scrubbing (keeps DIDs, drops tokens)   |
| `src/observability/heartbeat.ts`   | Dead-man's-switch ping for the every-minute cron               |
| `src/observability/ops-metrics.ts` | What the cron records to D1 for the admin's ops panel          |
| `src/utils/logger.ts`              | `log.info('event', { … })` — structured, queryable log lines   |
| `src/utils/request-context.ts`     | Request id / route / DID in AsyncLocalStorage                  |

Error reporting goes through `reportError()` (exceptions) or `reportMessage()`
(threshold crossings, with a fingerprint so a persistent condition is one issue),
never `Sentry.captureException` directly, so the vendor stays a one-file decision.

Logging: use `log.*` with a stable low-cardinality `event` slug and put the details
in fields. Workers Logs indexes the fields of a logged object but treats a string
as opaque text, so `log.info('feed_ingested', { itemCount })` is queryable and an
interpolated `console.log` sentence is not. Never log a credential — there is no
redaction layer on this path.

The request id is ambient (`getRequestId()`), so nothing has to thread it: it lands
on every log line, every `reportError()` tag, the `X-Request-Id` response header,
and outbound feed-proxy calls.

The every-minute cron also _records_: poller lag and cron liveness to
`system_status`, the proxy's cache stats every 5th minute, and an hourly row in
`metrics_snapshots` (pruned at 90 days). The admin renders those tables directly.
The snapshot's counts come from D1 (`users`, `feeds`, `feed_items`, …) and its
health numbers from the `system_status` rows — including `feeds_with_errors`,
which is the crawler's `feedsInError` and is recorded NULL, not 0, when the proxy
row is stale. Recording failures never withhold the cron heartbeat — losing a data
point is not an outage; see the note on `runRecordingStep()`.

The browser reports its own errors to `/api/telemetry/error` (unauthenticated by
design — an error on the login screen counts, and the route is answered before
session resolution so a degraded D1 can't turn the report into a 500). That route is the only thing that
talks to Sentry on the client's behalf: no SDK ships in the frontend bundle, and
every field the client sends is length-capped and validated against a closed set
of `kind`s before it becomes a log line or a Sentry tag.

Alert thresholds, SLOs, alert policy, secrets, log queries, and incident
procedures: [`docs/RUNBOOK.md`](../docs/RUNBOOK.md).

### Durable Objects

| File                                      | Purpose                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `src/durable-objects/jetstream-poller.ts` | Two Jetstream streams (subscriptions, documents) drained per alarm |

### Storage

**D1 Database** (all storage is in D1, no KV):

Key tables:

- `users` - User profiles (did, handle, tier, timestamps)
- `sessions` - Server-side sessions (tokens, DPoP key, expiry)
- `subscriptions_cache` - Cached feed subscriptions from PDS
- `shares` - Aggregated share data from Jetstream
- `feeds` - One row per crawled feed (title/site/image + `last_ingest_at`), plus the crawler's
  health verdict: `error_count`/`last_error`/`next_retry_at`/`last_fetch_at` (unix seconds), which
  the timeline serves to readers as `feedHealth`, and `crawl_stale` for a feed the crawler isn't
  reaching at all (operator-only; the admin alarms on it). `last_ingest_at` is publishing cadence,
  NOT health — it only moves when a fetch yields a new item
- `feed_items` - The feed archive the timeline serves: every item the crawler has ever pushed,
  keyed `(feed_url, guid)` with a monotonic `seq`. Never pruned in ordinary operation — see
  `docs/plans/D1_FEED_TIMELINE.md`
- `documents_v2` - One row per `site.standard.document` record: the raw record (`record_json`)
  plus the scalars the serve path queries on. Written by the poller and by backfill, capped at 100
  rows per author
- `collections_v2` - `app.standard-reader.collection` sidecars (curated magazine editions), paired
  to their document by rkey, with the resolved item previews persisted after the first read
- `publications_cache_v2` - Publication base URL / icon / name / theme / fonts, 24h TTL and a 5m
  negative TTL. Replaces 0031's `publications_cache`, whose `base_url` is NOT NULL and so can't
  hold a negative entry
- `document_authors` - Per-author ingest bookkeeping: last successful list (drives the reconcile
  queue), whether the last list saw the author's whole repo, and the last backfill error with its
  timestamp — a failed list holds that author out of the reconcile queue for a doubling backoff, so
  an author nobody can list (deleted account, dead PDS) can't monopolise the only self-heal there is
- `documents` / `publications_cache` - orphaned from the pre-proxy era; still not read or written.
  They stay until the proxy document path is decommissioned
- `item_labels_cache` - Unified labels (read/starred/archived/tags)
- `saved_articles` - Saved/bookmarked articles
- `social_read_positions_cache` - Legacy social read tracking (superseded; document
  reads now live in `item_labels_cache` as `item_type='document'`/`label='read'`)
- `user_settings` - User preferences
- `rate_limits` - Per-user rate limiting
- `sync_state` - Jetstream cursor, the archive generation token, the crawler heartbeat,
  `timeline_enabled` (the rollout gate: only an explicit `'0'` holds clients on the batch path),
  and the document switches: `documents_v2_enabled` (reads from D1; only an explicit `'1'`),
  `documents_ingest_enabled` (the poller's document stream; only an explicit `'0'` stops it) and
  the `documents_apply_cap` override
- `system_status` - Cron-written health board (cron liveness, poller lag, proxy stats)
- `metrics_snapshots` - Hourly trend points behind the admin's sparklines (90-day retention)

## Common Tasks

### Adding a New API Endpoint

1. Create handler in `src/routes/`
2. Add route case in `src/index.ts`

### Adding a New Lexicon

1. Add schema in `lexicons/app/skyreader/`
2. Add handler support in the appropriate route file

### Debugging OAuth Issues

1. Use `npx wrangler tail` to stream backend logs
2. Common errors:
   - `use_dpop_nonce`: Need to retry with nonce from response header
   - `invalid_client_metadata`: client_id URL not accessible or metadata invalid (production only)

## Environment Variables

### wrangler.toml

```toml
[vars]
FRONTEND_URL = "https://skyreader.app"
ALLOWED_ORIGINS = "https://skyreader.app,https://staging.skyreader.app,..."
FEED_PROXY_URL = "https://skyreader-feed-proxy.fly.dev"

SENTRY_ENVIRONMENT = "production"   # "staging" in [env.staging]

# Secrets (set via `wrangler secret put`):
# FEED_PROXY_SECRET   - shared with the Fly.io proxy, both directions: outbound
#                       proxy calls and the inbound crawler endpoints
#                       (/api/internal/ingest, /api/internal/crawl-set), which
#                       are fail-closed when it is unset
# SENTRY_DSN          - error reporting (unset ⇒ silent no-op)
# HEARTBEAT_URL       - dead-man ping for the every-minute cron
# HEALTH_CHECK_SECRET - gates /api/health/deep (X-Health-Secret header)
#
# GIT_COMMIT_SHA is passed by CI at deploy time (`--var GIT_COMMIT_SHA:<sha>`)
# and reported by /api/health; a manual deploy reports "dev".
```

## Local Development Setup

### D1 Database Setup

1. Create your own D1 database: `npx wrangler d1 create skyreader`
2. Copy the `database_id` from the command output
3. Replace `YOUR_D1_DATABASE_ID` in `wrangler.toml` with your database ID
4. Run migrations: `npx wrangler d1 migrations apply skyreader --local`

For staging, create a separate database with `npx wrangler d1 create skyreader-staging` and update the staging `database_id`.

## Deployment Checklist

1. Create D1 database: `npx wrangler d1 create skyreader`
2. Update `wrangler.toml` with database ID
3. Run all migrations: `npx wrangler d1 migrations apply skyreader --remote`
4. Set secrets: `npx wrangler secret put FEED_PROXY_SECRET`
5. Deploy: `npx wrangler deploy`
6. Verify: `curl https://your-api.workers.dev/.well-known/client-metadata`

## Lexicon Schemas

Located in `backend/lexicons/app/skyreader/`:

```
feed/subscription.json      - RSS feed subscription
  - feedUrl (required)
  - title
  - category
  - tags[]
  - createdAt (required)

feed/saved.json             - Saved article
  - url (required)
  - title, description, author, domain, image
  - contentType, fullContent, wordCount
  - publishedAt, savedAt (required)
```
