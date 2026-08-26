# Skyreader Frontend Development Guide

**Important:** Always run `npm run check` before finishing work to verify types and formatting.

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

| Store                     | Purpose                              |
| ------------------------- | ------------------------------------ |
| `auth.svelte.ts`          | User session state                   |
| `subscriptions.svelte.ts` | Feed subscriptions CRUD              |
| `reading.svelte.ts`       | Read/starred state for articles      |
| `social.svelte.ts`        | Social feed from followed users      |
| `sync.svelte.ts`          | Online status and pending sync count |
| `preferences.svelte.ts`   | User preferences                     |
| `realtime.svelte.ts`      | WebSocket connection state           |

### Services

| Service           | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `api.ts`          | HTTP client for backend API                        |
| `db.ts`           | Dexie (IndexedDB) schema for offline storage       |
| `feedFetcher.ts`  | Feed refresh (timeline sync + legacy batch path)   |
| `timelineSync.ts` | Pure helpers for the timeline sync (unit-tested)   |
| `sync-queue.ts`   | Queue operations when offline, process when online |
| `realtime.ts`     | WebSocket connection management                    |
| `telemetry.ts`    | Sampled client error reports to the backend        |

### Feed refresh

A refresh is **one** `GET /api/v2/timeline` request (plus drain pages while `hasMore`), served from
the backend's D1 archive with read state already stamped on each item. The client holds a single
global cursor in Dexie `metadata` (`timelineCursor` = `{cursor, generation}`), committed only after
a successful merge; a `generation` change cold-starts. A cold start is paged (`cold_offset`), and
commits the first page's cursor only once the last page has merged. New subscriptions are
backfilled through `fetchSingleFeed` → `GET /api/v2/feeds/fetch`, since their items sit below the
global cursor — including ones that arrive from another device (`backfillMissingSubscriptions`,
once per feed, ≤ 10 per sync).

Per-feed error state (the sidebar badge and the Manage Sources popover) comes from the response's
`feedHealth`: the set of feeds the crawler currently considers broken. Reads are served from the
archive, so "this feed returned nothing" means nothing — a dead feed and a quiet feed look
identical, and only the server's health verdict distinguishes them. **Absence from that map is what
clears an error**, so `applyHealthSnapshot` runs after the per-feed `markReady` pass and overrides
it. The payload is sent on every cold start and whenever the echoed `health_rev` is stale, so a
steady-state poll pays nothing for it.

The legacy per-feed `/api/v2/feeds/batch` path (`fetchAllFeedsViaBatch`, with per-subscription
`feedCursors`) is kept for one release as a fallback: it runs when the timeline 404s and whenever
the server reports `ingestActive: false` (this environment's crawler isn't pushing into D1). See
`docs/plans/D1_FEED_TIMELINE.md`.

Client errors flow through `/api/telemetry/error`; no Sentry SDK ships in the frontend bundle.
See [`docs/RUNBOOK.md`](../docs/RUNBOOK.md) for sampling and recovery details.

### Key Routes

| Route            | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `/`              | Main feed (all articles from subscribed feeds) |
| `/social`        | Shares from followed users                     |
| `/starred`       | Starred articles                               |
| `/feeds`         | Manage feed subscriptions                      |
| `/discover`      | Discover new feeds                             |
| `/settings`      | Account and sync status                        |
| `/auth/login`    | Bluesky handle input                           |
| `/auth/callback` | OAuth callback handler                         |

#### The `?read=` contract

Any surface that hosts the fullscreen reader (`/feeds`, `/saved`, `/home`,
`/linkblog`, `/highlights`, plus channel views under `?view=`) carries the open
article as `?read=<FeedDisplayItem.key>`, percent-encoded. It is **shallow
routing, not a route**: `useReaderStack` pushes a history entry per reader level
with the URL and a `page.state.readerDepth` tag, so the list underneath never
unmounts and Back still closes the reader and restores its scroll position. The
param is what makes a reload, a bookmark, a shared link and Forward-reopen work —
on a cold load the hook rewrites the current entry to the bare list URL and pushes
the reader's, so closing always lands on the container list. Resolution
(`src/lib/utils/readerLink.ts`) goes saves → articles → documents, with an
`at://` network fallback; an unresolvable key toasts and strips the param.

Consequence for anything that reads the URL: an effect on `$page.url` now re-runs
when a reader opens or closes. Keep such effects idempotent under an added or
removed `read` param — `feedViewStore.setFilters` is the precedent (it no-ops when
the filter set is unchanged; see `src/lib/utils/urlFilters.ts`).

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

Located in `frontend/lexicons/app/skyreader/`:

```
feed/subscription.json  - RSS feed subscription
  - feedUrl (required)
  - title
  - category
  - tags[]
  - createdAt (required)

feed/saved.json         - Saved article
  - url (required)
  - title, description, author, domain, image
  - contentType, fullContent, wordCount
  - publishedAt, savedAt (required)

feed/highlight.json     - Article highlights (W3C TextQuoteSelector)
  - itemUrl (required)
  - highlights[] (required)
  - createdAt (required)

social/follow.json      - In-app follow relationship
  - subject (required, DID of followed user)
  - createdAt (required)
```

## PWA Features

- **Service Worker**: `src/service-worker.ts` handles caching and offline support
- **Manifest**: `static/manifest.json` defines PWA metadata
- **IndexedDB**: Dexie.js provides offline data storage
- **Sync Queue**: Operations made offline are queued and synced when back online
