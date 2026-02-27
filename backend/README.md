# Skyreader Backend

Cloudflare Workers API for [Skyreader](https://skyreader.app), a decentralized RSS reader built on the AT Protocol.

## Overview

This backend serves as an API gateway between the Skyreader frontend and the AT Protocol ecosystem. It handles:

- **OAuth Authentication**: PKCE + DPoP-based authentication with Bluesky
- **RSS Feed Fetching**: Proxied through a Fly.io caching service
- **Social Features**: Aggregating shares from followed users
- **Saved Articles**: Save and manage articles with labels
- **Background Jobs**: Jetstream firehose polling via Durable Object alarms

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account (free tier works)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Create D1 Database

```bash
npx wrangler d1 create skyreader
```

Copy the `database_id` from the output.

### 3. Configure wrangler.toml

Update `wrangler.toml` with your database ID:

```toml
[[d1_databases]]
binding = "DB"
database_name = "skyreader"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 4. Run Migrations

For local development:

```bash
npx wrangler d1 migrations apply skyreader --local
```

Or use the setup script:

```bash
./scripts/setup-local-db.sh
```

For production:

```bash
npx wrangler d1 migrations apply skyreader --remote
```

### 5. Start Development Server

```bash
npm run dev
```

The API will be available at `http://127.0.0.1:8787`.

### 6. Verify

Test that the API is running:

```bash
curl http://127.0.0.1:8787/.well-known/client-metadata
```

You should receive OAuth client metadata JSON.

## Deployment

```bash
npm run deploy
```

After deployment, update the `FRONTEND_URL` environment variable in `wrangler.toml` to match your frontend's production URL.

## Project Structure

```
skyreader-backend/
├── src/
│   ├── index.ts                    # Entry point, routing, cron handler
│   ├── types.ts                    # Shared types
│   ├── routes/
│   │   ├── auth.ts                 # OAuth flow
│   │   ├── feeds-v2.ts             # RSS fetching via Fly.io proxy
│   │   ├── social.ts               # Social feed, popular, grouped
│   │   ├── social-reading.ts       # Social item read positions
│   │   ├── shares.ts               # User shares CRUD
│   │   ├── subscriptions.ts        # Subscription CRUD
│   │   ├── records.ts              # PDS record listing
│   │   ├── reading.ts              # Article read positions
│   │   ├── labels.ts               # Unified item labels
│   │   ├── saved.ts                # Saved articles
│   │   ├── settings.ts             # User settings
│   │   ├── sync.ts                 # PDS sync
│   │   └── lexicons.ts             # Lexicon schema serving
│   ├── services/
│   │   ├── oauth.ts                # PKCE, DPoP, session management
│   │   ├── feed-parser.ts          # RSS/Atom/RDF parsing
│   │   ├── feed-proxy-client.ts    # Fly.io proxy client
│   │   ├── pds-client.ts           # PDS API client
│   │   ├── client-auth.ts          # Confidential client auth
│   │   ├── share-sync.ts           # Share PDS sync
│   │   ├── subscription-sync.ts    # Subscription PDS sync
│   │   ├── rate-limit.ts           # Per-user rate limiting
│   │   └── user-tier.ts            # User tier lookup
│   ├── durable-objects/
│   │   └── jetstream-poller.ts     # Jetstream firehose connection
│   ├── utils/
│   │   ├── canonical-url.ts        # URL canonicalization
│   │   ├── cookies.ts              # Cookie helpers
│   │   ├── did-resolver.ts         # DID resolution
│   │   ├── shard.ts                # Feed sharding logic
│   │   └── validation.ts           # Input validation
│   └── config/
│       └── tier-limits.ts          # Tier definitions
├── migrations/                      # D1 SQL migrations
├── lexicons/                        # AT Protocol schemas
├── test/                            # Tests
├── wrangler.toml                    # Cloudflare config
└── ARCHITECTURE.md                  # Detailed architecture docs
```

## API Endpoints

### Auth

| Endpoint                       | Method | Auth   | Description           |
| ------------------------------ | ------ | ------ | --------------------- |
| `/.well-known/client-metadata` | GET    | -      | OAuth client metadata |
| `/api/auth/login`              | GET    | -      | Initiate OAuth flow   |
| `/api/auth/callback`           | GET    | -      | OAuth callback        |
| `/api/auth/me`                 | GET    | Bearer | Current user          |
| `/api/auth/logout`             | POST   | Bearer | Logout                |

### Feeds

| Endpoint                 | Method | Auth   | Description           |
| ------------------------ | ------ | ------ | --------------------- |
| `/api/v2/feeds/fetch`    | GET    | Bearer | Fetch RSS feed        |
| `/api/v2/feeds/batch`    | POST   | Bearer | Batch fetch feeds     |
| `/api/v2/feeds/discover` | GET    | Bearer | Discover feeds on URL |

### Social

| Endpoint                          | Method   | Auth        | Description                 |
| --------------------------------- | -------- | ----------- | --------------------------- |
| `/api/social/feed`                | GET      | None/Bearer | Social feed                 |
| `/api/social/feed/grouped`        | GET      | None/Bearer | Grouped social feed         |
| `/api/social/popular`             | GET      | None        | Popular shares              |
| `/api/social/detect-content`      | GET      | Bearer      | Detect content type         |
| `/api/activity/reshares`          | GET      | Bearer      | Reshare activity            |
| `/api/social/read-positions`      | GET/POST | Bearer      | Social read positions       |
| `/api/social/read-positions/bulk` | POST     | Bearer      | Bulk mark social items read |
| `/api/social/read-positions/:id`  | DELETE   | Bearer      | Mark social item unread     |

### Shares

| Endpoint          | Method | Auth        | Description       |
| ----------------- | ------ | ----------- | ----------------- |
| `/api/shares/my`  | GET    | None/Bearer | Get user's shares |
| `/api/shares`     | POST   | Bearer      | Create a share    |
| `/api/shares/:id` | DELETE | Bearer      | Delete a share    |

### Subscriptions

| Endpoint                         | Method | Auth   | Description         |
| -------------------------------- | ------ | ------ | ------------------- |
| `/api/subscriptions`             | POST   | Bearer | Create subscription |
| `/api/subscriptions/bulk`        | POST   | Bearer | Bulk create         |
| `/api/subscriptions/bulk-delete` | POST   | Bearer | Bulk delete         |
| `/api/subscriptions/:id`         | DELETE | Bearer | Delete subscription |

### Reading & Labels

| Endpoint                      | Method          | Auth        | Description        |
| ----------------------------- | --------------- | ----------- | ------------------ |
| `/api/reading/positions`      | GET             | None/Bearer | Get read positions |
| `/api/reading/mark-read`      | POST            | None/Bearer | Mark as read       |
| `/api/reading/mark-unread`    | POST            | None/Bearer | Mark as unread     |
| `/api/reading/mark-read-bulk` | POST            | None/Bearer | Bulk mark as read  |
| `/api/labels`                 | GET/POST/DELETE | Bearer      | Manage item labels |
| `/api/labels/bulk`            | POST            | Bearer      | Bulk add labels    |

### Saved Articles

| Endpoint                   | Method | Auth   | Description        |
| -------------------------- | ------ | ------ | ------------------ |
| `/api/saved`               | GET    | Bearer | Get saved articles |
| `/api/saved`               | POST   | Bearer | Save an article    |
| `/api/saved/:id`           | DELETE | Bearer | Delete by ID       |
| `/api/saved/by-guid/:guid` | DELETE | Bearer | Delete by GUID     |

### Settings & Sync

| Endpoint                  | Method  | Auth   | Description        |
| ------------------------- | ------- | ------ | ------------------ |
| `/api/settings`           | GET/PUT | Bearer | User settings      |
| `/api/sync/full`          | POST    | Bearer | Full PDS sync      |
| `/api/sync/subscriptions` | POST    | Bearer | Sync subscriptions |
| `/api/sync/status`        | GET     | Bearer | Sync status        |

### Other

| Endpoint                      | Method | Auth        | Description          |
| ----------------------------- | ------ | ----------- | -------------------- |
| `/.well-known/lexicons`       | GET    | None        | Lexicon schema index |
| `/.well-known/lexicons/:nsid` | GET    | None        | Specific lexicon     |
| `/api/records/list`           | GET    | None/Bearer | List PDS records     |

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed documentation.

## Environment Variables

| Variable            | Description                         | Default                    |
| ------------------- | ----------------------------------- | -------------------------- |
| `FRONTEND_URL`      | Primary CORS origin                 | `https://skyreader.app`    |
| `ALLOWED_ORIGINS`   | Comma-separated allowed origins     | Falls back to FRONTEND_URL |
| `FEED_PROXY_URL`    | Fly.io feed proxy URL               | -                          |
| `FEED_PROXY_SECRET` | Secret for feed proxy auth (secret) | -                          |

For local development, set `FRONTEND_URL` to `http://127.0.0.1:5173`.

## Testing

Tests use Vitest with Cloudflare's `@cloudflare/vitest-pool-workers` for running tests in the Workers runtime.

```bash
npm run test              # Run all tests
npm run test -- --watch   # Run tests in watch mode
```

Tests are located in the `test/` directory and use a consolidated schema (`test/schema.sql`) that mirrors the production database structure.

### Test Structure

- `test/setup.ts` - Applies the test schema before each test file
- `test/schema.sql` - Consolidated database schema for tests
- `test/index.spec.ts` - API endpoint tests

## Useful Commands

```bash
npm run dev          # Start local dev server
npm run deploy       # Deploy to Cloudflare
npm run test         # Run tests
npm run check        # Type check + prettier check
npm run cf-typegen   # Generate TypeScript types from wrangler.toml

# Database commands
npx wrangler d1 migrations apply skyreader --local   # Apply all migrations locally
npx wrangler d1 migrations apply skyreader --remote  # Apply all migrations to production
npx wrangler d1 execute skyreader --local --command "SELECT * FROM users"
npx wrangler d1 execute skyreader --remote --command "SELECT * FROM users"

# View logs
npx wrangler tail
```

## Related

- [AT Protocol](https://atproto.com) - Decentralized social protocol

## License

GPL-3.0
