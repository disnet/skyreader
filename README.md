# Skyreader

A reading app that helps you make sense of what you read. Subscribe to everything — RSS,
newsletters, social, YouTube, the Atmosphere — read it in one calm place, and turn it into
understanding with highlights, margin notes, and a linkblog. Built on the open AT Protocol, so
your reading life stays portable and yours.

> **Read everything from everywhere. Make sense of it all.**

## Repository Structure

```
skyreader/
├── frontend/       SvelteKit PWA
├── backend/        Cloudflare Workers API
├── admin/          SvelteKit admin dashboard (Cloudflare Pages)
├── feed-proxy/     Feed caching proxy (Fly.io)
├── e2e/            Playwright end-to-end tests
└── scripts/        Development scripts
```

## Getting Started

```bash
git clone https://github.com/disnet/skyreader.git
cd skyreader
```

### Prerequisites

- [Node.js](https://nodejs.org/)
- [Bun](https://bun.sh) (for the feed proxy)
- Install dependencies:
  ```bash
  cd backend && npm install
  cd frontend && npm install
  cd feed-proxy && bun install
  ```
- Create `backend/.dev.vars`:
  ```
  FRONTEND_URL=http://127.0.0.1:5173
  FEED_PROXY_URL=http://127.0.0.1:3000
  # Shared with the proxy (dev-local.sh exports the same value as PROXY_SECRET).
  # Feed ingest is fail-closed, so without this the local reader stays empty.
  FEED_PROXY_SECRET=dev-proxy-secret
  ```

### Local Development

```bash
# Start feed proxy + backend + frontend together
./scripts/dev-local.sh
```

This runs D1 migrations, starts the feed proxy (port 3000), backend (port 8787), and frontend (port 5173).

To start services individually:

```bash
cd feed-proxy && bun run dev                # port 3000
cd backend && npm run dev                   # port 8787
cd frontend && npm run dev                  # port 5173
cd admin && npm install && npm run dev      # port 5174
```

To reset the local database: `rm -rf backend/.wrangler/state/v3/d1/`

Use `http://127.0.0.1:5173` not `localhost` for local development (OAuth requirement).

### E2E Tests

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

## Documentation

See `CLAUDE.md` for architecture details and development guidance. Each package also has its own `CLAUDE.md`.
