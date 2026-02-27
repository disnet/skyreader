# Skyreader

A decentralized RSS reader built on AT Protocol (Bluesky).

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

Create `backend/.dev.vars`:
```
FRONTEND_URL=http://127.0.0.1:5173
```

### Local Development

```bash
# Start backend + frontend together
./scripts/dev-local.sh

# Or start individually:
cd backend && npm install && npm run dev    # port 8787
cd frontend && npm install && npm run dev   # port 5173
cd admin && npm install && npm run dev      # port 5174
```

Use `127.0.0.1` not `localhost` for local development (OAuth requirement).

### E2E Tests

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

## Documentation

See `CLAUDE.md` for architecture details and development guidance. Each package also has its own `CLAUDE.md`.
