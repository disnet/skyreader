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

| Store                     | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `auth.svelte.ts`          | User session state                                  |
| `subscriptions.svelte.ts` | Feed subscriptions CRUD                             |
| `itemLabels.svelte.ts`    | Read/tag/archive/highlight labels + the delta sync  |
| `unreadCounts.svelte.ts`  | Unread counts (server's when online, local offline) |
| `feedArchive.svelte.ts`   | Transient "Show older" items below the local window |
| `social.svelte.ts`        | Social feed from followed users                     |
| `sync.svelte.ts`          | Online status, pending queue count, last sync       |
| `preferences.svelte.ts`   | User preferences                                    |

### Services

| Service           | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `api.ts`          | HTTP client for backend API                        |
| `db.ts`           | Dexie (IndexedDB) schema for offline storage       |
| `feedFetcher.ts`  | Feed refresh (timeline sync + legacy batch path)   |
| `timelineSync.ts` | Pure helpers for the timeline sync (unit-tested)   |
| `sync-queue.ts`   | Queue operations when offline, process when online |
| `readDelta.ts`    | Pure delta/merge decisions (unit-tested)           |
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

There is deliberately **no per-feed loading state** to go with it — `feedStatus.svelte.ts` has no
`'pending'`, and the sidebar renders a source's favicon or its error badge, nothing in between. A
refresh is one archive-wide request, so nothing per-feed ever arrives to settle a per-feed spinner;
seeding one at boot left it spinning for the life of the tab. Sync progress belongs to the
app-level indicators (`RefreshProgressBar`, the header ↻, the mobile bottom-bar rail), which key off
`appManager.isRefreshing`.

The legacy per-feed `/api/v2/feeds/batch` path (`fetchAllFeedsViaBatch`, with per-subscription
`feedCursors`) is kept for one release as a fallback: it runs when the timeline 404s and whenever
the server reports `ingestActive: false` (this environment's crawler isn't pushing into D1). See
`docs/plans/D1_FEED_TIMELINE.md`.

### Label sync (read state, tags, progress, highlights)

Two forward deltas, both in `itemLabels.svelte.ts`: `GET /api/reading/positions` for `read`, and
`GET /api/labels?labels=…` for tagged/archived/readProgress/highlights. Four rules keep them from
diverging across devices — each one is a bug that was actually shipped:

- **The cursor is compound `(updated_at, id)`**, base64 on the wire, and it is the last row
  _delivered_, never a clock reading. `updated_at` has one-second resolution, so a timestamp-only
  cursor with a strictly-greater predicate silently dropped every row written in its own second and
  never offered them again. A legacy numeric cursor is still accepted (read as `(seconds, 0)`).
- **The cursor moves only after the Dexie write succeeds.** It used to be committed in a separate
  `try`, so a failed IndexedDB write lost the batch _and_ skipped past it — permanently, since the
  delta is forward-only. Both deltas are paged; drain until `hasMore` is false.
- **Conflicts resolve by user time, not arrival time.** Every write carries `updatedAt` (unix ms —
  the sync queue's own enqueue time, or `Date.now()` for an optimistic call), and the server keeps
  the later one. Without it, a queue draining an hour late re-marked-unread something the user had
  since read elsewhere. `planReadDelta` applies the same comparison inbound; `readProgress` merges
  by `props.lastReadAt` (never `paragraphIndex` — re-reading legitimately moves backwards).
- **Timestamps are milliseconds everywhere in the label store.** Server rows arrive in seconds and
  are converted once, at the boundary (`localTimestamps`).

Freshness: `refreshFromBackend` pulls both, plus `itemLabelsStore.pullDelta()` on `online` (after
the queue drains), on `visibilitychange`, and on a 5-minute while-open timer — all gated to one
pull a minute. There is deliberately **no push channel**: a no-change delta is one indexed query
returning zero rows, and the product is calm.

### Guest reading mode

"Start Reading" on the landing page drops a visitor into the real reader with no account:
`auth.enterGuestMode()` first clears any prior account's unscoped Dexie cache, then sets a reactive
signal (backed by the `skyreader-guest` localStorage key),
the curated starter channels are seeded into Dexie, and every write stays local — the subscription
store skips its backend calls, and `itemLabels` and `savesStore` behave exactly as they do offline
(write locally, queue), so the sync queue that accumulates IS the migration on sign-in: read state
and saved articles alike. `syncStore.triggerSync` holds the queue while `auth.isGuest` — a drain
would 401 (no session), and a 401 is non-retryable, which would mark the migration entries
permanently failed. Guest saves keep the RSS body from `db.articles` (extraction is
session-gated); `savesStore.load()` stops at the Dexie cache for a guest, and the body-fetch
fallbacks never fire.

**Saving out to Semble or Margin is account-only** — both the article picker and the highlight push.
Each writes a record to the reader's own atproto repo, so a queued one could never drain without a
session and a granted scope; queueing it would be a false promise, unlike a local highlight or save
where the queue IS the migration. `integrationSaveStore.openPicker` refuses for a guest with a
sign-in toast, and every reader host gates the affordance on `Boolean(auth.user)` — `/daily` was the
one that didn't.

**Pushing a highlight to Margin is account-only.** Highlighting itself stays local for a guest (the
queue IS the migration), but an `at.margin.note` is a record in the reader's own atproto repo, and a
queued one could never drain without both a session and a granted Margin scope — so queueing it
would be a false promise. `saveHighlightToMargin` refuses for a guest with a sign-in toast, and the
three surfaces that offer it (the reader popover via `useHighlights`, `HighlightsPage`,
`HighlightReview`) hide the action rather than let a guest meet the backstop. The Margin _import_ is
already account-gated by its opt-in preference, which lives in account-only Settings.

**Adding a source is account-only.** A guest's library is exactly the curated starter channels, and
those ride the crawl set, so everything a guest can read is already crawler-maintained — there is no
unauthenticated path that puts a feed into the archive. `subscriptionsStore.add()` throws
`GuestAddBlockedError` for a guest and `addBulk()` refuses unless called with `{ starterSeed: true }`
(only "Start Reading" does); each add surface — the sidebar and mobile add menus, `AddFeedModal`
(the backstop every entry point funnels through), `LibraryEmptyState`, `/subscribe` — offers sign-in
instead. Renaming, recategorizing and removing a feed stay local and allowed.

Reads go through `POST /api/guest/timeline` with the local feed-URL list (`feedFetcher`'s guest
branch), capped at 50 feeds — the same number the store caps a guest's library at. **The batch path
is not a fallback for a guest** (it needs a session), so an `ingestActive: false` response or a
failed timeline ends the sync with what's cached rather than fanning out to endpoints that 401.
Single-feed reads (retry, backfill) route through the same endpoint; there is no warm step.

**Highlights made in guest mode merge, they do not replace.** A guest's highlights array holds only
what was highlighted here (guest mode starts from a cleared cache), so it is not the authority on an
existing account's set. Draining it under the ordinary last-write-wins replace loses one side of any
article highlighted in BOTH contexts, silently and in either direction: a newer account row refuses
the guest write, an older one gets overwritten wholesale. So a highlight write made while
`auth.isGuest` carries `mode: 'merge'`, which the backend applies as a union by highlight id that
always lands (see `MERGE_HIGHLIGHTS_CONFLICT` in `backend/src/routes/labels.ts`). Clearing an item's
highlights as a guest cancels the pending write rather than queueing a delete, which would otherwise
tombstone the account's own highlights for that article on sign-in. Signed-in writes are unchanged
and stay authoritative, so removing a single highlight still propagates.

Saves need none of this: the queue entry carries the whole payload and the backend dedups on
`(user_did, url)`, so a guest save of a URL the account already has keeps the account's row. The one
place saves needed care is the **external-backed snapshot** (`first.full` in `savesStore.load()`),
which replaces the cache wholesale so a removal in Semble or Margin lands here. That snapshot is
authoritative about collection membership but not about saves that were never sent, so the replace
now keeps any row still holding a pending create (`syncQueue.pendingSavedRkeys()`). Without it a
guest's saves vanished on the first authenticated boot, since Phase 1 runs `load()` before the queue
drains. Keying it on the queue rather than on load order also covers the plain offline-account case.

`auth.isInApp` (account **or** guest) gates the reading surfaces; `auth.isAuthenticated` still gates
every account action. The route guard in `+layout.svelte` allows a guest `/feeds`, `/home`, `/saved`
and `/sources` (Home and Saved run entirely off the local saves pile — the account-only rails and
channel affordances hide for guests) and turns any account-only route into the sign-in screen with
a `returnUrl`. On the first authenticated boot, `appManager.migrateGuestSubscriptions()`
bulk-creates the local rows (rkeys preserved) before `syncSubscriptions()` — the curated starter
rows are left behind when the account already has a library, so trying the reader out never adds
sample feeds to a real one. Queued guest saves and reads drain through the ordinary sync run on
that same boot.

Client errors flow through `/api/telemetry/error`; no Sentry SDK ships in the frontend bundle.
See [`docs/RUNBOOK.md`](../docs/RUNBOOK.md) for sampling and recovery details.

### Key Routes

| Route                | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `/`                  | Main feed (all articles from subscribed feeds) |
| `/social`            | Shares from followed users                     |
| `/starred`           | Starred articles                               |
| `/feeds`             | Manage feed subscriptions                      |
| `/discover`          | Discover new feeds                             |
| `/highlights`        | Every highlight, grouped by source article     |
| `/highlights/review` | Review deck — a few highlights, one at a time  |
| `/settings`          | Account and sync status                        |
| `/auth/login`        | Bluesky handle input                           |
| `/auth/callback`     | OAuth callback handler                         |

### Highlights

Highlights live in the `highlights` label's opaque `props.highlights` array, merged per-highlight by
id across alias rows (`utils/highlightAliases.ts`). Three things ride that array beyond the quote
itself: `lastReviewedAt` (the review deck's repeat-avoidance, synced for free), `reviewIntent`
(`soon`/`later`/`someday`/`never` — the deck's frequency tuning; `later` is the neutral default, and
even `never` only stops the highlight being dealt, it stays in the list and on Margin), and
`sourceUrl`/`sourceTitle` (source metadata for highlights imported from Margin whose article isn't
in any local cache). Because the whole array is written to `item_labels_cache.props` as opaque JSON,
any new per-highlight field reaches D1 and syncs across devices with no migration. `utils/highlightSource.ts` is the shared resolver both the list and the deck use so
they degrade identically. See [`docs/plans/HIGHLIGHT_REVIEW.md`](../docs/plans/HIGHLIGHT_REVIEW.md).

#### Selecting and re-bounding in paged mode

Paged mode has no scroller, so a native selection used to stop at the page edge.
`PagedView` now carries a live selection through every page turn (`onTurn` →
`utils/paginatedSelection.ts` finds a text point strictly inside the newly visible
page and `Selection.extend()`s onto it), and a selection focus that dwells in the
trailing edge zone turns the page by itself. Both are DOM-anchored, so the
`translateX` that shows a page never touches the selection.

An existing highlight can be re-bounded by direct manipulation: clicking one
selects it (`useHighlights.selectedHighlightId`), which raises its toolbar _and_
`HighlightHandles` — a grab knob just off each end of the passage. Dragging a knob
re-bounds it; releasing commits. There is no mode to be in or fall out of, and no
"adjust" state to make visible: the handles are the affordance, and clicking
anywhere else puts them down.

Nothing in the article is mutated during a drag. The highlight's own marks are
dimmed with an inline `background-color`, the dragged bounds are painted as a
fixed overlay, and the pivot boundary stays a live `Range` — so caret hit-testing
(`caretPositionFromPoint`) and the pivot both survive the whole gesture. Geometry
is re-read every frame because the text under a handle moves for reasons that
emit no event: a page turn animates a transform, a font change reflows, a commit
replaces the marks. In paged mode a handle is drawn only when its own end is on
the visible page.

Two constants are coupled and must move together: the knob's touch target
reaches 24px past its line, and `HighlightPopover`'s `gap` is 26px for an
existing highlight — the toolbar is the higher layer, so a smaller gap silently
eats the press that would grab a handle.

The commit replaces the selector in place (`mutateHighlightUnion`'s `selector`
op), so the id, note, review state and Margin linkage survive. Because a
selection can run across pages, it can also outgrow the selector's
5 000-character `exact` cap; over-long selections are refused with a toast
(`exceedsSelectorLimit`) rather than saved silently short.

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
`at://` network fallback; an unresolvable key toasts and strips the param. The
hook only gives up (network fallback, then toast) once `appManager.phase` reaches
`ready`/`error` — `isInitialized` is already true all through `refreshing`, which
is exactly when the sync that supplies a feed article is still running.

Because saves are matched first, an article you saved comes back typed `'saved'`
rather than `'article'` when the _URL_ is what opened it. Anything a reader host
does per item type needs a `'saved'` branch: `src/lib/utils/readerSave.ts` is the
shared one for Save/Unsave, and it keys off the save's guid/url, never its display
key (usually the save's `at://` record uri, which the saves store doesn't index).

Consequence for anything that reads the URL: an effect on `$page.url` now re-runs
when a reader opens or closes. Keep such effects idempotent under an added or
removed `read` param — `feedViewStore.setFilters` is the precedent (it no-ops when
the filter set is unchanged; see `src/lib/utils/urlFilters.ts`). The deliberate
trade there: re-selecting the channel you are already in no longer re-applies that
channel's persisted toolbar configuration (leaving and coming back still does).

A surface renders its list, not an empty state, while a `read` param is present
(`FeedPage`) — otherwise a shared link landing on a feed-less or filtered-empty
page would have no reader stack to receive it and would sit there inert.

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
