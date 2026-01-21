# Skyreader Frontend

SvelteKit PWA for [Skyreader](https://skyreader.app), a decentralized RSS reader built on the AT Protocol.

## Overview

This frontend is a Progressive Web App that provides:

- **RSS Reading**: Subscribe to and read RSS/Atom feeds
- **Offline Support**: IndexedDB caching via Dexie.js for offline reading
- **Social Features**: See what articles people you follow are sharing
- **AT Protocol Integration**: All data stored in your Bluesky PDS
- **Real-time Updates**: WebSocket connection for live updates

## Prerequisites

- Node.js 18+
- A running [skyreader-backend](https://github.com/skyreader/skyreader-backend) instance
- Bluesky account for testing

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` to point to your backend:

```
VITE_API_URL=http://127.0.0.1:8787
```

For production, use your deployed backend URL:

```
VITE_API_URL=https://your-backend.workers.dev
```

### 3. Start Development Server

```bash
npm run dev
```

The app will be available at `http://127.0.0.1:5173`.

**Important**: Use `127.0.0.1`, not `localhost`, for AT Protocol OAuth to work correctly (RFC 8252 requirement).

### 4. Verify

1. Open `http://127.0.0.1:5173` in your browser
2. Click "Login with Bluesky"
3. Enter your Bluesky handle
4. You should be redirected to Bluesky's auth page

## Build for Production

```bash
npm run build
```

The output will be in the `build/` directory, ready for deployment to Cloudflare Pages or any static hosting.

## Deployment

### Cloudflare Pages

1. Connect your GitHub repo to Cloudflare Pages
2. Set build command: `npm run build`
3. Set output directory: `build`
4. Add environment variable: `VITE_API_URL=https://your-backend.workers.dev`

### Static Hosting

The build output is a static site that can be hosted anywhere (Vercel, Netlify, etc.). Just ensure you set `VITE_API_URL` at build time.

## Project Structure

```
skyreader-frontend/
├── src/
│   ├── lib/
│   │   ├── components/       # UI components
│   │   │   ├── Sidebar.svelte
│   │   │   ├── ArticleCard.svelte
│   │   │   ├── ShareCard.svelte
│   │   │   └── ...
│   │   ├── stores/           # Svelte 5 rune stores
│   │   │   ├── auth.svelte.ts
│   │   │   ├── subscriptions.svelte.ts
│   │   │   ├── reading.svelte.ts
│   │   │   ├── social.svelte.ts
│   │   │   └── sync.svelte.ts
│   │   ├── services/         # Business logic
│   │   │   ├── api.ts        # HTTP client
│   │   │   ├── db.ts         # Dexie (IndexedDB)
│   │   │   └── sync-queue.ts # Offline sync
│   │   └── types/            # TypeScript types
│   ├── routes/               # SvelteKit pages
│   │   ├── +page.svelte      # Main feed
│   │   ├── social/           # Social feed
│   │   ├── starred/          # Starred articles
│   │   ├── feeds/            # Manage subscriptions
│   │   ├── settings/         # User settings
│   │   └── auth/             # Login/callback
│   └── service-worker.ts     # PWA service worker
├── static/
│   └── manifest.json         # PWA manifest
├── lexicons/                 # AT Protocol schemas
└── svelte.config.js
```

## Key Routes

| Route | Purpose |
|-------|---------|
| `/` | Main feed (all articles) |
| `/social` | Shares from followed users |
| `/starred` | Starred articles |
| `/feeds` | Manage subscriptions |
| `/discover` | Discover new feeds |
| `/settings` | Account and sync status |
| `/auth/login` | Bluesky handle input |
| `/auth/callback` | OAuth callback |

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API URL | `http://127.0.0.1:8787` |

## Useful Commands

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run preview      # Preview production build
npm run check        # Type checking
npm run check:watch  # Type checking (watch mode)
```

## Related

- [skyreader-backend](https://github.com/skyreader/skyreader-backend) - Cloudflare Workers API
- [AT Protocol](https://atproto.com) - Decentralized social protocol

## License

GPL-3.0
