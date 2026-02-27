# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

This is a monorepo with 4 packages:
- `backend/` - Cloudflare Workers API
- `frontend/` - SvelteKit PWA
- `admin/` - SvelteKit admin dashboard (Cloudflare Pages)
- `feed-proxy/` - Feed caching proxy (Fly.io)

Each package has its own CLAUDE.md with detailed guidance.

## What is Skyreader?

A decentralized RSS reader built on AT Protocol (Bluesky). User data (subscriptions, read state, shares) is stored in their Personal Data Server (PDS), making it portable. Features offline support, real-time updates, and social sharing of articles.

## Development Commands

### Full Local Development (with OAuth)
```bash
./scripts/dev-local.sh   # Starts feed proxy, backend, and frontend
```

This script runs D1 migrations, then starts the feed proxy (port 3000), backend Wrangler dev server (port 8787), and frontend Vite dev server (port 5173). The frontend proxies `/api` requests to the backend via Vite, avoiding CORS issues.

**Prerequisites:**
- [Bun](https://bun.sh) installed (for the feed proxy)
- Install dependencies: `cd feed-proxy && bun install`
- Create `backend/.dev.vars` with:
  ```
  FRONTEND_URL=http://127.0.0.1:5173
  FEED_PROXY_URL=http://127.0.0.1:3000
  ```

**Resetting the local database:**
```bash
rm -rf backend/.wrangler/state/v3/d1/
```

**Note:** Always access the frontend at `http://127.0.0.1:5173` (not `localhost`) — OAuth requires `127.0.0.1`.

Local development uses AT Protocol's [localhost client exception](https://atproto.com/specs/oauth#localhost-client-development), which allows OAuth without hosting client metadata or using tunnels.

### Backend (`backend/`)
```bash
npm run dev              # Start Wrangler dev server (port 8787)
npm run test             # Run vitest tests
npm run deploy           # Deploy to Cloudflare Workers
npm run cf-typegen       # Generate types from wrangler.toml

# Database
npx wrangler d1 execute skyreader --local --command "SQL"
npx wrangler d1 execute skyreader --local --file=migrations/FILE.sql
```

### Frontend (`frontend/`)
```bash
npm run dev              # Start Vite dev server (port 5173)
npm run build            # Production build → build/
npm run check            # Type checking (svelte-check)
```

**Note:** Access the frontend at `http://127.0.0.1:5173` for local development.

### Admin (`admin/`)
```bash
npm run dev              # Start Vite dev server (port 5174)
npm run build            # Production build → .svelte-kit/cloudflare/
npm run preview          # Preview build locally with wrangler
npm run check            # Type checking (svelte-check)
npm run deploy           # Build and deploy to Cloudflare Pages
```

### E2E Tests (root)
```bash
npm run test:e2e             # Run Playwright tests (starts servers automatically)
npm run test:e2e:ui          # Interactive Playwright UI
npm run test:e2e:headed      # Run with visible browser
```

Playwright spins up the backend (port 8787) and frontend (port 5173) via `webServer` config, or reuses already-running servers from `./scripts/dev-local.sh`.

**Prerequisites:**
- `backend/.dev.vars` must include `ALLOWED_ORIGINS=http://127.0.0.1:5173`
- Install: `npm install && npx playwright install chromium` (from root)

**Test structure:**
```
e2e/
├── global-setup.ts          # Applies D1 migrations before test run
├── seed.ts                  # Seeds test data into D1 via wrangler CLI
├── fixtures.ts              # Custom Playwright fixtures (testUser, authedPage)
└── custom-fields.spec.ts    # Test specs
```

**Key patterns:**
- **Auth bypass:** `seed.ts` inserts users/sessions/settings directly into D1. The `authedPage` fixture sets the `session_id` cookie and `skyreader-auth` localStorage.
- **PDS disabled:** Seeded `user_settings` has `pds_sync_enabled=0` so tests don't need a real PDS.
- **Valid TIDs:** Seeded subscription rkeys must match `/^[a-z0-9]{13,}$/` (AT Protocol TID format).
- **Async PATCH:** The frontend fires subscription PATCH requests in the background. Use `page.waitForResponse()` to ensure D1 is updated before reloading.
- **Cleanup:** Each test's `testUser` fixture automatically deletes its seeded data after the test.

## Architecture Overview

```
Frontend (SvelteKit + Svelte 5)        Admin (SvelteKit + Svelte 5)
    ↓↑ HTTP/REST                           ↓↑ D1 (read-only)
Backend (Cloudflare Workers)           Cloudflare Pages
    ↓↑
AT Protocol (Bluesky PDS) + Fly.io Feed Proxy + Jetstream Firehose
```

### Backend Stack
- **Runtime:** Cloudflare Workers
- **Database:** D1 (SQLite) for all storage (sessions, feeds, shares, labels, etc.)
- **Durable Objects:** JetstreamPoller (long-running firehose connection via alarms)
- **Auth:** PKCE + DPoP OAuth flow
- **Cron:** Every 1 min (ping JetstreamPoller DO, cleanup rate limits), hourly (cleanup expired sessions/OAuth states)

### Frontend Stack
- **Framework:** SvelteKit 2.x with Svelte 5 runes
- **State:** Rune stores in `.svelte.ts` files (not writable stores)
- **Offline:** IndexedDB via Dexie.js + sync queue
- **PWA:** Service worker for offline support

### Admin Stack
- **Framework:** SvelteKit 2.x with Svelte 5 runes
- **Runtime:** Cloudflare Pages
- **Database:** D1 (SQLite) - reads the same database as the backend
- **Features:** System metrics dashboard, user management, feed health monitoring, search/sort/pagination
- **Pages:** Dashboard (metrics overview), Users (list + detail), Feeds (health + error tracking)
- **Deploy:** Cloudflare Pages via GitHub Actions (staging on push to main, production on release)

### Key Data Flow
1. **Auth:** Handle → DID resolution → OAuth PKCE/DPoP → session token
2. **Subscriptions:** Stored in user's PDS, cached locally in IndexedDB
3. **Feed Updates:** Frontend requests feeds → backend proxies via Fly.io feed cache
4. **Social:** Jetstream firehose → D1 shares table → frontend polls for updates

## AT Protocol Integration

Custom lexicons in `lexicons/app/skyreader/`:
- `feed/subscription.json` - RSS subscription record
- `feed/saved.json` - Saved article record
- `social/share.json` - Shared article record
- `social/shareReadPosition.json` - Share read position

Records are synced bidirectionally between the app and user's PDS.
