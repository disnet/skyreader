# Skyreader Frontend Development Guide

## Project Overview

Skyreader frontend is a SvelteKit PWA that provides an RSS reading experience with AT Protocol integration. User data is stored in their Personal Data Server (PDS), giving them full ownership and portability.

## Key Concepts

### AT Protocol Basics

- **DID**: Decentralized Identifier (e.g., `did:plc:abc123`) - permanent user ID
- **Handle**: Human-readable username (e.g., `user.bsky.social`)
- **PDS**: Personal Data Server - where user data is stored
- **Lexicon**: Schema definition language for record types (like JSON Schema)
- **NSID**: Namespaced identifier for schemas (e.g., `app.skyreader.feed.subscription`)

### OAuth Notes

- Use `127.0.0.1` not `localhost` for local dev (RFC 8252 requirement)
- OAuth flow is handled by the backend; frontend just receives session ID

## Architecture

### Stores (Svelte 5 Runes)

All stores use Svelte 5 runes (`.svelte.ts` files):

| Store | Purpose |
|-------|---------|
| `auth.svelte.ts` | User session state |
| `subscriptions.svelte.ts` | Feed subscriptions CRUD |
| `reading.svelte.ts` | Read/starred state for articles |
| `social.svelte.ts` | Social feed from followed users |
| `sync.svelte.ts` | Online status and pending sync count |
| `preferences.svelte.ts` | User preferences |
| `realtime.svelte.ts` | WebSocket connection state |

### Services

| Service | Purpose |
|---------|---------|
| `api.ts` | HTTP client for backend API |
| `db.ts` | Dexie (IndexedDB) schema for offline storage |
| `sync-queue.ts` | Queue operations when offline, process when online |
| `realtime.ts` | WebSocket connection management |

### Key Routes

| Route | Purpose |
|-------|---------|
| `/` | Main feed (all articles from subscribed feeds) |
| `/social` | Shares from followed users |
| `/starred` | Starred articles |
| `/feeds` | Manage feed subscriptions |
| `/discover` | Discover new feeds |
| `/settings` | Account and sync status |
| `/auth/login` | Bluesky handle input |
| `/auth/callback` | OAuth callback handler |

## Common Tasks

### Adding a New Lexicon Field

1. Update schema in `lexicons/app/skyreader/...`
2. Update TypeScript types in `src/lib/types/index.ts`
3. Update Dexie schema version in `src/lib/services/db.ts`
4. Update relevant store and components

### Adding a New Route

1. Create directory in `src/routes/`
2. Add `+page.svelte` (and `+page.ts` if needed)
3. Update navigation in `src/lib/components/Sidebar.svelte`

### Adding a New Store

1. Create `src/lib/stores/name.svelte.ts`
2. Use Svelte 5 runes pattern:
   ```typescript
   class NameStore {
     data = $state<DataType | null>(null);
     loading = $state(false);

     async fetch() {
       this.loading = true;
       try {
         this.data = await api.getData();
       } finally {
         this.loading = false;
       }
     }
   }

   export const nameStore = new NameStore();
   ```

### Working with IndexedDB

The app uses Dexie.js for offline storage. Schema is defined in `src/lib/services/db.ts`.

```typescript
// Reading from cache
const cached = await db.subscriptions.toArray();

// Writing to cache
await db.subscriptions.put(subscription);

// Clearing cache
await db.subscriptions.clear();
```

## Environment Variables

### .env

```
VITE_API_URL=http://127.0.0.1:8787
```

For production:
```
VITE_API_URL=https://your-backend.workers.dev
```

## Local Development

1. Ensure backend is running at `http://127.0.0.1:8787`
2. Create `.env` with `VITE_API_URL=http://127.0.0.1:8787`
3. Run `npm run dev`
4. Access via `http://127.0.0.1:5173` (not `localhost`)

## Deployment

1. Set `VITE_API_URL` to your production backend URL
2. Run `npm run build`
3. Deploy `build/` directory to Cloudflare Pages or static host

## Lexicon Schemas

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

## PWA Features

- **Service Worker**: `src/service-worker.ts` handles caching and offline support
- **Manifest**: `static/manifest.json` defines PWA metadata
- **IndexedDB**: Dexie.js provides offline data storage
- **Sync Queue**: Operations made offline are queued and synced when back online
