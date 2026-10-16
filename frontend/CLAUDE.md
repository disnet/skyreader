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
| `shelf.svelte.ts`         | Shelf membership (`kept` label) + collections       |

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
| `vitals.ts`       | Sampled field vitals (INP/CLS/blocking) per route  |

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
`appManager.isRefreshing`. Loading indicators wait before they show (`utils/delayedShow.svelte.ts`:
the feed skeleton 150ms, the progress bar 400ms), so a load that beats the delay shows nothing
rather than a flash; the skeleton covers a network refresh only when nothing local can be shown.

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

**Reactivity is per key, not per map.** `labelMap` / `labelsByItem` are plain Maps; per-item
reads (`hasLabel`, `getLabel`, so `isRead`, `getTagsForItem`, …) track that item's signal and the
whole-map scans (`readPositions`, `allTags`, …) track the label they scan for
(`utils/keyedSignals.svelte.ts`). A mutation must go through `addToState` / `removeFromState` and
then `triggerReactivity()`, which bumps only what changed — so marking one item read re-runs that
card, not every card on screen. A new query method must read through `getLabel`/`hasLabel` (or
track the label) or it won't update.

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
(only "Start Reading" does); each add surface — the Add modal (`add/AddModal.svelte`, behind every "+"), `AddFeedPanel`
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

| Route                | Purpose                                         |
| -------------------- | ----------------------------------------------- |
| `/`                  | Main feed (all articles from subscribed feeds)  |
| `/social`            | Shares from followed users                      |
| `/starred`           | Starred articles                                |
| `/feeds`             | Manage feed subscriptions                       |
| `/discover`          | Discover new feeds                              |
| `/saved`             | Library › Queue: Inbox / Archive of saves       |
| `/shelf`             | Library › Shelf: kept saves, books, PDFs; colls |
| `/highlights`        | Every highlight, grouped by source article      |
| `/highlights/review` | Review deck — a few highlights, one at a time   |
| `/search`            | Legacy link: opens the search overlay           |
| `/settings`          | Account and sync status                         |
| `/feedback`          | The userinput.app board, read and posted in-app |
| `/auth/login`        | Bluesky handle input                            |
| `/auth/callback`     | OAuth callback handler                          |

### Search

Search (Supporter, `utils/search.ts`'s `canUseSearch`: the plan flag _and_ `user.searchEnabled`,
the backend's operator switch) queries the reader's server-side index — see
`docs/plans/FULL_TEXT_SEARCH.md`. It is an **overlay, not a route**: `SearchOverlay` is mounted by
`AppShell` while `searchStore.isOpen`, which is `page.state.searchOpen` on a shallow history entry
(`searchStore.open()`), so Back closes it and the page underneath never unmounts. `/`, the sidebar,
both view switchers and a search button on `MobileBottomBar` (every page that has the bar) open it;
the old `/search` route just lands on the default view and opens it with `?q=`/`?kind=`. Without
search `/` keeps its old meaning (Saved search on `/saved`, else the switcher), the bottom bar keeps
the Saved-search button on Saved views, and `g` is the switcher for everyone. While it's up,
`keyboardStore.suspend()` stands the page's shortcuts down. A hit opens in the overlay's own reader
stack (`useReaderStack({ searchOverlay: true })`, `?read=` as usual; page stacks ignore the param
while `searchOpen` is set) via `resolveSearchHit`: the local copy when this
device has it, else a `contentTruncated` stub article for a feed the reader still follows (the
reader then fetches the archive's stored body), else the external URL. Search needs a connection;
offline the overlay hands the query to Saved search. The signed-in user is cached in localStorage, so
`AppShell` refreshes `/api/auth/me` once per boot — otherwise a plan change or a newly switched-on
feature would only reach an open session via Settings.

### Highlights

Highlights live in the `highlights` label's opaque `props.highlights` array, merged per-highlight by
id across alias rows (`utils/highlightAliases.ts`). Three things ride that array beyond the quote
itself: `lastReviewedAt` (the review deck's repeat-avoidance, synced for free), `reviewIntent`
(`soon`/`later`/`someday`/`never` — the deck's frequency tuning; `later` is the neutral default, and
even `never` only stops the highlight being dealt, it stays in the list and on Margin), and
`sourceUrl`/`sourceTitle` (source metadata: stamped on every new highlight from its article, and set
on highlights imported from Margin whose article isn't in any local cache — the search index's only
title for an item that was just highlighted). Because the whole array is written to `item_labels_cache.props` as opaque JSON,
any new per-highlight field reaches D1 and syncs across devices with no migration. `utils/highlightSource.ts` is the shared resolver both the list and the deck use so
they degrade identically. See [`docs/plans/HIGHLIGHT_REVIEW.md`](../docs/plans/HIGHLIGHT_REVIEW.md).

#### Saved PDFs: text and original

A saved PDF (`contentType: 'pdf'`) reads as its reflowed text, and `SavedReader` offers a
**Text / Original** toggle (remembered per device in `localStorage['skyreader-pdf-view']`). Original
mounts `feed/PdfViewer.svelte` in place of the text body: PDF.js (`pdfjs-dist`, legacy build,
lazy-imported so it costs nothing until used) draws each page to a canvas near the viewport and drops
it far away, with PDF.js's text layer on top for selection. The text body and its hooks unmount in
Original and re-attach on the way back; paged mode applies to the text only. The bytes come from `GET /api/saved/<rkey>/file`: the
original kept in R2, whether the PDF was uploaded or saved by link (the backend keeps a link's
original at save time, or on first open for an older save; most PDF hosts send no CORS headers). The CSP carries `worker-src 'self' blob:` for PDF.js's worker. PDF.js's image
decoders (OpenJPEG for JPEG 2000, JBIG2 for scans, QCMS for ICC colour) load by fixed filename from
its `wasmUrl` option, as WebAssembly or the JS fallback beside it; without `wasmUrl` those images
simply don't draw. `vite.config.ts`'s `pdfjsDecoders()` copies them to
`/_app/immutable/pdfjs/<pdfjs version>/` (outside the precache, fetched on demand), and they run in
the worker, a static asset the Pages middleware's CSP doesn't cover, so no `'wasm-unsafe-eval'` is
needed. The Original view opens at the zoom that PDF was last left at (`utils/pdfZoom.ts`,
`localStorage['skyreader-pdf-zoom']`, keyed by rkey via `PdfViewer`'s `zoomKey`; fit width is
unstored), and at the place it was last read, on any device: the `pdfPlace` item label on the
save's URI (`itemLabelsStore.getPdfPlace` / `setPdfPlace`, merged by `lastReadAt` like
`readProgress`), passed in as `place` and reported back through `onplace`. A place is the page in
the middle of the view and how far down it (`utils/pdfPlace.ts`), so it holds at any zoom or
width. It also carries the PDF's page count (`pages`), so `getReadActivity` counts Original-view
reading: the place's `lastReadAt` is activity, and when it's newer than any `readProgress` its
position is the progress (`pdfPlaceProgress`, in tenths of a page), so a PDF read only in Original
reaches Continue reading. A place saved before `pages` existed is activity without progress.
The viewer follows `place` (once laid out, on resize, and when a sync lands late) until the
reader scrolls, and reports nothing before that, so opening at the top can't overwrite it. While it's open, AppShell's font-size shortcuts (Shift +, Shift -, Shift 0) zoom it
instead (`claimPdfZoomShortcuts` / `openPdfZoom`). Harness: `/dev/pdf` (`?sample=jpx` for a JPEG 2000 image; highlighting there is live but local).

**The PDF's links work in Original.** After a page's text layer, `drawLinks` reads its
`getAnnotations()` and lays an `<a>` over each Link annotation in a `.pdf-links` layer above the
text layer (so the link, not the text, takes the tap; a link's click stops there and is never a
highlight tap). `utils/pdfLinks.ts` resolves the target up front: a web or mail URL opens in a new
tab (`javascript:`, `file:` and relative URLs are dropped); a destination, explicit or named, or a
`NextPage`-style action becomes a page and a `top` in PDF space. A jump drops a throwaway
`.pdf-jump` element at that point and `scrollIntoView`s it, so it works whichever element scrolls
(the reader overlay, or the window in the harness) and clears the header via `scroll-margin-top`.
Each jump pushes the scroller's offset onto `returnTo`, which the toolbar offers as ← page N;
a zoom change clears it, since an offset means nothing at another scale. The harness's page 1 and
`pdfFixture`'s `links` argument carry sample links.

**Zoom** keeps the point in the middle of the view where it was (`setZoom`, with the browser's own
scroll anchoring off on `.pdf-pages`). A page zoomed past the column spills into the reader's
whole width (`band`, the room beside the column less a 16px gutter), centred on the column while
it fits; only a page wider than all of that scrolls sideways inside `.pdf-pages`.

**Highlights are shared between the views**, because they are the same `TextQuoteSelector`s.
`utils/pdfTextModel.ts` reads every page's `getTextContent()` once and joins the runs the way the
extractor reflowed them (whitespace collapsed, a line-end `[a-z]-` joined to a lowercase
continuation without its hyphen, rotated runs dropped), keeping each character's offset. A
selector from either view then locates in the other with `locateQuote` (exact, then
whitespace-blind), and maps back to slices of runs. pdf.js draws one text-layer span per run
(`TextLayer.textDivs`), so a slice becomes a `Range`, and its rects become `.pdf-mark` boxes in a
layer under the text layer (multiplied into the drawing, so text stays selectable and crisp).
`PdfViewer` only draws and reports: `onselect` (mouse release), `oncommit` (a touch selection let
go of, mirroring the text view's commit-on-collapse) and `onhighlight` (a tap, found by hit-testing
the marks, since the text layer is on top). `SavedReader` hands those to `useHighlights`'s
`offerSelection` / `addHighlight` / `openHighlight`, so the same popover and writes serve both
views. There is no margin in Original, so the popover edits notes itself (`onNote` is dropped), and
a noted highlight wears a dot where it ends. Grab handles and double-click-a-paragraph are
text-view only. Text the extractor dropped (running headers, page numbers) can be highlighted on
the pages but won't show in the text. If you change how the extractor joins lines, change
`buildPdfTextModel` to match, or cross-view highlights stop lining up.

#### The Library: Queue and Shelf

The **Library** is the saves read two ways: the **Queue** (`/saved`, Inbox / Archive) and the
**Shelf** (`/shelf`). `components/library/LibraryIntro.svelte` opens both with a Queue | Shelf
switch; a Queue card on the Shelf says **On Shelf**, a Shelf item archived in the Queue says
**Archived** (one `library/LibraryChip` for both), and both item menus group their actions under Queue / Shelf headings
(`PopoverMenu`'s `section`). Home's Continue reading shares the Shelf's `isInProgress` rule and
counts an archived save still on the Shelf. The two halves share a layout: a Queue row
(`feed/SavedCard`) has the Shelf list row's anatomy (an icon beside the title; the kind for a book or
PDF, then source and author), and the Queue's Inbox / Archive and sort sit in the body under the
switch (`library/QueueControls`), where the Shelf keeps its own controls. The header keeps only
Search and Add. See `docs/plans/SHELF_PLAN.md` § The Library.

`/shelf` is the reference half of the Library: a view over the same saves, not a second pile
(`stores/shelf.svelte.ts`, `components/shelf/`). A save is on it when its `kept` label says so
(`props.kept` true/false, read across every alias via `itemLabelsStore.getKeptState`), else by kind
(PDFs and EPUBs default on, webpages off), or when it's in a collection. Collections are private,
ordered groups held server-side (`/api/shelf/collections`), keyed by the save's **rkey**, fetched
whole once per account after boot and cached in Dexie `metadata`. Their writes are optimistic,
online and account-only, and roll back with a toast instead of queueing. Taking a save off the Shelf
also removes it from its collections. See `docs/plans/SHELF_PLAN.md`.

#### Saved EPUBs

A saved EPUB (`contentType: 'epub'`, uploaded via `savesStore.uploadFile` → `POST /api/saved/epub`
or saved by link) reads as its text only, one `<section data-epub-chapter="N">` per chapter: the
book's markup is already the text, so there is no Original view and no `PdfViewer` path. Its
pictures arrive as `<img data-epub-src>` (a path in the kept book), which `SavedReader` points at
`savedAssetUrl` after sanitizing (`utils/epubContent.ts`); it's sanitized with no base URL, so the
book's own `#epub-c…` links stay hash links, and `handleFootnoteClick` (`utils/footnoteNav.ts`, run by
the link interception) jumps to them in place, turning the page in paged mode. A book opens paged
whatever the reader-wide `readerViewMode`; a switch made while reading it is remembered for that
book alone (`utils/epubViewMode.ts`, `localStorage['skyreader-epub-view']`, keyed by rkey), so
`SavedReader`'s toggles write there, not to the preference, for an EPUB. It shares
the PDF plan flag (`limits.pdfSaves`) and upload limits, with its own size cap
(`limits.maxEpubUploadBytes`). An unreadable or plan-gated EPUB link fails as `PdfExtractionError`
with `format: 'epub'`, saved as the `epub` / `epubUpgrade` note (`utils/saveAnywhere.ts`).
A book's cover is the picture-only section its text opens with (the backend puts the package's
cover there): `toLightSaved` reads its path off the body (`epubCoverPath`) into `coverPath` before
dropping the body, and `savedCoverUrl` turns it into the Shelf cover and Home card image. It's an
owner-only asset URL, so it never goes into `image` or a share.

#### Contents (table of contents)

`SavedReader` offers **Contents** (desktop: a panel under **Back**; mobile: `ReaderBottomBar`'s
`onContents`, opening a sheet; `c` on either) whenever there are two or more entries. In the text
view the list is read off the rendered body by `utils/readerToc.ts`: for a PDF or EPUB, the
`data-toc-title` / `data-toc-level` marks the conversion put on the text (the PDF's outline,
placed by `pdf-extractor`; the book's nav or NCX, by the backend's `services/epub.ts`), else the
article's h1–h6 ranked by the levels used, three deep. Marks are ignored on anything else, since a web
page's own `data-toc-*` means nothing here. In Original, the list is the PDF's outline, read by
`PdfViewer` (`onoutline`, `utils/pdfOutline.ts`) and followed with its `goTo`, which keeps the
← page N way back. Saves made before the marks existed fall back to headings. Entries hold elements,
not ids: a jump is `scrollIntoView` (cleared of the bar by `scroll-margin-top`) or the pager's
`goToElement`. The current entry is worked out when the list opens, not tracked while reading.
Harness: `/dev/book?toc=1`.

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

1. Update schema in the repo-root `lexicons/app/skyreader/...` (then republish it; see `docs/OAUTH_SCOPES.md`)
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

### Adding a Text Field

iOS Safari zooms the page into any focused `input`/`textarea`/`select`/`contenteditable` under 16px
and never zooms back out. The house pattern is a floor on touch screens:

```css
/* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
@media (hover: none) and (pointer: coarse) {
  .my-input {
    font-size: 1rem;
  }
}
```

A size derived from a preference (e.g. `calc(var(--article-font-size) * 0.9)`) needs
`max(1em, 16px)` — it can clear 16px at the default and drop under it at a smaller reading size.
`e2e/ios-zoom.spec.ts` measures computed sizes on a phone-emulated page: add the field's page to
`PAGES`, or, for a field behind a tap, a test that opens it and calls `expectNoZoomingFields`.

### Dark styles

Write dark styles the plain way, `@media (prefers-color-scheme: dark) { … }`, in app.css or a
component. The Settings theme (System / Light / Dark, `preferences.colorScheme`) pins a scheme with
`<html data-theme>`, and `postcss.color-scheme.js` compiles every such block into an OS-dark copy
guarded by `:not([data-theme='light'])` plus a pinned-dark copy, at unchanged specificity and source
order. Two things it can't reach: CSS built at runtime (emit both halves by hand, as
`utils/marginaliaInk.ts` does) and JS that asks `matchMedia('(prefers-color-scheme: dark)')` — read
the `data-theme` attribute first. app.html applies the stored choice before first paint.

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

Skyreader's lexicons live in the repo-root `lexicons/` directory, shared by every package. See
the root `CLAUDE.md` and `docs/OAUTH_SCOPES.md` (publishing).

## PWA Features

- **Service Worker**: `src/service-worker.ts` handles caching and offline support
- **Manifest**: `static/manifest.json` defines PWA metadata
- **IndexedDB**: Dexie.js provides offline data storage
- **Sync Queue**: Operations made offline are queued and synced when back online
