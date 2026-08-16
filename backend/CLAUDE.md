# Skyreader Backend Development Guide

**Important:** Always run `npm run check` before finishing work to verify types and formatting.

## Project Overview

Skyreader backend is a Cloudflare Workers API that serves as a gateway between the frontend and the AT Protocol ecosystem. It handles authentication, the feed timeline, social features, saved articles, labels, and background Jetstream polling.

**Feed reads are served from D1, not the proxy.** The Fly.io proxy is the crawler: it pushes new
and edited items into `feed_items` (`POST /api/internal/ingest`) and pulls the set of feeds to
crawl (`GET /api/internal/crawl-set`), both authenticated with the shared `FEED_PROXY_SECRET`
(fail-closed when unset). A client refresh is one `GET /api/v2/timeline` — a single query joining
subscriptions and read state. Both internal endpoints stamp `sync_state.crawler_heartbeat_at`, and
the timeline reports `ingestActive` from it: an environment whose proxy has no `INGEST_URL` tells
clients to stay on the legacy batch path instead of reading an archive nothing fills. See
`docs/plans/D1_FEED_TIMELINE.md`. The proxy is still on the path for `/api/extract`, feed
discovery, standard.site documents, and social context — plus the one crawl per new subscription
(`warmFeedIntoArchive`) and the subscription-gated pull-through in `/api/v2/feeds/fetch`.

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

| File                          | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `src/routes/auth.ts`          | OAuth flow (login, callback, logout, client metadata) |
| `src/routes/timeline.ts`      | `GET /api/v2/timeline` — the whole refresh, one query |
| `src/routes/ingest.ts`        | Crawler endpoints: item ingest + crawl set            |
| `src/routes/feeds-v2.ts`      | Single-feed read (D1 + pull-through), discover, docs  |
| `src/routes/social.ts`        | Social feed, popular, grouped, detect-content         |
| `src/routes/shares.ts`        | User shares CRUD (with PDS sync)                      |
| `src/routes/subscriptions.ts` | Subscription CRUD (with PDS sync)                     |
| `src/routes/records.ts`       | PDS record listing                                    |
| `src/routes/reading.ts`       | Article + document read positions (forward delta)     |
| `src/routes/labels.ts`        | Unified item labels (read/starred/archived/tags)      |
| `src/routes/saved.ts`         | Saved articles CRUD                                   |
| `src/routes/settings.ts`      | User settings                                         |
| `src/routes/sync.ts`          | PDS full sync, subscription sync, sync status         |
| `src/routes/lexicons.ts`      | Serve lexicon schemas at /.well-known/lexicons        |
| `src/routes/health.ts`        | `/api/health` (shallow) + `/api/health/deep` (gated)  |
| `src/routes/telemetry.ts`     | `/api/telemetry/error` — sampled client error reports |

### Services

| File                                | Purpose                                           |
| ----------------------------------- | ------------------------------------------------- |
| `src/services/oauth.ts`             | PKCE, DPoP, handle resolution, session management |
| `src/services/feed-parser.ts`       | RSS/Atom/RDF parsing                              |
| `src/services/feed-proxy-client.ts` | Client for Fly.io feed proxy                      |
| `src/services/pds-client.ts`        | PDS API client                                    |
| `src/services/client-auth.ts`       | Confidential client auth helpers                  |
| `src/services/share-sync.ts`        | Push/delete shares to/from PDS                    |
| `src/services/subscription-sync.ts` | Sync subscriptions to/from PDS                    |
| `src/services/rate-limit.ts`        | Per-user per-endpoint rate limiting (D1-backed)   |
| `src/services/user-tier.ts`         | Tier lookup (free/supporter)                      |

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

| File                                      | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `src/durable-objects/jetstream-poller.ts` | Long-running Jetstream firehose connection via alarms |

### Storage

**D1 Database** (all storage is in D1, no KV):

Key tables:

- `users` - User profiles (did, handle, tier, timestamps)
- `sessions` - Server-side sessions (tokens, DPoP key, expiry)
- `subscriptions_cache` - Cached feed subscriptions from PDS
- `shares` - Aggregated share data from Jetstream
- `feeds` - One row per crawled feed (title/site/image + `last_ingest_at`)
- `feed_items` - The feed archive the timeline serves: every item the crawler has ever pushed,
  keyed `(feed_url, guid)` with a monotonic `seq`. Never pruned in ordinary operation — see
  `docs/plans/D1_FEED_TIMELINE.md`
- `documents` / `publications_cache` - orphaned after standard.site document reads moved to the
  feed proxy; retained in place but no longer read or written
- `item_labels_cache` - Unified labels (read/starred/archived/tags)
- `saved_articles` - Saved/bookmarked articles
- `social_read_positions_cache` - Legacy social read tracking (superseded; document
  reads now live in `item_labels_cache` as `item_type='document'`/`label='read'`)
- `user_settings` - User preferences
- `rate_limits` - Per-user rate limiting
- `sync_state` - Jetstream cursor, the archive generation token, and the crawler heartbeat
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
