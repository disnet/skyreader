# Skyreader

A decentralized RSS reader built on the [AT Protocol](https://atproto.com). Your subscriptions, reading progress, and shares are stored in your Personal Data Server (PDS), giving you full ownership and portability of your data.

## Features

- **Decentralized Storage**: All user data stored in your Bluesky PDS
- **Social Sharing**: See what articles people you follow are sharing
- **Offline Support**: PWA with IndexedDB for offline reading
- **Background Sync**: Changes sync automatically when back online

## Architecture

```
┌─────────────────┐     ┌─────────────────────────────────────────────┐
│  Svelte 5 PWA   │────▶│           CLOUDFLARE WORKERS                │
│  (Frontend)     │     │                                             │
└────────┬────────┘     │  Routes: auth, feeds, items, reading,       │
         │              │          records, shares, social, discover  │
    IndexedDB           │                                             │
    (Offline)           │  ┌─────────────────────────────────────┐    │
         │              │  │         Durable Objects             │    │
         └─WebSocket───▶│  │  RealtimeHub     (WebSocket server) │    │
                        │  │  JetstreamPoller (firehose events)  │    │
                        │  │  FeedRefresher   (RSS refresh)      │    │
                        │  └─────────────────────────────────────┘    │
                        │                    │                        │
                        │                   D1                        │
                        │          (Users, Sessions, Feeds,           │
                        │           Shares, Feed Cache, etc.)         │
                        └──────────────┬──────────────────────────────┘
                                       │
                        ┌──────────────┼──────────────┐
                        ↓              ↓              ↓
                ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
                │ User's PDS  │ │  Jetstream  │ │  RSS Feeds  │
                │(AT Protocol)│ │  Firehose   │ │  (External) │
                └─────────────┘ └─────────────┘ └─────────────┘
```

## Tech Stack

- **Frontend**: SvelteKit + Svelte 5 (runes), Dexie.js (IndexedDB)
- **Backend**: Cloudflare Workers + D1 + Durable Objects
- **Protocol**: AT Protocol with OAuth 2.0 + PKCE + DPoP

## Project Structure

```
skyreader/
├── frontend/           # Svelte 5 PWA
│   ├── src/
│   │   ├── lib/
│   │   │   ├── components/   # UI components (Sidebar, ArticleCard, ShareCard, etc.)
│   │   │   ├── stores/       # Svelte 5 rune stores (auth, subscriptions,
│   │   │   │                 #   reading, social, shares, shareReading,
│   │   │   │                 #   preferences, sidebar, realtime, keyboard, sync)
│   │   │   ├── services/     # API client, Dexie DB, sync queue, realtime
│   │   │   └── types/        # TypeScript types
│   │   ├── routes/           # SvelteKit pages (/, /social, /starred,
│   │   │                     #   /discover, /settings, /auth/*)
│   │   └── service-worker.ts # PWA service worker
│   └── static/
│       └── manifest.json     # PWA manifest
├── backend/            # Cloudflare Workers
│   ├── src/
│   │   ├── routes/           # API handlers (auth, feeds, items, reading,
│   │   │                     #   records, shares, social, discover)
│   │   ├── services/         # OAuth, feed parser, article content,
│   │   │                     #   rate limiting, PDS sync
│   │   └── durable-objects/  # RealtimeHub, JetstreamPoller, FeedRefresher
│   └── migrations/           # D1 SQL migrations (16 migrations)
└── lexicons/           # AT Protocol schemas
    └── app/skyreader/
        ├── feed/             # subscription, readPosition
        └── social/           # share, follow, shareReadPosition
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

2. Create Cloudflare D1 database:
   ```bash
   npx wrangler d1 create skyreader
   ```

3. Update `wrangler.toml` with the database ID from step 2

4. Run the database migration:
   ```bash
   npx wrangler d1 execute skyreader --remote --file=migrations/0001_initial.sql
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
   VITE_API_URL=https://skyreader-api.YOUR_SUBDOMAIN.workers.dev
   ```

3. Run development server:
   ```bash
   npm run dev
   ```

4. Open `http://127.0.0.1:5173` (must use IP, not localhost, for OAuth)

## AT Protocol Integration

### Lexicon Schemas

The app defines five custom record types under the `app.skyreader` namespace:

- **`app.skyreader.feed.subscription`**: RSS feed subscriptions
- **`app.skyreader.feed.readPosition`**: Read/starred state for articles
- **`app.skyreader.social.share`**: Shared articles with optional notes
- **`app.skyreader.social.follow`**: In-app follow relationships
- **`app.skyreader.social.shareReadPosition`**: Read state for others' shares

See [Lexicon Documentation](docs/LEXICONS.md) for detailed schema information.

### OAuth Flow

1. User enters Bluesky handle
2. App resolves handle → DID → PDS URL → Auth Server
3. PKCE + PAR (Pushed Authorization Request) initiated
4. User authorizes on Bluesky
5. Callback exchanges code for tokens with DPoP proof
6. Session stored in D1, user redirected to app

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
npx wrangler d1 execute skyreader --remote --command "SELECT * FROM users"

# Frontend
cd frontend
npm run dev               # Development server
npm run build             # Production build
npm run check             # Type checking
```

## License

MIT
