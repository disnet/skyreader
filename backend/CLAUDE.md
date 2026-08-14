# Skyreader Backend Development Guide

**Important:** Always run `npm run check` before finishing work to verify types and formatting.

## Project Overview

Skyreader backend is a Cloudflare Workers API that serves as a gateway between the frontend and the AT Protocol ecosystem. It handles authentication, RSS feed fetching via a Fly.io proxy, social features, saved articles, labels, and background Jetstream polling.

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
| `src/routes/feeds-v2.ts`      | RSS fetching via Fly.io proxy                         |
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

| File                             | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `src/observability/sentry.ts`    | SDK options + the `reportError()` wrapper every call site uses |
| `src/observability/scrub.ts`     | `beforeSend` credential scrubbing (keeps DIDs, drops tokens)   |
| `src/observability/heartbeat.ts` | Dead-man's-switch ping for the every-minute cron               |
| `src/utils/logger.ts`            | `log.info('event', { … })` — structured, queryable log lines   |
| `src/utils/request-context.ts`   | Request id / route / DID in AsyncLocalStorage                  |

Error reporting goes through `reportError()`, never `Sentry.captureException`
directly, so the vendor stays a one-file decision.

Logging: use `log.*` with a stable low-cardinality `event` slug and put the details
in fields. Workers Logs indexes the fields of a logged object but treats a string
as opaque text, so `log.info('feed_fetched', { feedCount })` is queryable and an
interpolated `console.log` sentence is not. Never log a credential — there is no
redaction layer on this path.

The request id is ambient (`getRequestId()`), so nothing has to thread it: it lands
on every log line, every `reportError()` tag, the `X-Request-Id` response header,
and outbound feed-proxy calls.

Alert thresholds, secrets, log queries, and incident procedures:
[`docs/RUNBOOK.md`](../docs/RUNBOOK.md).

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
- `feed_metadata` - Feed caching metadata (ETags, errors, shard_id)
- `feed_cache` - Parsed feed cache
- `feed_items` - Individual feed items
- `documents` - `site.standard.document` records from follows
- `item_labels_cache` - Unified labels (read/starred/archived/tags)
- `saved_articles` - Saved/bookmarked articles
- `social_read_positions_cache` - Legacy social read tracking (superseded; document
  reads now live in `item_labels_cache` as `item_type='document'`/`label='read'`)
- `user_settings` - User preferences
- `rate_limits` - Per-user rate limiting
- `sync_state` - Jetstream cursor and other sync state

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
# FEED_PROXY_SECRET   - authenticates with the Fly.io feed proxy
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
