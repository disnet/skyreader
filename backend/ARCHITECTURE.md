# Skyreader Backend Architecture

## Overview

The Skyreader backend is a Cloudflare Worker that serves as an API gateway between the frontend and the AT Protocol ecosystem. It handles authentication, RSS feed fetching/parsing, social features, and real-time updates.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND                                       │
│  ┌─────────┐  ┌─────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Login   │  │ Feeds   │  │ Social Feed  │  │ WebSocket (realtime)   │  │
│  └────┬────┘  └────┬────┘  └──────┬───────┘  └───────────┬────────────┘  │
└───────┼────────────┼───────────────┼─────────────────────┼───────────────┘
        │            │               │                     │
        ↓            ↓               ↓                     ↓
┌───────────────────────────────────────────────────────────────────────────┐
│                         CLOUDFLARE WORKER                                 │
│                                                                           │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ auth.ts  │  │ feeds.ts     │  │ social.ts     │  │ records.ts       │  │
│  │ OAuth    │  │ RSS proxy    │  │ Social feed   │  │ PDS sync         │  │
│  └────┬─────┘  └──────┬───────┘  └───────┬───────┘  └────────┬─────────┘  │
│       │               │                  │                   │           │
│       ↓               ↓                  ↓                   ↓           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                          SERVICES                                   │ │
│  │  oauth.ts │ feed-parser.ts │ jetstream-poller.ts │ scheduled-feeds  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ↓                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ STORAGE: D1 (users, shares, follows) │ KV (feeds, sessions)         │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ CRON (every 1 min): pollJetstream() + refreshActiveFeeds() (15min)  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ REALTIME_HUB DO: WebSocket connections, broadcasts new_share/articles│ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
        │                                                    ↑
        ↓                                                    │
┌───────────────────┐                          ┌─────────────────────────┐
│ BLUESKY PDS       │                          │ JETSTREAM FIREHOSE      │
│ (user's data)     │                          │ (AT Protocol events)    │
└───────────────────┘                          └─────────────────────────┘
```

## Entry Point

**File:** `src/index.ts`

The main Worker exports a default object with two handlers:

### `fetch` Handler
Processes all HTTP requests:
1. Validates CORS against `FRONTEND_URL`
2. Extracts session and tracks user activity (non-blocking)
3. Routes to appropriate handler based on pathname
4. Applies CORS headers to response

### `scheduled` Handler
Runs on cron trigger (every minute):
1. **Always:** Polls Jetstream for new share events
2. **Every 15 minutes:** Refreshes RSS feeds for active users

---

## Routes

### Authentication (`src/routes/auth.ts`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/.well-known/client-metadata` | GET | None | OAuth client metadata for Bluesky auth servers |
| `/api/auth/login` | GET | None | Initiates OAuth flow, returns auth URL |
| `/api/auth/callback` | GET | None | Handles OAuth callback, creates session |
| `/api/auth/me` | GET | Bearer | Returns current user profile |
| `/api/auth/logout` | POST | Bearer | Revokes tokens and deletes session |

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
Store OAuth state in KV (10-min TTL)
       ↓
Return auth URL → User redirects to Bluesky
```

#### Callback Flow
```
Receive code + state
       ↓
Validate state from KV
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
Create session in KV (30-day TTL)
       ↓
Upsert user in D1
       ↓
For new users: async sync follows
       ↓
Redirect to frontend with sessionId
```

### Feeds (`src/routes/feeds.ts`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/feeds/fetch` | GET | None | Fetches and parses RSS feed |
| `/api/feeds/article` | GET | None | Fetches specific article by GUID |
| `/api/feeds/discover` | GET | None | Discovers feeds on a website |

#### Feed Fetch Flow
```
Request with feedUrl
       ↓
Check KV cache (key: feed:{urlHash})
       ↓
If cached → Return with X-Cache: HIT
       ↓
Fetch with conditional headers (ETag, Last-Modified)
       ↓
If 304 Not Modified → Return cached
       ↓
Parse XML (RSS 2.0, Atom 1.0, or RDF 1.0)
       ↓
Cache parsed feed (15-min TTL)
       ↓
Update feed_metadata in D1
       ↓
Return parsed feed JSON
```

### Social (`src/routes/social.ts`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/social/feed` | GET | Bearer | Shares from followed users |
| `/api/social/sync-follows` | POST | Bearer | Sync follows from Bluesky |
| `/api/social/following` | GET | Bearer | List followed users |
| `/api/social/popular` | GET | None | Popular shares across all users |

### Records (`src/routes/records.ts`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/records/sync` | POST | Bearer | Create/update/delete records on PDS |
| `/api/records/list` | GET | Bearer | List all records of a collection |

**Supported collections:**
- `app.skyreader.feed.subscription` - RSS feed subscriptions
- `app.skyreader.feed.readPosition` - Read/starred state
- `app.skyreader.social.share` - Shared articles

### Realtime (`/api/realtime`)

WebSocket endpoint handled by RealtimeHub Durable Object. See [Durable Objects](#durable-objects) section.

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
- `storeSession()` / `getSession()` - KV storage with 30-day TTL
- `getSessionFromRequest()` - Extracts Bearer token, auto-refreshes if expiring
- `refreshSession()` - Uses refresh_token grant with DPoP proof

### Feed Parser (`src/services/feed-parser.ts`)

**Supported formats:**
- RSS 2.0 (`<channel><item>`)
- Atom 1.0 (`<feed><entry>`)
- RDF 1.0 (`<rdf:RDF><item>`)

**Output structure:**
```typescript
interface ParsedFeed {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  fetchedAt: number;
}

interface FeedItem {
  guid: string;
  url: string;
  title: string;
  author?: string;
  content?: string;
  summary?: string;
  imageUrl?: string;
  publishedAt: string;
}
```

### Jetstream Poller (`src/services/jetstream-poller.ts`)

Polls the AT Protocol firehose for share events. Called every minute by cron.

```
Read cursor from D1 (sync_state.jetstream_cursor)
       ↓
Connect to wss://jetstream2.us-east.bsky.network/subscribe
       ↓
Subscribe to app.skyreader.social.share collection
       ↓
Resume from cursor (with 5-second buffer)
       ↓
For each event:
  ├─ Extract share metadata
  ├─ Fetch article content from feedUrl
  ├─ Insert into shares table
  └─ Broadcast to RealtimeHub
       ↓
Stop when idle 2s or timeout 30s
       ↓
Save cursor for next poll
```

### Scheduled Feeds (`src/services/scheduled-feeds.ts`)

Refreshes RSS feeds for active users. Called every 15 minutes by cron.

```
Query subscriptions from active users (last 7 days)
       ↓
Group by feed_url, order by subscriber_count DESC
       ↓
For each batch of 10 feeds:
  ├─ Skip if error_count >= 10
  ├─ Fetch with conditional headers
  ├─ Parse and cache (15-min TTL)
  ├─ Update feed_metadata
  └─ Notify RealtimeHub of new articles
       ↓
1-second delay between batches
```

---

## Durable Objects

### RealtimeHub (`src/durable-objects/realtime-hub.ts`)

Single instance (`idFromName('main')`) managing WebSocket connections for real-time updates.

**Connection flow:**
```
WebSocket upgrade to /api/realtime
       ↓
Extract session from:
  - Sec-WebSocket-Protocol: bearer-{sessionId}
  - Query param: ?token={sessionId}
       ↓
Validate session from KV
       ↓
Accept WebSocket with hibernation support
       ↓
Store client: { socket, did, lastHeartbeat }
       ↓
Send { type: 'connected', payload: { timestamp } }
```

**Message types:**

| Type | Recipients | Trigger |
|------|------------|---------|
| `connected` | Single client | On connection |
| `heartbeat` | All clients | Every 30 seconds |
| `new_share` | Followers of author | Jetstream poller |
| `new_articles` | Subscribers of feed | Scheduled feed refresh |

**Broadcasting logic:**
- `new_share`: Query `follows_cache` for followers of `author_did`, send only to them
- `new_articles`: Query `subscriptions_cache` for subscribers of `feed_url`, send only to them

**Heartbeat & cleanup:**
- Alarm fires every 30s when clients connected
- Sends heartbeat, expects `{ type: 'pong' }` response
- Removes clients with no response for 90 seconds

---

## Storage

### D1 Database

```
┌─────────────────────────────────────────────────────────────┐
│ users                                                       │
├─────────────────────────────────────────────────────────────┤
│ did TEXT PRIMARY KEY                                        │
│ handle TEXT NOT NULL                                        │
│ display_name TEXT                                           │
│ avatar_url TEXT                                             │
│ pds_url TEXT NOT NULL                                       │
│ last_synced_at INTEGER  -- last follows sync                │
│ last_active_at INTEGER  -- last API request                 │
│ created_at INTEGER                                          │
│ updated_at INTEGER                                          │
└─────────────────────────────────────────────────────────────┘
        │
        │ 1:N (CASCADE DELETE on all child tables)
        │
        ├──────────────────────────────────────────────────────┐
        ↓                                                      ↓
┌───────────────────────────┐      ┌───────────────────────────────────┐
│ follows_cache             │      │ subscriptions_cache               │
├───────────────────────────┤      ├───────────────────────────────────┤
│ follower_did TEXT (FK)    │      │ id INTEGER PRIMARY KEY            │
│ following_did TEXT (FK)   │      │ user_did TEXT (FK)                │
│ rkey TEXT                 │      │ record_uri TEXT UNIQUE            │
│ created_at INTEGER        │      │ feed_url TEXT NOT NULL            │
│ PRIMARY KEY (follower,    │      │ title TEXT                        │
│              following)   │      │ created_at INTEGER                │
└───────────────────────────┘      └───────────────────────────────────┘
        │
        ↓
┌─────────────────────────────────────────────────────────────┐
│ shares                                                      │
├─────────────────────────────────────────────────────────────┤
│ id INTEGER PRIMARY KEY AUTOINCREMENT                        │
│ author_did TEXT NOT NULL (FK)                               │
│ record_uri TEXT UNIQUE                                      │
│ record_cid TEXT                                             │
│ feed_url TEXT              -- source RSS feed               │
│ item_url TEXT              -- article URL                   │
│ item_title TEXT                                             │
│ item_author TEXT                                            │
│ item_description TEXT                                       │
│ item_image TEXT                                             │
│ item_guid TEXT             -- article GUID from feed        │
│ item_published_at INTEGER                                   │
│ note TEXT                  -- user's commentary             │
│ tags TEXT                  -- JSON array                    │
│ content TEXT               -- pre-fetched article content   │
│ indexed_at INTEGER                                          │
│ created_at INTEGER                                          │
└─────────────────────────────────────────────────────────────┘

┌───────────────────────────┐      ┌───────────────────────────┐
│ feed_metadata             │      │ sync_state                │
├───────────────────────────┤      ├───────────────────────────┤
│ feed_url TEXT PRIMARY KEY │      │ key TEXT PRIMARY KEY      │
│ title TEXT                │      │ value TEXT                │
│ site_url TEXT             │      │ updated_at INTEGER        │
│ description TEXT          │      └───────────────────────────┘
│ last_fetched_at INTEGER   │
│ last_scheduled_fetch_at   │      Used for:
│ etag TEXT                 │      - jetstream_cursor: µs timestamp
│ last_modified TEXT        │
│ fetch_error TEXT          │
│ error_count INTEGER       │
│ subscriber_count INTEGER  │
│ created_at INTEGER        │
└───────────────────────────┘
```

### KV Namespaces

**FEED_CACHE:**
| Key Pattern | Value | TTL |
|-------------|-------|-----|
| `feed:{urlHash}` | Parsed feed JSON | 15 minutes |
| `feed:{urlHash}:meta` | ETag, Last-Modified | 1 hour |

**SESSION_CACHE:**
| Key Pattern | Value | TTL |
|-------------|-------|-----|
| `oauth:{state}` | OAuth state (PKCE, DID, etc.) | 10 minutes |
| `session:{sessionId}` | Session (tokens, DPoP key) | 30 days |

---

## Environment Variables

**wrangler.toml bindings:**
```toml
[vars]
FRONTEND_URL = "https://your-frontend.com"  # CORS origin

[[d1_databases]]
binding = "DB"

[[kv_namespaces]]
binding = "FEED_CACHE"

[[kv_namespaces]]
binding = "SESSION_CACHE"

[durable_objects]
bindings = [
  { name = "REALTIME_HUB", class_name = "RealtimeHub" }
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
- Sessions stored server-side in KV (not exposed to client)
- Client only receives opaque `sessionId`
- Auto-refresh prevents token expiration during active use

### CORS
- Strict origin checking against `FRONTEND_URL`
- Credentials allowed only from configured origin

---

## Error Handling

### Feed Errors
- Feeds with 10+ consecutive errors are skipped in scheduled refresh
- `error_count` resets on successful fetch
- `fetch_error` stores last error message

### OAuth Errors
- `use_dpop_nonce`: Automatic retry with nonce from response header
- Invalid/expired state: Redirect to error page
- Token refresh failure: Session invalidated, user must re-login

### Jetstream Errors
- Connection errors: Logged, next poll retries
- 30-second timeout prevents runaway connections
- Cursor ensures no events lost between polls
