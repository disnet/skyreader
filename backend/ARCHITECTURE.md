# Skyreader Backend Architecture

## Overview

The Skyreader backend is a Cloudflare Worker that serves as an API gateway between the frontend and the AT Protocol ecosystem. It handles authentication, the D1-served feed timeline (crawled and pushed by a Fly.io proxy), social features, saved articles, and background Jetstream polling.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND                                       │
│  ┌─────────┐  ┌─────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Login   │  │ Feeds   │  │ Social Feed  │  │ Saved / Labels / Sync  │  │
│  └────┬────┘  └────┬────┘  └──────┬───────┘  └──────────┬─────────────┘  │
└───────┼────────────┼──────────────┼─────────────────────┼────────────────┘
        │            │              │                     │
        ↓            ↓              ↓                     ↓
┌───────────────────────────────────────────────────────────────────────────┐
│                         CLOUDFLARE WORKER                                 │
│                                                                           │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ auth.ts  │  │ timeline.ts  │  │ social.ts     │  │ subscriptions.ts │  │
│  │ OAuth    │  │ D1 timeline  │  │ Social feed   │  │ CRUD             │  │
│  └────┬─────┘  └──────┬───────┘  └───────┬───────┘  └────────┬─────────┘  │
│       │               │                  │                   │           │
│  ┌────┴────┐  ┌───────┴──────┐  ┌────────┴───────┐  ┌───────┴────────┐ │
│  │shares.ts│  │labels.ts     │  │saved.ts        │  │reading.ts      │ │
│  │settings │  │social-reading│  │sync.ts         │  │records.ts      │ │
│  └─────────┘  └──────────────┘  └────────────────┘  └────────────────┘ │
│                              │                                           │
│                              ↓                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                          SERVICES                                   │ │
│  │  oauth │ feed-parser │ feed-proxy-client │ pds-client │ rate-limit  │ │
│  │  share-sync │ subscription-sync │ user-tier │ client-auth            │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ↓                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ STORAGE: D1 (users, shares, sessions, feeds, labels, saved, etc.)  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ CRON (every 1 min): ping JetstreamPoller DO, cleanup rate limits    │ │
│  │                     + hourly: cleanup expired OAuth states/sessions  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ JETSTREAM_POLLER DO: Long-running firehose connection via alarms    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
        │                          │                       ↑
        ↓                          ↓                       │
┌───────────────────┐  ┌───────────────────┐  ┌─────────────────────────┐
│ BLUESKY PDS       │  │ FLY.IO FEED PROXY │  │ JETSTREAM FIREHOSE      │
│ (user's data)     │  │ (crawler)         │  │ (AT Protocol events)    │
└───────────────────┘  └───────────────────┘  └─────────────────────────┘
```

## Entry Point

**File:** `src/index.ts`

The main Worker exports a default object with two handlers:

### `fetch` Handler

Processes all HTTP requests:

1. Validates CORS against `ALLOWED_ORIGINS` (or falls back to `FRONTEND_URL`)
2. Extracts session and tracks user activity (non-blocking)
3. Checks per-user rate limits for authenticated requests
4. Routes to appropriate handler based on pathname
5. Applies CORS headers to response

### `scheduled` Handler

Runs on cron trigger (every minute):

1. **Every minute:** Pings `JetstreamPoller` DO to ensure it's running, cleans up rate limit records
2. **Once per hour (minute 0):** Cleans up expired OAuth states and failed/expired sessions from D1

---

## Routes

### Authentication (`src/routes/auth.ts`)

| Endpoint                       | Method | Auth   | Description                                    |
| ------------------------------ | ------ | ------ | ---------------------------------------------- |
| `/.well-known/client-metadata` | GET    | None   | OAuth client metadata for Bluesky auth servers |
| `/api/auth/login`              | GET    | None   | Initiates OAuth flow, returns auth URL         |
| `/api/auth/callback`           | GET    | None   | Handles OAuth callback, creates session        |
| `/api/auth/me`                 | GET    | Bearer | Returns current user profile                   |
| `/api/auth/logout`             | POST   | Bearer | Revokes tokens and deletes session             |

#### Login Flow

```
User enters handle
       ↓
Resolve handle → DID (DNS TXT or HTTP fallback)
       ↓
Resolve DID → PDS URL (plc.directory or did:web)
       ↓
Fetch auth server metadata from PDS
       ↓
Generate PKCE (code_verifier + S256 challenge)
       ↓
Store OAuth state in D1 (oauth_state table, 10-min TTL)
       ↓
Return auth URL → User redirects to Bluesky
```

#### Callback Flow

```
Receive code + state
       ↓
Validate state from D1
       ↓
Generate DPoP key pair (ECDSA P-256)
       ↓
Exchange code for tokens (with DPoP proof)
       ↓
Retry with nonce if use_dpop_nonce error
       ↓
Verify token.sub matches expected DID
       ↓
Fetch user profile from PDS
       ↓
Create session in D1 (sessions table, 30-day TTL)
       ↓
Upsert user in D1
       ↓
Redirect to frontend with auth exchange code
```

### Feeds (`src/routes/timeline.ts`, `src/routes/ingest.ts`, `src/routes/feeds-v2.ts`)

Reads are served from D1. The Fly.io feed proxy (`FEED_PROXY_URL`) is the crawler: it pushes new and edited items into `feed_items` and pulls the set of feeds to crawl, both authenticated with the shared `FEED_PROXY_SECRET`. A client refresh is one `/api/v2/timeline` request — a single query joining subscriptions and read state. See `docs/plans/D1_FEED_TIMELINE.md`.

| Endpoint                  | Method | Auth   | Description                                  |
| ------------------------- | ------ | ------ | -------------------------------------------- |
| `/api/v2/timeline`        | GET    | Bearer | The whole refresh: items since a cursor      |
| `/api/internal/ingest`    | POST   | Secret | Crawler pushes new/edited items into D1      |
| `/api/internal/crawl-set` | GET    | Secret | Crawler pulls the feeds to crawl             |
| `/api/v2/feeds/fetch`     | GET    | Bearer | Single feed from D1, with proxy pull-through |
| `/api/v2/feeds/batch`     | POST   | Bearer | Legacy batch fetch (fallback path)           |
| `/api/v2/feeds/discover`  | GET    | Bearer | Discover feeds on a website URL              |

### Social (`src/routes/social.ts`)

| Endpoint                     | Method | Auth        | Description                       |
| ---------------------------- | ------ | ----------- | --------------------------------- |
| `/api/social/feed`           | GET    | None/Bearer | Shares from followed users        |
| `/api/social/feed/grouped`   | GET    | None/Bearer | Grouped social feed               |
| `/api/social/popular`        | GET    | None        | Popular shares across all users   |
| `/api/social/detect-content` | GET    | Bearer      | Detect content type of a URL      |
| `/api/activity/reshares`     | GET    | Bearer      | Reshare activity for current user |

### Social Reading (`src/routes/social-reading.ts`)

| Endpoint                          | Method | Auth   | Description                       |
| --------------------------------- | ------ | ------ | --------------------------------- |
| `/api/social/read-positions`      | GET    | Bearer | Get social item read positions    |
| `/api/social/read-positions`      | POST   | Bearer | Mark social item as read          |
| `/api/social/read-positions/bulk` | POST   | Bearer | Bulk mark social items as read    |
| `/api/social/read-positions/:id`  | DELETE | Bearer | Mark social item as unread        |
| `/api/social/share-read`          | GET    | Bearer | (Legacy) Get share read positions |
| `/api/social/share-read`          | POST   | Bearer | (Legacy) Mark share as read       |
| `/api/social/share-read/:id`      | DELETE | Bearer | (Legacy) Mark share as unread     |

### Shares (`src/routes/shares.ts`)

| Endpoint          | Method | Auth        | Description                 |
| ----------------- | ------ | ----------- | --------------------------- |
| `/api/shares/my`  | GET    | None/Bearer | Get user's own shares       |
| `/api/shares`     | POST   | Bearer      | Create a share (+ PDS sync) |
| `/api/shares/:id` | DELETE | Bearer      | Delete a share (+ PDS sync) |

### Subscriptions (`src/routes/subscriptions.ts`)

| Endpoint                         | Method | Auth   | Description                      |
| -------------------------------- | ------ | ------ | -------------------------------- |
| `/api/subscriptions`             | POST   | Bearer | Create subscription (+ PDS sync) |
| `/api/subscriptions/bulk`        | POST   | Bearer | Bulk create subscriptions        |
| `/api/subscriptions/bulk-delete` | POST   | Bearer | Bulk delete subscriptions        |
| `/api/subscriptions/:id`         | DELETE | Bearer | Delete subscription (+ PDS sync) |

### Records (`src/routes/records.ts`)

| Endpoint            | Method | Auth        | Description                      |
| ------------------- | ------ | ----------- | -------------------------------- |
| `/api/records/list` | GET    | None/Bearer | List PDS records of a collection |

### Reading (`src/routes/reading.ts`)

| Endpoint                      | Method | Auth        | Description                |
| ----------------------------- | ------ | ----------- | -------------------------- |
| `/api/reading/positions`      | GET    | None/Bearer | Get article read positions |
| `/api/reading/mark-read`      | POST   | None/Bearer | Mark article as read       |
| `/api/reading/mark-unread`    | POST   | None/Bearer | Mark article as unread     |
| `/api/reading/mark-read-bulk` | POST   | None/Bearer | Bulk mark articles as read |

### Labels (`src/routes/labels.ts`)

| Endpoint           | Method | Auth   | Description                                |
| ------------------ | ------ | ------ | ------------------------------------------ |
| `/api/labels`      | GET    | Bearer | Get labels for items                       |
| `/api/labels`      | POST   | Bearer | Add a label (read/starred/archived/tag:\*) |
| `/api/labels`      | DELETE | Bearer | Delete a label                             |
| `/api/labels/bulk` | POST   | Bearer | Bulk add labels                            |

### Saved (`src/routes/saved.ts`)

| Endpoint                   | Method | Auth   | Description          |
| -------------------------- | ------ | ------ | -------------------- |
| `/api/saved`               | GET    | Bearer | Get saved articles   |
| `/api/saved`               | POST   | Bearer | Save an article      |
| `/api/saved/:id`           | DELETE | Bearer | Delete saved by ID   |
| `/api/saved/by-guid/:guid` | DELETE | Bearer | Delete saved by GUID |

### Settings (`src/routes/settings.ts`)

| Endpoint        | Method | Auth   | Description          |
| --------------- | ------ | ------ | -------------------- |
| `/api/settings` | GET    | Bearer | Get user settings    |
| `/api/settings` | PUT    | Bearer | Update user settings |

### Sync (`src/routes/sync.ts`)

| Endpoint                  | Method | Auth   | Description                 |
| ------------------------- | ------ | ------ | --------------------------- |
| `/api/sync/full`          | POST   | Bearer | Full PDS sync               |
| `/api/sync/subscriptions` | POST   | Bearer | Sync subscriptions from PDS |
| `/api/sync/status`        | GET    | Bearer | Get sync status             |

### Lexicons (`src/routes/lexicons.ts`)

| Endpoint                      | Method | Auth | Description              |
| ----------------------------- | ------ | ---- | ------------------------ |
| `/.well-known/lexicons`       | GET    | None | Index of lexicon schemas |
| `/.well-known/lexicons/:nsid` | GET    | None | Specific lexicon schema  |

---

## Services

### OAuth Service (`src/services/oauth.ts`)

**Cryptography:**

- `generatePKCE()` - Creates code verifier (64 chars) and S256 challenge
- `generateDPoPKeyPair()` - Creates ECDSA P-256 key pair
- `createDPoPProof()` - Signs JWT with DPoP claims (jti, htm, htu, iat, nonce, ath)

**Resolution:**

- `resolveHandle(handle)` - DNS TXT `_atproto.{handle}` or HTTP `/.well-known/atproto-did`
- `getPdsFromDid(did)` - Resolves via plc.directory or did:web
- `fetchAuthServerMetadata(pdsUrl)` - Gets OAuth endpoints from PDS

**Session Management:**

- Sessions stored in D1 (`sessions` table) with 30-day TTL
- `getSessionFromRequest()` - Extracts Bearer token, auto-refreshes if expiring
- `refreshSession()` - Uses refresh_token grant with DPoP proof
- Tracks refresh failures; sessions with 5+ failures are cleaned up by cron

### Feed Proxy Client (`src/services/feed-proxy-client.ts`)

Proxies feed requests to the Fly.io feed proxy service. Authenticates with `FEED_PROXY_SECRET`.

### Feed Parser (`src/services/feed-parser.ts`)

**Supported formats:**

- RSS 2.0 (`<channel><item>`)
- Atom 1.0 (`<feed><entry>`)
- RDF 1.0 (`<rdf:RDF><item>`)

### PDS Client (`src/services/pds-client.ts`)

Client for interacting with user PDS instances. Used by sync, subscription, and share operations.

### Share Sync (`src/services/share-sync.ts`)

Pushes and deletes share records to/from the user's PDS.

### Subscription Sync (`src/services/subscription-sync.ts`)

Syncs subscription records to/from the user's PDS.

### Rate Limiter (`src/services/rate-limit.ts`)

Per-user, per-endpoint rate limiting backed by D1. Expired records cleaned up by cron.

### User Tiers (`src/services/user-tier.ts` + `src/config/tier-limits.ts`)

Tier definitions:

- **Free:** 100 subscriptions, 100 saves/month
- **Supporter:** 1000 subscriptions, 1000 saves/month

### Client Auth (`src/services/client-auth.ts`)

Confidential client authentication helpers for production OAuth (`private_key_jwt`).

---

## Durable Objects

### JetstreamPoller (`src/durable-objects/jetstream-poller.ts`)

Single instance (`idFromName('main-v2')`) that maintains a long-running WebSocket connection to the AT Protocol Jetstream firehose.

**How it works:**

- Self-manages via Durable Object alarms (fires every ~60 seconds)
- Cron pings it every minute to ensure it's alive
- Connects to `wss://jetstream2.us-east.bsky.network/subscribe`
- Resumes from cursor stored in D1 (`sync_state` table)
- 8-second poll timeout, 2-second idle timeout

**Subscribed collections:**

- `app.skyreader.social.share` - Share events
- `app.skyreader.feed.subscription` - Subscription events
- `app.skyreader.feed.readPosition` - Read position events
- `app.skyreader.feed.saved` - Saved article events
- `site.standard.document` - Document records from follows

**Processing:**

For each Jetstream event, the poller inserts/updates/deletes the corresponding records in D1 tables (shares, subscriptions_cache, saved_articles, documents, etc.) and updates the cursor.

---

## Storage

### D1 Database

Key tables:

| Table                         | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `users`                       | User profiles (did, handle, display_name, avatar_url, pds_url, tier, timestamps) |
| `sessions`                    | D1-backed sessions (tokens, DPoP key, expiry, refresh tracking)                  |
| `oauth_state`                 | Short-lived OAuth PKCE states (10-min TTL)                                       |
| `auth_exchange_codes`         | Short-lived auth exchange codes                                                  |
| `subscriptions_cache`         | RSS feed subscriptions cached from PDS                                           |
| `shares`                      | Aggregated share data from Jetstream (with reshare tracking)                     |
| `feeds`                       | One row per crawled feed (title/site/image + `last_ingest_at`)                   |
| `feed_items`                  | The item archive the timeline serves, keyed `(feed_url, guid)` with `seq`        |
| `documents`                   | orphaned — documents moved to on-demand proxy fetch; table left in place         |
| `publications_cache`          | orphaned — the publication cache moved to the feed proxy                         |
| `social_read_positions_cache` | Unified social read tracking (shares + documents)                                |
| `item_labels_cache`           | Unified labels: read/starred/archived/tag: for all item types                    |
| `saved_articles`              | Saved/bookmarked articles                                                        |
| `rate_limits`                 | Per-user per-endpoint rate limiting                                              |
| `user_settings`               | User feature preferences (Leaflet sync, PDS sync)                                |
| `did_handle_cache`            | Handle resolution cache                                                          |
| `sync_state`                  | Jetstream cursor, archive generation token, crawler heartbeat                    |
| `reshares`                    | Reshare tracking                                                                 |
| `system_status`               | Cron-written health board (cron liveness, poller lag, proxy stats)               |
| `metrics_snapshots`           | Hourly trend points behind the admin's sparklines (90-day retention)             |

---

## Environment Variables

**wrangler.toml bindings:**

```toml
[vars]
FRONTEND_URL = "https://skyreader.app"
ALLOWED_ORIGINS = "https://skyreader.app,https://staging.skyreader.app,..."
FEED_PROXY_URL = "https://skyreader-feed-proxy.fly.dev"

# Secrets (set via `wrangler secret put`):
# FEED_PROXY_SECRET - authenticates with the Fly.io feed proxy

[[d1_databases]]
binding = "DB"

[durable_objects]
bindings = [
  { name = "JETSTREAM_POLLER", class_name = "JetstreamPoller" }
]

[triggers]
crons = ["* * * * *"]  # Every minute
```

---

## Security

### Authentication

- **PKCE:** Required for all OAuth flows (S256 challenge)
- **DPoP:** Tokens bound to client-generated key pair
- **Nonce handling:** Automatic retry on `use_dpop_nonce` error

### Session Security

- Sessions stored server-side in D1 (not exposed to client)
- Client only receives opaque `sessionId`
- Auto-refresh prevents token expiration during active use
- Sessions with 5+ refresh failures are cleaned up hourly

### Rate Limiting

- Per-user, per-endpoint rate limiting backed by D1
- Returns `429` with `Retry-After` and `X-RateLimit-*` headers

### CORS

- Origin checking against `ALLOWED_ORIGINS` (comma-separated list)
- Falls back to `FRONTEND_URL` if `ALLOWED_ORIGINS` not set
- Credentials allowed only from configured origins

---

## Error Handling

### Feed Errors

- The feed proxy (the crawler) owns caching, retries and per-feed error tracking; its `/stats` is where `feedsInError` comes from
- D1 keeps only ingest state: `feeds.last_ingest_at` per feed, `sync_state.crawler_heartbeat_at` for the crawler as a whole

### OAuth Errors

- `use_dpop_nonce`: Automatic retry with nonce from response header
- Invalid/expired state: Redirect to error page
- Token refresh failure: Tracked in `sessions.refresh_failures`, cleaned up after 5 failures

### Jetstream Errors

- Connection errors: Logged, DO alarm retries on next tick
- Cursor in D1 ensures no events lost between reconnections
