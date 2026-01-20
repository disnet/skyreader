# Skyreader Development Guide

## Project Overview

Skyreader is a decentralized RSS reader using the AT Protocol (Bluesky's underlying protocol) for data storage. Users authenticate with their Bluesky account and their data is stored in their Personal Data Server (PDS).

## Key Concepts

### AT Protocol Basics

- **DID**: Decentralized Identifier (e.g., `did:plc:abc123`) - permanent user ID
- **Handle**: Human-readable username (e.g., `user.bsky.social`)
- **PDS**: Personal Data Server - where user data is stored
- **Lexicon**: Schema definition language for record types (like JSON Schema)
- **NSID**: Namespaced identifier for schemas (e.g., `app.skyreader.feed.subscription`)

### OAuth Requirements

AT Protocol OAuth has specific requirements:
- **PKCE**: Required for all flows
- **DPoP**: Demonstrating Proof of Possession - tokens are bound to a key pair
- **Nonce**: Auth servers may require nonce in DPoP proofs (handle `use_dpop_nonce` error)
- **Loopback IP**: Use `127.0.0.1` not `localhost` for local dev (RFC 8252)
- **Public client_id**: The `client_id` URL must be publicly fetchable

## Architecture Details

See [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md) for detailed backend documentation.

### Backend (Cloudflare Workers)

**Entry Point**: `backend/src/index.ts`
- Routes requests to handlers
- Adds CORS headers

**Routes**:
- `backend/src/routes/auth.ts` - OAuth flow (login, callback, logout, client metadata)
- `backend/src/routes/feeds.ts` - RSS proxy with caching
- `backend/src/routes/social.ts` - Social feed aggregation

**Services**:
- `backend/src/services/oauth.ts` - PKCE, DPoP, handle resolution, session management
- `backend/src/services/feed-parser.ts` - RSS/Atom parsing
- `backend/src/services/jetstream-poller.ts` - Polls Jetstream for share events (cron-triggered)
- `backend/src/services/scheduled-feeds.ts` - Refreshes RSS feeds on schedule

**Durable Objects**:
- `backend/src/durable-objects/realtime-hub.ts` - Broadcasts real-time updates to connected clients

**Storage**:
- D1: Users, sessions, follows cache, aggregated shares, feed metadata, feed cache, sync state

### Frontend (SvelteKit + Svelte 5)

**Stores** (using Svelte 5 runes in `.svelte.ts` files):
- `auth.svelte.ts` - User session state
- `subscriptions.svelte.ts` - Feed subscriptions CRUD
- `reading.svelte.ts` - Read/starred state
- `social.svelte.ts` - Social feed from followed users
- `sync.svelte.ts` - Online status and pending sync count

**Services**:
- `api.ts` - HTTP client for backend
- `db.ts` - Dexie (IndexedDB) schema for offline storage
- `sync-queue.ts` - Queue operations when offline, process when online

**Key Routes**:
- `/` - Main feed (all articles)
- `/auth/login` - Bluesky handle input
- `/auth/callback` - OAuth callback handler
- `/feeds` - Manage subscriptions
- `/social` - Shares from followed users
- `/starred` - Starred articles
- `/settings` - Account and sync status

### Lexicon Schemas

Located in `lexicons/app/skyreader/`:

```
feed/subscription.json  - RSS feed subscription
  - feedUrl (required)
  - title
  - category
  - tags[]
  - createdAt (required)

feed/readPosition.json  - Reading progress
  - itemGuid (required)
  - itemUrl
  - readAt (required)
  - starred

social/share.json       - Shared article
  - itemUrl (required)
  - itemTitle
  - note (user commentary)
  - createdAt (required)
```

## Common Tasks

### Adding a New Lexicon Field

1. Update schema in `lexicons/app/skyreader/...`
2. Update TypeScript types in `frontend/src/lib/types/index.ts`
3. Update Dexie schema version in `frontend/src/lib/services/db.ts`
4. Update relevant store and components

### Adding a New API Endpoint

1. Create handler in `backend/src/routes/`
2. Add route case in `backend/src/index.ts`
3. Add method in `frontend/src/lib/services/api.ts`

### Debugging OAuth Issues

1. Use `npx wrangler tail` to stream backend logs
2. Common errors:
   - `use_dpop_nonce`: Need to retry with nonce from response header
   - `invalid_client_metadata`: client_id URL not accessible or metadata invalid
   - `localhost` errors: Use `127.0.0.1` instead

## Environment Variables

### Backend (`wrangler.toml`)
- `FRONTEND_URL`: Allowed CORS origin

### Frontend (`.env`)
- `VITE_API_URL`: Backend API URL

## Local Development Setup

### D1 Database Setup (for contributors)

The `wrangler.toml` file contains placeholder values for database IDs. To run the backend locally:

1. Create your own D1 database: `npx wrangler d1 create skyreader`
2. Copy the `database_id` from the command output
3. Replace `YOUR_D1_DATABASE_ID` in `backend/wrangler.toml` with your database ID
4. Run migrations locally: `npx wrangler d1 execute skyreader --local --file=backend/migrations/0001_initial.sql`

For staging, create a separate database with `npx wrangler d1 create skyreader-staging` and update the staging `database_id`.

## Deployment Checklist

1. Create D1 database: `npx wrangler d1 create skyreader`
2. Update `wrangler.toml` with database ID
3. Run migration: `npx wrangler d1 execute skyreader --remote --file=migrations/0001_initial.sql`
4. Deploy backend: `npx wrangler deploy`
5. Update frontend `.env` with backend URL
6. Build frontend: `npm run build`
7. Deploy frontend to Cloudflare Pages or other static host
