# Skyreader Backend Development Guide

**Important:** Always run `npm run check` before finishing work to verify types and formatting.

## Project Overview

Skyreader backend is a Cloudflare Workers API that serves as a gateway between the frontend and the AT Protocol ecosystem. It handles authentication, the feed timeline, social features, saved articles, labels, and background Jetstream polling.

**Feed reads are served from D1, not the proxy.** The Fly.io proxy is the crawler: it pushes new
and edited items into `feed_items` (`POST /api/internal/ingest`), pulls the set of feeds to
crawl (`GET /api/internal/crawl-set`), and reports which feeds are failing to crawl
(`POST /api/internal/feed-health`) — all authenticated with the shared `FEED_PROXY_SECRET`
(fail-closed when unset). A client refresh is one `GET /api/v2/timeline` — a single query joining
subscriptions and read state. Because reads never touch the crawler, a broken feed just goes quiet;
the health report is the only thing that tells a reader its feed is dead rather than idle, and its
payload is the COMPLETE unhealthy set (recovery = absence from the next report). All three internal
endpoints stamp `sync_state.crawler_heartbeat_at`, and the timeline reports `ingestActive` as the
AND of that heartbeat and `sync_state.timeline_enabled` — the operator's rollout gate. A crawler
heartbeat only says a crawler is attached; it arrives seconds into a backfill that takes hours, so
the gate is what actually admits readers to the archive (and, set back to `'0'`, is the fast
rollback that returns every client to the legacy batch path with no deploy). Either half false and
clients stay on `/batch`; the request short-circuits rather than building a page they will discard.
See `docs/plans/D1_FEED_TIMELINE.md`. The proxy is still on the path for `/api/extract`, feed
discovery, and social context — plus the one crawl per new subscription (`warmFeedIntoArchive`)
and the subscription-gated pull-through in `/api/v2/feeds/fetch`.

**standard.site documents are following feeds into D1.** The JetstreamPoller DO now drains
`site.standard.document` (+ its `app.standard-reader.collection` sidecar) straight into
`documents_v2`, filtered server-side to the subscribed-author DID set; `/api/v2/documents/batch`
and `/api/v2/documents/get` serve from D1 once `sync_state.documents_v2_enabled` is `'1'` and from
the proxy until then, wire-identical either way. Writes have their own switch
(`documents_ingest_enabled`) so a flood can be paused without touching reads or the subscriptions
stream; it stops every background write — the drain, the poller's back catalogues and the cron's
reconcile — leaving only the operator backfill endpoint. Every path that creates an
`atproto.documents` subscription — the API, the Atmosphere subscribe button, the Atmosphere graph
import, the PDS→local subscription pull, and a subscription mirrored in by the poller — goes
through `ensureAuthorDocuments`, because a subscription whose author was never listed serves
`status:'error'` on every poll until something lists them. (Those subscribe/sync paths are
deliberately **not** gated by `documents_ingest_enabled`: a reader subscribing during an incident
should still see their linkblog, and each walk is one author, deduped to one an hour. The switch
governs the background loops — the drain, the poller's queue, the cron's reconcile.)

**The budget everything here is sized against** is `D1_QUERIES_PER_INVOCATION`: 1,000 per Worker
invocation, counting each statement inside a `batch` separately _and_ sharing that ceiling with
outbound `fetch()`es (it is the read-subrequest limit), so `document-store.ts` counts both as
subrequests. A `QueryLedger` is per invocation, not per loop: the cron's two reconcile passes
share one, the operator endpoint's batch shares one, and `/api/sync` threads one through both of
its halves so the walks it schedules are admitted against what the request has already spent.
Each fan-out asks `canAffordBackfill` before starting an author and leaves the rest in the
reconcile queue rather than throwing halfway through a walk that has already written rows.
`BACKFILL_QUERY_COST` is a true worst case — every per-row term is either one statement (the
prune is a single `updated_at`-scoped DELETE; the sidecars are one read plus one capped batch) or
capped (`MAX_SITE_RESOLVES_PER_BACKFILL`, `MAX_COLLECTION_WRITES_PER_BACKFILL`,
`MAX_BLOB_INFLATIONS_PER_BACKFILL`). A walk resolves
the author's DID once for both of its listings and every blob it fetches (`PdsMemo`, now on the
apply context) — `resolvePdsUrl` is an uncached fetch,
and the second one is a subrequest the listing term does not budget. A Leaflet post over ~100 KB
offloads its pages to a blob (`content.blobPages`) that `inflateLeafletBlobPages` fetches at write
time; that is the one per-row PDS fetch here, so a walk spends at most
`MAX_BLOB_INFLATIONS_PER_BACKFILL` of them and stamps `updated_at` on a row it already inflated
rather than overwriting it with the listing's stub — which is what lets successive reconcile passes
converge on a whole offloaded back catalogue instead of re-fetching the same ten bodies. The sidecar cap is the floor
that arithmetic leaves at every other cap at once, not a flat limit: a walk spends its unspent
headroom on sidecars and records what it still couldn't afford as `collections_pending`, which
keeps the author in the reconcile queue instead of parking them for an interval. The same ceiling
is why an applied event costs a single statement: the cap eviction and bookkeeping settle once per
author at the end of a cycle. **Still unbounded:** the PDS→local subscription pull's insert batch
is one statement per restored row, capped only by the plan's mirror limit (1000/5000), so a very
large restore can exhaust the invocation on its own — it charges the ledger (which is what stops
walks being scheduled on top of it) and logs `subscription_pull_batch_large`, but nothing chunks
it. See `docs/plans/DOCUMENTS_TO_D1.md` and RUNBOOK §4e.

## Key Concepts

### AT Protocol Basics

- **DID**: Decentralized Identifier (e.g., `did:plc:abc123`) - permanent user ID
- **Handle**: Human-readable username (e.g., `user.bsky.social`)
- **PDS**: Personal Data Server - where user data is stored
- **Lexicon**: Schema definition language for record types (like JSON Schema)
- **NSID**: Namespaced identifier for schemas (e.g., `app.skyreader.feed.subscription`)

### OAuth Requirements

AT Protocol OAuth has specific requirements:

- **PKCE**: Required for all flows (S256 challenge)
- **DPoP**: Demonstrating Proof of Possession - tokens are bound to a key pair
- **Nonce**: Auth servers may require nonce in DPoP proofs (handle `use_dpop_nonce` error)

**Local Development:** Uses AT Protocol's [localhost client exception](https://atproto.com/specs/oauth#localhost-client-development) - a public client flow with virtual metadata, no tunnel or signing keys needed.

**Production:** Uses confidential client with `private_key_jwt` authentication. The `client_id` URL (`/.well-known/client-metadata`) must be publicly fetchable.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed documentation.

### Entry Point

**File:** `src/index.ts`

- Routes requests to handlers
- Adds CORS headers (validates against `ALLOWED_ORIGINS`)
- Checks per-user rate limits
- Handles scheduled triggers (cron)

### Routes

| File                              | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `src/routes/auth.ts`              | OAuth flow (login, upgrade, callback, logout, metadata)    |
| `src/routes/timeline.ts`          | `GET /api/v2/timeline` — the whole refresh, one query      |
| `src/routes/ingest.ts`            | Crawler endpoints: item ingest, crawl set, feed health     |
| `src/routes/documents.ts`         | Document backfill + proxy-vs-D1 shadow compare (internal)  |
| `src/routes/feeds-v2.ts`          | Single-feed read (D1 + pull-through), discover, docs       |
| `src/routes/social.ts`            | Social feed, popular, grouped, detect-content              |
| `src/routes/shares.ts`            | User shares CRUD (with PDS sync)                           |
| `src/routes/subscriptions.ts`     | Subscription CRUD (with PDS sync)                          |
| `src/routes/records.ts`           | PDS record listing                                         |
| `src/routes/reading.ts`           | Article + document read positions (forward delta)          |
| `src/routes/labels.ts`            | Unified item labels (read/starred/archived/tags)           |
| `src/routes/saved.ts`             | Saved articles CRUD                                        |
| `src/routes/saved-pdf.ts`         | PDFs + EPUBs (Supporter): upload, kept originals, cleanup  |
| `src/routes/shelf.ts`             | Shelf collections: private, ordered groups of saves        |
| `src/routes/saved-connections.ts` | Semble connections other people drew off saves (badges)    |
| `src/routes/export.ts`            | `GET /api/export` — saves + highlights as Markdown/BibTeX  |
| `src/routes/recommends.ts`        | One-tap public recommends (+ standard.site copy)           |
| `src/routes/integrations.ts`      | Semble/Margin writes to the user's PDS                     |
| `src/routes/settings.ts`          | User settings                                              |
| `src/routes/sync.ts`              | PDS full sync, subscription sync, sync status              |
| `src/routes/lexicons.ts`          | Serve lexicon schemas at /.well-known/lexicons             |
| `src/routes/health.ts`            | `/api/health` (shallow) + `/api/health/deep` (gated)       |
| `src/routes/telemetry.ts`         | `/api/telemetry/error` — sampled client error reports      |
| `src/routes/vitals.ts`            | `/api/telemetry/vitals` — field vitals → daily histograms  |
| `src/routes/guest.ts`             | `/api/guest/*` — the unauthenticated reading surface       |
| `src/routes/feedback.ts`          | `/api/v2/feedback` — userinput.app board read + post       |
| `src/routes/newsletters.ts`       | `/api/newsletters/*` — newsletter address + blocked list   |
| `src/routes/search.ts`            | `GET /api/search` — full-text search (Supporter)           |
| `src/routes/bsky-sources.ts`      | `/api/v2/bluesky-sources` — Bluesky likes/bookmarks on/off |
| `src/routes/channel-items.ts`     | `GET /api/channels/:uuid/items` — saved-search matches     |
| `src/routes/channels.ts`          | Channel sync; `PUT /api/channels/order` alone moves a row  |

**Email newsletters** (Supporter) arrive through the Worker's `email()` handler, not HTTP:
Cloudflare Email Routing hands it mail for `NEWSLETTER_EMAIL_DOMAIN`, and each message becomes a
`feed_items` row under a per-sender, per-reader `newsletter:<inbox_id>/<sender>` feed. Those
subscriptions are private and local-only — never crawled, never on the PDS, readable only by the
inbox owner — and every subscription path checks `isNewsletterSubscription`. See
[`docs/plans/EMAIL_NEWSLETTERS.md`](../docs/plans/EMAIL_NEWSLETTERS.md).

**PDFs** are a Supporter feature (`TierLimits.pdfSaves`), by link or upload. By link, the proxy
fetches and the pdf-extractor Worker parses; `FeedProxyClient.extract` sends `allowPdf: false` for a
reader without the plan or out of their daily parses (`services/pdf-quota.ts`). An upload
(`POST /api/saved/pdf`, raw bytes) is streamed into R2 as it arrives, checked on the way (size,
signature, SHA-256; `checkedFile` in `routes/saved-pdf.ts`), and then streamed from R2 to the
extractor (`services/pdf-extractor.ts`), so the API Worker never holds a whole file (up to 50 MB),
only a 5 MiB multipart part (`SavedFileStore.put` with a bare stream); a refused or unreadable
file is deleted again. It becomes an ordinary URL-less save (`source = 'upload'`,
`content_type = 'pdf'`), so highlights and search key on its record uri like any other save. The
original file is kept private in R2 (`SAVED_FILES`, one row per file in `saved_files`), served only
to its owner at `GET /api/saved/<rkey>/file`, and deleted with the save. Uploads never reach the
PDS or a Semble/Margin backing collection. A PDF saved by link keeps its original the same way:
`storeLinkedPdfForUrl` fetches it from the URL under `waitUntil` after the save, and
`GET /api/saved/<rkey>/file` keeps it on first open for a save that has none (streaming it through
uncached only when storage is full). Limits: file size, uploads per month (uploads only) and stored
bytes (every kept original plus every snapshot picture, `storedFileBytes`) from the plan, plus the
shared daily parse cap. Snapshot pictures are Supporter-only too (`TierLimits.snapshotImages`).
Every read, write and delete of a kept original goes through `SavedFileStore`
(`src/services/saved-file-store.ts`), never the bucket directly: `saved_files.storage` names the
store holding each file (`'r2'`, the only one today, located by `r2_key`), with `blob_cid` /
`record_uri` reserved for a file kept as a blob in the reader's atproto space. The pictures a
snapshot keeps go through it too (`putImage`). Snapshot bodies and staged linked books are not kept
originals and still use `SAVED_FILES` directly.

**EPUBs** ride the same plan flag and the same upload/storage limits (`maxEpubUploadBytes` is their
own size cap, 50 MB like a PDF's), but are read in this Worker (`src/services/epub.ts`: unzip, walk the OPF
spine, strip each chapter to reading markup with `HTMLRewriter`, one
`<section data-epub-chapter="N">` per chapter, capped at 1 MB like a PDF's text), so they spend no
daily parse allowance. The book is never held whole: `parseEpub` takes a `RangedFile` and reads the
zip's tail, its central directory, then one ranged read per entry (a few chapters ahead), so an
upload is parsed from where it was kept and a linked book from where it was staged. An upload is
`POST /api/saved/epub` (`content_type = 'epub'`, original kept in R2 like a PDF's). By link, the proxy's `/extract` recognises an EPUB and answers `epub: true`
without caching; `FeedProxyClient.extract` then fetches and reads the book itself, and the save keeps
its original like a linked PDF (`storeLinkedOriginalForUrl`). Pictures stay in the book: the text
carries `<img data-epub-src="<path in zip>">`, and `GET /api/saved/<rkey>/asset?path=` serves one
entry out of the kept original with four ranged R2 reads (`readStoredEpubEntry`), owner-only and
sandboxed (an SVG must not run as a page on the API origin); a linked save with no kept original
keeps it on the first picture asked for — once per save, not per picture (`keepLinkedOriginalOnce`:
an in-isolate promise plus a one-a-minute D1 claim in `rate_limits`; the other requests wait for its
row), and answers `pdf_storage_full` when there's no room, which the reader turns into a note. The
book is downloaded once per save by link: `extractEpub` streams it into R2 before reading it
(`stageLinkedBook` in `services/linked-originals.ts`, `staged/epub/<did>/<sha256(url)>.epub`, replacing
an earlier read's), the save moves that object into place instead of
fetching again (hashing it on the way), and the hourly cron sweeps staged books no save adopted. Ids and internal hrefs are scoped by spine position
(`#epub-c3-note12`, `epubAnchorId`), which the frontend's footnote navigation follows. The book's
own table of contents (the EPUB 3 nav's `toc`, else the EPUB 2 NCX) rides the text as
`data-toc-title` / `data-toc-level` on the element each entry lands on (its chapter's section when
the entry names the chapter, or its target didn't survive the cleanup), which the reader's
Contents list reads. The cover the package names (EPUB 3 `cover-image`, EPUB 2
`<meta name="cover">`, else an image item called cover) opens the text as
`<section data-epub-cover>` when no kept chapter already shows it; the frontend reads the book's
first picture-only section off its body (`epubCoverPath`) for the Shelf and Home cards, so no
column holds it and older books whose spine opens on a cover page get one too.

**Bluesky likes and bookmarks** are the same kind of private, local-only subscription
(`bsky-likes:<did>` / `bsky-bookmarks:<did>`, `src/services/bsky-sources.ts`): turned on from
Manage Sources (`POST /api/v2/bluesky-sources`), their link posts are ingested into `feed_items`
by a gated refresh that runs under `waitUntil` after each `GET /api/v2/timeline`. Likes are read
from the reader's own repo and hydrated through the public appview (no extra scope); bookmarks
need `BSKY_BOOKMARKS_SCOPES` (`getBookmarks`, proxied to the appview). Every guard that keeps a
newsletter off the PDS and out of the crawl set asks `isLocalOnlySubscription` /
`notLocalOnlySql` (`src/services/local-only-sources.ts`), which covers both.

Guest reading mode is the only unauthenticated surface that reads the archive,
and it is **read-only**. `POST /api/guest/timeline` is a query over
caller-supplied feed URLs (≤50) that never fetches; the starter channels in
`src/config/starter-feeds.ts` are unioned into `GET /api/internal/crawl-set`, so
the curated feeds stay crawler-fresh with no subscriber behind them.

Adding a source needs an account, which is what keeps that invariant simple: the
only feeds a guest can name are ones the crawler already owns, so no
unauthenticated path can steer a fetch at a caller-chosen URL and nothing
relaxes the `callerSubscribes` rule in `feeds-v2.ts`. Preserve that if you ever
reopen guest adds — an earlier version had a bounded warm endpoint, and its
bounds (per-IP rate, a per-feed freshness claim, a global daily ceiling, and an
orphan reaper) all existed to contain exactly that one write path. See §4f of
[`docs/RUNBOOK.md`](../docs/RUNBOOK.md).

Integration writes are gated per-capability, not per-app: `POST /api/integrations/semble/connections`
(a `network.cosmik.connection` edge between two URLs) checks `SEMBLE_CONNECTION_SCOPES`, which is
deliberately **not** part of `SEMBLE_SCOPES` — folding it in would 403 every existing user's card
saves until they re-authed. `GET /api/integrations/status` reports the two separately
(`scopeStatus.semble` vs `scopeStatus.sembleConnections`). Same pattern as `PCKT_SCOPES` /
`ATMOSPHERE_SCOPES`; see `src/config/scopes.ts`.

**Scopes are progressive and checked semantically** — see [`docs/OAUTH_SCOPES.md`](../docs/OAUTH_SCOPES.md).
Sign-in asks for the base only; an optional feature (`ScopeFeature` in `src/config/scopes.ts`)
is requested the first time it's used, via `POST /api/auth/upgrade`, and a gate that fails
answers `insufficientScopesResponse('<feature>')` so the frontend can ask for exactly that.
Skyreader's own collections are requested through the `app.skyreader.authFull` permission set
once `OAUTH_PERMISSION_SETS` is on. Never compare `granted_scopes` strings directly: a PDS
returns a permission set expanded (`repo?collection=…`), so every check goes through
`grantsScopes()` in `src/services/scope-check.ts`.

### Services

| File                                      | Purpose                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `src/services/oauth.ts`                   | PKCE, DPoP, handle resolution, session management            |
| `src/services/feed-parser.ts`             | RSS/Atom/RDF parsing                                         |
| `src/services/feed-proxy-client.ts`       | Client for Fly.io feed proxy                                 |
| `src/services/standard-site.ts`           | standard.site record mapping, digest, publication cache      |
| `src/services/document-store.ts`          | The D1 document store: apply, backfill, reconcile, serve     |
| `src/services/document-flags.ts`          | `documents_v2_enabled` / `documents_ingest_enabled` switches |
| `src/services/pds-client.ts`              | PDS API client                                               |
| `src/services/client-auth.ts`             | Confidential client auth helpers                             |
| `src/services/share-sync.ts`              | Push/delete shares to/from PDS                               |
| `src/services/subscription-sync.ts`       | Sync subscriptions to/from PDS                               |
| `src/services/rate-limit.ts`              | Per-user per-endpoint rate limiting (D1-backed)              |
| `src/services/user-tier.ts`               | Tier lookup (free/supporter)                                 |
| `src/services/search-index.ts`            | Search index change feed + document builder (reads D1/R2)    |
| `src/services/search-query.ts`            | Reader query → safe, quoted FTS5 terms                       |
| `src/services/saved-search.ts`            | Saved queries from channels, their scopes, new-item streams  |
| `src/services/newsletters.ts`             | Newsletter inboxes + the `email()` handler (inbound mail)    |
| `src/services/newsletter-email.ts`        | Parse one newsletter email into a feed item                  |
| `src/services/bsky-sources.ts`            | Bluesky likes/bookmarks as private sources (walk + ingest)   |
| `src/services/local-only-sources.ts`      | The one "private, never crawled, never on the PDS" predicate |
| `src/services/saved-file-store.ts`        | `SavedFileStore`: every read/write/delete of a kept original |
| `src/services/archive/records.ts`         | Saves/highlights/snapshots ↔ their future space records      |
| `src/services/archive/snapshots.ts`       | Capture each body a save gets as an immutable R2 snapshot    |
| `src/services/archive/snapshot-images.ts` | Keep the pictures each snapshot's body shows                 |
| `src/services/export/`                    | Export over those records; DOI/arXiv ids; Markdown, BibTeX   |

### Observability

| File                               | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `src/observability/sentry.ts`      | SDK options + the `reportError()` wrapper every call site uses |
| `src/observability/scrub.ts`       | `beforeSend` credential scrubbing (keeps DIDs, drops tokens)   |
| `src/observability/heartbeat.ts`   | Dead-man's-switch ping for the every-minute cron               |
| `src/observability/ops-metrics.ts` | What the cron records to D1 for the admin's ops panel          |
| `src/utils/logger.ts`              | `log.info('event', { … })` — structured, queryable log lines   |
| `src/utils/request-context.ts`     | Request id / route / DID in AsyncLocalStorage                  |

Error reporting goes through `reportError()` (exceptions) or `reportMessage()`
(threshold crossings, with a fingerprint so a persistent condition is one issue),
never `Sentry.captureException` directly, so the vendor stays a one-file decision.

Logging: use `log.*` with a stable low-cardinality `event` slug and put the details
in fields. Workers Logs indexes the fields of a logged object but treats a string
as opaque text, so `log.info('feed_ingested', { itemCount })` is queryable and an
interpolated `console.log` sentence is not. Never log a credential — there is no
redaction layer on this path.

The request id is ambient (`getRequestId()`), so nothing has to thread it: it lands
on every log line, every `reportError()` tag, the `X-Request-Id` response header,
and outbound feed-proxy calls.

The every-minute cron also _records_: poller lag and cron liveness to
`system_status`, the proxy's cache stats every 5th minute, and an hourly row in
`metrics_snapshots` (pruned at 90 days). The admin renders those tables directly.
The snapshot's counts come from D1 (`users`, `feeds`, `feed_items`, …) and its
health numbers from the `system_status` rows — including `feeds_with_errors`,
which is the crawler's `feedsInError` and is recorded NULL, not 0, when the proxy
row is stale. Recording failures never withhold the cron heartbeat — losing a data
point is not an outage; see the note on `runRecordingStep()`.

The browser reports its own errors to `/api/telemetry/error` (unauthenticated by
design — an error on the login screen counts, and the route is answered before
session resolution so a degraded D1 can't turn the report into a 500). That route is the only thing that
talks to Sentry on the client's behalf: no SDK ships in the frontend bundle, and
every field the client sends is length-capped and validated against a closed set
of `kind`s before it becomes a log line or a Sentry tag.

Alert thresholds, SLOs, alert policy, secrets, log queries, and incident
procedures: [`docs/RUNBOOK.md`](../docs/RUNBOOK.md).

### Durable Objects

| File                                         | Purpose                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `src/durable-objects/jetstream-poller.ts`    | Two Jetstream streams (subscriptions, documents) drained per alarm |
| `src/durable-objects/search-index.ts`        | One per reader: FTS5 index over what they read, saved, highlighted |
| `src/durable-objects/percolator.ts`          | Saved-search matcher: new items × saved queries, via scratch FTS5  |
| `src/durable-objects/follow-links-poller.ts` | One per reader: background follows-links refresh, own budget       |

**Full-text search** (Supporter, behind `sync_state.search_enabled`) is a per-reader DO, not D1:
D1 can't export a database holding an FTS5 table, and per-user indexes outgrow its 10 GB. The
index _pulls_ — cursors over `item_labels_cache` (`read`, `highlights`) and `saved_articles`, each
changed key rebuilt from scratch by `buildIndexDocs` (`src/services/search-index.ts`) — so a write
only nudges it (after the response, from the one hook at the end of `serveRequest`), a search
catches up first, and the first sync from zero is the backfill. Saves are hard-deleted, so a saved
DELETE triggers a diff of the index's saved set. See `docs/plans/FULL_TEXT_SEARCH.md`.

**Saved searches** (Supporter, behind `sync_state.saved_search_enabled`) do NOT use that index: it
only holds what a reader already touched, and alerts are for what they haven't.

- **Channel writes.** A channel config carrying `query` is mirrored into `saved_queries` on every
  channel write (`syncSavedQueries`, which reads the rows back from D1).
- **Matching.** The `Percolator` DO pulls new `feed_items` (by `seq`), `documents_v2` rows (by
  `indexed_at`), `follow_link_shares` (by `first_seen_at`) and, for a query whose channel takes in
  the reader's saves (`saved_queries.include_saves`, from `librarySources`), `saved_articles` (by
  `id`). A save is matched on its kept body, looked back over whole (not 30 days), read once
  archived, served only while it exists, and spared by retention. It loads full bodies (R2 included)
  only for items some entitled query covers, and indexes the batch into a scratch FTS5 table with
  the search tokenizer. It writes hits to `channel_matches`, one per normalized URL per channel,
  and every source a story arrived from to `channel_match_sources`.
- **Follows links.** The article behind a covered link is read once per URL through the proxy's
  `/extract` (`services/link-bodies.ts`, web pages only) and kept in R2 for 7 days, within a
  per-reader daily budget. A link matches on its words and card at once, and again on the article
  when it lands.
- **Edits.** Inserts are guarded on the query's `updated_at`, so an edit mid-pass can't get stale
  hits written back.
- **Scheduling.** The minute cron nudges the DO, and new or edited queries backfill 30 days. See
  `docs/plans/SAVED_SEARCH_CHANNELS.md`.

### Storage

**D1 Database** (all storage is in D1, no KV):

Key tables:

- `users` - User profiles (did, handle, tier, timestamps)
- `sessions` - Server-side sessions (tokens, DPoP key, expiry)
- `subscriptions_cache` - Cached feed subscriptions from PDS
- `shares` - Aggregated share data from Jetstream
- `feeds` - One row per crawled feed (title/site/image + `last_ingest_at`), plus the crawler's
  health verdict: `error_count`/`last_error`/`next_retry_at`/`last_fetch_at` (unix seconds), which
  the timeline serves to readers as `feedHealth`, and `crawl_stale` for a feed the crawler isn't
  reaching at all (operator-only; the admin alarms on it). `last_ingest_at` is publishing cadence,
  NOT health — it only moves when a fetch yields a new item
- `feed_items` - The feed archive the timeline serves: every item the crawler has ever pushed,
  keyed `(feed_url, guid)` with a monotonic `seq`. Never pruned in ordinary operation — see
  `docs/plans/D1_FEED_TIMELINE.md`
- `documents_v2` - One row per `site.standard.document` record: the raw record (`record_json`)
  plus the scalars the serve path queries on. Written by the poller and by backfill, capped at 100
  rows per author
- `collections_v2` - `app.standard-reader.collection` sidecars (curated magazine editions), paired
  to their document by rkey, with the resolved item previews persisted after the first read
- `publications_cache_v2` - Publication base URL / icon / name / theme / fonts, 24h TTL and a 5m
  negative TTL. Replaces 0031's `publications_cache`, whose `base_url` is NOT NULL and so can't
  hold a negative entry
- `document_authors` - Per-author ingest bookkeeping: last successful list (drives the reconcile
  queue), whether the last list saw the author's whole repo, and the last backfill error with its
  timestamp — a failed list holds that author out of the reconcile queue for a doubling backoff, so
  an author nobody can list (deleted account, dead PDS) can't monopolise the only self-heal there is
- `documents` / `publications_cache` - orphaned from the pre-proxy era; still not read or written.
  They stay until the proxy document path is decommissioned
- `item_labels_cache` - Unified labels (read/starred/archived/tags)
- `saved_articles` - Saved/bookmarked articles
- `saved_snapshots` - One row per capture of a save's body (hash, URL, time, method); the body is
  in R2 (`SAVED_FILES`). Deleted with the save. See `docs/plans/ARCHIVE_RECORDS.md` § Snapshots
- `saved_snapshot_images` - One row per picture a snapshot kept (address, type, hash, store); the
  bytes are in the save's `SavedFileStore`, shared by captures that show the same picture. The
  reader falls back to them at `GET /api/saved/<rkey>/snapshot-image?url=` when the site's fails
- `shelf_collections` / `shelf_collection_items` - Shelf collections and their members (by saved
  rkey); private, never on the PDS. See `docs/plans/SHELF_PLAN.md`
- `social_read_positions_cache` - Legacy social read tracking (superseded; document
  reads now live in `item_labels_cache` as `item_type='document'`/`label='read'`)
- `semble_connections` / `semble_connection_seen` - Semble connections (`network.cosmik.connection`)
  the poller kept because an end is someone's save, and when each reader last looked. See
  `docs/plans/SEMBLE_CONNECTIONS.md`
- `user_settings` - User preferences
- `rate_limits` - Per-user rate limiting
- `sync_state` - Jetstream cursor, the archive generation token, the crawler heartbeat,
  `timeline_enabled` (the rollout gate: only an explicit `'0'` holds clients on the batch path),
  and the document switches: `documents_v2_enabled` (reads from D1; only an explicit `'1'`),
  `documents_ingest_enabled` (the poller's document stream; only an explicit `'0'` stops it) and
  the `documents_apply_cap` override
- `system_status` - Cron-written health board (cron liveness, poller lag, proxy stats)
- `metrics_snapshots` - Hourly trend points behind the admin's sparklines (90-day retention)
- `client_vitals` - Field vitals as daily histogram buckets (counts only, no reports; 90 days)
- `saved_queries` - Saved-search channels mirrored from channel configs (query, sources, backfill)
- `channel_matches` - What each saved search matched, one row per story (90-day retention)
- `channel_match_sources` - Every source each matched story arrived from (feed, author, sharer)
- `follow_link_sync` / `follow_link_shares` - Follows links: per-reader refresh state and the shares.
  The minute cron refreshes readers who opened them this week (or whose saved search covers them)
  every 30 min, each in its own `FollowLinksPoller`; `sessions.client_id` is what lets a token
  refresh run with no request. See `docs/plans/FOLLOWS_LINKS_PLAN.md`, "Background refresh"

## Common Tasks

### Adding a New API Endpoint

1. Create handler in `src/routes/`
2. Add route case in `src/index.ts`

### Adding a New Lexicon

1. Add schema in the repo-root `lexicons/app/skyreader/`
2. Serve it from `src/routes/lexicons.ts`; if it's a new collection, add it to `authFull.json` and `SKYREADER_REPO_SCOPES`
3. Publish it (`docs/OAUTH_SCOPES.md`)

### Debugging OAuth Issues

1. Use `npx wrangler tail` to stream backend logs
2. Common errors:
   - `use_dpop_nonce`: Need to retry with nonce from response header
   - `invalid_client_metadata`: client_id URL not accessible or metadata invalid (production only)

## Environment Variables

### wrangler.toml

```toml
[vars]
FRONTEND_URL = "https://skyreader.app"
ALLOWED_ORIGINS = "https://skyreader.app,https://staging.skyreader.app,..."
FEED_PROXY_URL = "https://skyreader-feed-proxy.fly.dev"

SENTRY_ENVIRONMENT = "production"   # "staging" in [env.staging]

# Secrets (set via `wrangler secret put`):
# FEED_PROXY_SECRET   - shared with the Fly.io proxy, both directions: outbound
#                       proxy calls and the inbound crawler endpoints
#                       (/api/internal/ingest, /api/internal/crawl-set), which
#                       are fail-closed when it is unset
# SENTRY_DSN          - error reporting (unset ⇒ silent no-op)
# HEARTBEAT_URL       - dead-man ping for the every-minute cron
# HEALTH_CHECK_SECRET - gates /api/health/deep (X-Health-Secret header)
#
# GIT_COMMIT_SHA is passed by CI at deploy time (`--var GIT_COMMIT_SHA:<sha>`)
# and reported by /api/health; a manual deploy reports "dev".
```

## Local Development Setup

### D1 Database Setup

1. Create your own D1 database: `npx wrangler d1 create skyreader`
2. Copy the `database_id` from the command output
3. Replace `YOUR_D1_DATABASE_ID` in `wrangler.toml` with your database ID
4. Run migrations: `npx wrangler d1 migrations apply skyreader --local`

For staging, create a separate database with `npx wrangler d1 create skyreader-staging` and update the staging `database_id`.

## Deployment Checklist

1. Create D1 database: `npx wrangler d1 create skyreader`
2. Update `wrangler.toml` with database ID
3. Run all migrations: `npx wrangler d1 migrations apply skyreader --remote`
4. Set secrets: `npx wrangler secret put FEED_PROXY_SECRET`
5. Deploy: `npx wrangler deploy`
6. Verify: `curl https://your-api.workers.dev/.well-known/client-metadata`

## Lexicon Schemas

Skyreader's lexicons live in the repo-root `lexicons/` directory, shared by every package. See
the root `CLAUDE.md` and `docs/OAUTH_SCOPES.md` (publishing).
