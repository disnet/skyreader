# AT-RSS

A decentralized RSS reader built on the [AT Protocol](https://atproto.com). Your subscriptions, reading progress, and shares are stored in your Personal Data Server (PDS), giving you full ownership and portability of your data.

## Features

- **Decentralized Storage**: All user data stored in your Bluesky PDS
- **Social Sharing**: See what articles people you follow are sharing
- **Offline Support**: PWA with IndexedDB for offline reading
- **Background Sync**: Changes sync automatically when back online

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Svelte 5 PWA   │────▶│  CF Workers API │────▶│   User's PDS    │
│  (Frontend)     │     │  (Backend)      │     │  (AT Protocol)  │
└────────┬────────┘     └────────┬────────┘     └─────────────────┘
         │                       │
    IndexedDB              ┌─────┴─────┐
    (Offline)              │           │
                          D1         KV
                       (Shares)   (Feed Cache)
```

## Tech Stack

- **Frontend**: SvelteKit + Svelte 5 (runes), Dexie.js (IndexedDB)
- **Backend**: Cloudflare Workers + D1 + KV + Durable Objects
- **Protocol**: AT Protocol with OAuth 2.0 + PKCE + DPoP

## Project Structure

```
at-rss/
├── frontend/           # Svelte 5 PWA
│   ├── src/
│   │   ├── lib/
│   │   │   ├── components/   # UI components
│   │   │   ├── stores/       # Svelte 5 rune stores
│   │   │   ├── services/     # API client, Dexie DB, sync queue
│   │   │   └── types/        # TypeScript types
│   │   ├── routes/           # SvelteKit pages
│   │   └── service-worker.ts # PWA service worker
│   └── static/
│       └── manifest.json     # PWA manifest
├── backend/            # Cloudflare Workers
│   ├── src/
│   │   ├── routes/           # API route handlers
│   │   ├── services/         # OAuth, feed parser
│   │   └── durable-objects/  # Jetstream consumer
│   └── migrations/           # D1 SQL migrations
└── lexicons/           # AT Protocol schemas
    └── com/at-rss/
        ├── feed/             # subscription, readPosition
        └── social/           # share
```

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Bluesky account for testing

### Backend Setup

1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Create Cloudflare resources:
   ```bash
   npx wrangler d1 create at-rss
   npx wrangler kv namespace create FEED_CACHE
   npx wrangler kv namespace create SESSION_CACHE
   ```

3. Update `wrangler.toml` with the IDs from step 2

4. Run the database migration:
   ```bash
   npx wrangler d1 execute at-rss --remote --file=migrations/0001_initial.sql
   ```

5. Deploy:
   ```bash
   npx wrangler deploy
   ```

### Frontend Setup

1. Install dependencies:
   ```bash
   cd frontend
   npm install
   ```

2. Create `.env` with your backend URL:
   ```
   VITE_API_URL=https://at-rss-api.YOUR_SUBDOMAIN.workers.dev
   ```

3. Run development server:
   ```bash
   npm run dev
   ```

4. Open `http://127.0.0.1:5173` (must use IP, not localhost, for OAuth)

## AT Protocol Integration

### Lexicon Schemas

The app defines three custom record types under the `com.at-rss` namespace:

- **`com.at-rss.feed.subscription`**: RSS feed subscriptions
- **`com.at-rss.feed.readPosition`**: Read/starred state for articles
- **`com.at-rss.social.share`**: Shared articles with optional notes

### OAuth Flow

1. User enters Bluesky handle
2. App resolves handle → DID → PDS URL → Auth Server
3. PKCE + PAR (Pushed Authorization Request) initiated
4. User authorizes on Bluesky
5. Callback exchanges code for tokens with DPoP proof
6. Session stored in KV, user redirected to app

### Data Flow

- **Subscriptions**: Stored in user's PDS, cached locally in IndexedDB
- **Reading Progress**: Stored in PDS, synced via background queue
- **Social Shares**: Written to PDS, aggregated by backend via Jetstream firehose

## Development

### Local Development

The AT Protocol OAuth requires publicly accessible URLs. For local development:

1. Deploy backend to Cloudflare Workers (free)
2. Run frontend locally pointing to deployed backend
3. Access frontend via `127.0.0.1` (not `localhost` - RFC 8252 requirement)

### Useful Commands

```bash
# Backend
cd backend
npx wrangler dev          # Local dev (limited - no real OAuth)
npx wrangler deploy       # Deploy to Cloudflare
npx wrangler tail         # Stream live logs
npx wrangler d1 execute at-rss --remote --command "SELECT * FROM users"

# Frontend
cd frontend
npm run dev               # Development server
npm run build             # Production build
npm run check             # Type checking
```

### Updating Durable Object Code

Durable Objects (like `JetstreamConsumer`) persist across deploys. WebSocket handlers are closures created at connection time and won't pick up new code automatically.

**For WebSocket handler changes**:
1. Bump `CODE_VERSION` in `backend/src/durable-objects/jetstream-consumer.ts`
2. Deploy - the alarm forces a reconnect within 30 seconds

**For major changes**:
1. Change the DO instance name in `index.ts` and `auth.ts` (e.g., `'main-v2'` → `'main-v3'`)
2. Deploy - old instances auto-shutdown via active instance registry in KV

**Debug endpoints**:
```bash
# Check DO status (instanceId, codeVersion, connection state)
curl https://at-rss-api.YOUR_SUBDOMAIN.workers.dev/api/jetstream/status

# Force reconnect
curl https://at-rss-api.YOUR_SUBDOMAIN.workers.dev/api/jetstream/reconnect
```

## License

MIT
