# Linkblog Plan — Shares as standard.site posts

> Status: **planning** · Author: design discussion, 2026-05-31
> Supersedes the custom `app.skyreader.social.share` sharing model.

## Summary

Today, sharing an article writes a custom `app.skyreader.social.share` record, aggregated
globally via the Jetstream firehose into a D1 `shares` table. This plan replaces that with
**standard.site posts**: sharing creates a `site.standard.document` in a dedicated, per-user
**linkblog publication**. The result is that every Skyreader user gets a real, portable linkblog
— readable by any Atmospheric app (Leaflet, docs.surf, …), rendered publicly by Skyreader at a
logged-out URL, and enriched with network-wide social context via Constellation.

The social layer stops being a self-hosted firehose/D1 system and becomes **"pull documents +
ask Constellation."** Nothing in the new design needs a maintained indexer.

### Why

- **Portability / interop** — a share becomes first-class Atmosphere content, not a Skyreader-only
  record. "The text is the product" (PRODUCT.md), now owned and portable.
- **A linkblog as a product** — users get a publication "and everything": a public page, a
  customizable name/icon, commentary, and boosts.
- **Less infrastructure** — retires a custom lexicon pair, the D1 `shares` table, and the share
  branch of the Jetstream poller.

## Decisions (settled)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Social-feed mechanism | **Fold into the pull model** — subscribing to a linkblog = an `atproto.documents` subscription scoped to that publication. No firehose/D1 for shares. |
| 2 | Where the shared URL lives | The document's **`links`** field (RFC-8288-style external resource ref). |
| 3 | Rich rendering / interop | `content` = **`pub.leaflet.content`** with a `website` link-card block + text block(s) for the note. |
| 4 | Reshares | Split: **boost** = `site.standard.graph.recommend` (bare); **quote** = a new `site.standard.document` whose `links` points at the original doc's AT URI (`rel: "repost"`). |
| 5 | Share body | Store a **generous excerpt** (~first paragraph) + card metadata; Skyreader fetches/renders the **full article on demand** via the `links` URL (existing feed-proxy reader path). |
| 6 | Publication | A **dedicated** `skyreader-links` publication, separate from any other standard.site blog the user has, with **user-customizable** name/description/icon. |
| 7 | Social context | **Constellation** (`constellation.microcosm.blue`) for recommend counts AND **"who else in the Atmosphere linked this article"** — both **in v1**. Cached in the proxy, degrades silently. |
| 8 | Public render | Logged-out **`/blogs/<handle-or-did>/`** SSR page rendering the linkblog from the proxy's PDS cache. |

## Data model

### The linkblog publication — `site.standard.publication`

- rkey: `skyreader-links` (fixed, one per user; distinct from the user's other publications).
- `url`: the **canonical base** → `https://skyreader.app/blogs/<did>/` (DID-based; see *Handle vs DID*).
- `name` / `description` / `icon`: user-customizable (defaults: name = "<display name>'s links",
  icon = avatar).
- Created **lazily on first share**.

### A share — `site.standard.document`

```jsonc
{
  "$type": "site.standard.document",
  "site": "at://<user-did>/site.standard.publication/skyreader-links",
  "title": "<shared article title>",
  "path": "/<rkey>",
  "publishedAt": "<now>",
  "description": "<~first paragraph excerpt>",      // durable fallback copy
  "textContent": "<plaintext note + excerpt>",       // search / fallback
  "links": [                                          // ← the external article
    { "uri": "https://example.com/the-article", "rel": "related" }
  ],
  "content": {                                        // ← rich, interoperable body
    "$type": "pub.leaflet.content",
    "...": "website link-card block (article) + text block(s) (the note)"
  },
  "bskyPostRef": { "uri": "...", "cid": "..." }       // optional: off-platform comments
}
```

- The **excerpt is deliberately generous** — it's the only durable copy if the source paywalls,
  link-rots, or is read offline. We do **not** denormalize the full article body anymore.
- Populated **at share time with no extra fetch** — the user is already reading the article in
  Skyreader, so the first paragraph + card metadata are in hand.

### A boost — `site.standard.graph.recommend`

```jsonc
{ "$type": "site.standard.graph.recommend", "document": "at://<author>/site.standard.document/<rkey>", "createdAt": "<now>" }
```

Bare by design (no commentary). Commentary → make a quote instead (a new document).

### A quote-reshare

A normal `site.standard.document` whose `links` entry is the **AT URI of the original document**
(`rel: "repost"`) instead of an https URL. It's its own linkblog entry because it carries a note.

## Architecture

```
WRITE                          READ FEED                       SOCIAL CONTEXT            PUBLIC
share in app                   pull per subscribed author      Constellation            /blogs/<id>/
  → publication (lazy)           via feed-proxy batch            (recommend counts,        SSR from
  → site.standard.document       (existing documents path,       "who else linked this")   proxy cache
  → recommend (boost)            scoped by publication)          cached in proxy, silent
  → document (quote)                                             degradation
```

- **No** self-hosted firehose, **no** D1 `shares` table, **no** Jetstream share branch.
- The only maintained state is the **feed-proxy SQLite cache** (documents + publication +
  a new Constellation cache).

### Read path — folds into the existing documents pipeline

- `feed-proxy/src/standard-site.ts` already fetches a publisher's `site.standard.document`
  records, resolves canonical URLs/publication metadata, caches publications, and returns the
  frontend's `SocialDocument` shape. `filterByPublication()` already supports scoping a
  subscription to a single publication — so "follow someone's links" = subscribe to
  `siteUri = at://them/site.standard.publication/skyreader-links`.
- **Gap to close:** `ProxyDocument` (`standard-site.ts:32`) maps a fixed field set and drops
  `links`; `content` is passed as opaque `unknown`. To render link posts the proxy must
  **surface `links`** (the external URL) and enough of the `website` card.

### Social context — Constellation, cached in the proxy

- **Recommend count + who:**
  `GET /links/count/distinct-dids?target=<doc-at-uri>&collection=site.standard.graph.recommend&path=.document`
- **Who else linked this article (v1):** Constellation indexes plain web URLs too —
  `target=<external article URL>&collection=site.standard.document&path=<links uri path>` →
  every link post across the Atmosphere pointing at that URL, with their notes.
- **Who quoted this:** same as above with `target=<doc-at-uri>`.
- Cache in a new `constellation_cache` table (mirror the `publication_cache` TTL pattern;
  short TTL since Constellation is firehose-fresh).
- **Degrade silently** — these are adornments. If Constellation is slow/down, the post still
  renders fully; we just omit the count / "also linked by" line. Never block the read.
- Send a `User-Agent` identifying Skyreader (their request). Self-hostable later if it becomes
  load-bearing.

### Render — a new `link-post` mode

`ArticleCard`'s `isDocumentMode` renders a document as *the thing you read* (canonicalUrl = the
doc). A link post is the inverse: the **primary card is the external article**; the linkblog entry
is a *secondary* permalink. Add a sibling mode keyed off "has an external `links` ref" (or "from a
`skyreader-links` publication"):

- primary: external article link-card (title / excerpt / thumbnail) → opens via feed-proxy reader
- the user's note
- social context line (recommends, "also linked by …") from Constellation
- a small permalink to `/blogs/<handle>/<rkey>`

"Open → fetch full article" branches on URI scheme: `https://` → feed-proxy reader; `at://`
(a quote's target) → the document pipeline. Both paths already exist.

### Public page — `/blogs/<handle-or-did>/`

~90% of the read side already exists in the proxy:

- handle→DID: `feed-proxy` `did-resolver`
- publication name/icon: `resolveSiteMeta()`
- documents (cached, 100/author): `fetchDocumentsForAuthor()`

New work: a **public SSR SvelteKit route** (no auth) that calls the proxy and renders
link-posts + notes, plus per-entry permalinks `/blogs/<handle>/<rkey>`. Needs no migration —
it can render whatever documents exist today, so it can ship first.

**Handle vs DID:** handles are mutable, DIDs are not. Canonical base = **DID** (`/blogs/did:.../`),
with `/blogs/<handle>/` as a pretty alias that resolves handle→DID and redirects. Keeps links
stable across handle changes. **BYO-domain future:** because publication `url` can be any https
origin, a power user could later point their linkblog at their own domain and self-host the
render, with Skyreader as fallback — keep the model open to this even though v1 is
`skyreader.app/blogs/...`.

## Phasing

Ordered to de-risk: read-only/public first (no migration), then write, then retire the old stack.

### Phase 0 — Public linkblog page (no migration, ships independently)
- SSR `/blogs/<handle-or-did>/` + `/blogs/<id>/<rkey>` routes, rendering from proxy cache.
- Handle↔DID resolution + alias redirect.
- Renders existing `site.standard.document` content today.

### Phase 1 — Write path (publication + share)
- Lazily create the `skyreader-links` publication on first share (DID-based `url`).
- New share action writes a `site.standard.document` (excerpt + `links` + `pub.leaflet` card),
  optimistic local insert (reuse `sharesStore` pattern).
- Settings surface to customize publication name/description/icon.

### Phase 2 — Read feed via pull model
- Surface `links` + `website` card in `ProxyDocument` (`standard-site.ts`).
- New `link-post` render mode in `ArticleCard`.
- "Open → fetch full article" via feed-proxy reader (https) / document pipeline (at://).
- Subscribing to a linkblog = `atproto.documents` subscription scoped to `skyreader-links`.

### Phase 3 — Social context (Constellation) — **v1 includes "who else linked this"** ✅ done
- Proxy helper + `constellation_cache` for: recommend counts/DIDs, "who else linked this
  article" (with handles + notes), "who quoted this." (`feed-proxy/src/constellation.ts`,
  `POST /social-context`; DID→handle resolution added to `did-resolver.ts`.)
- Boost action writes `site.standard.graph.recommend`; quote action writes a document with a
  `rel:repost` ref. (`backend` `linkblog-sync.ts` `writeBoost`/`deleteBoost` + `repostUri`;
  routes `POST/DELETE /api/linkblog/boost`, `POST /api/v2/social-context` passthrough.)
- **Affordance (settled):** one Share button on link posts → empty note = boost, note = quote.
- **Context line (settled):** counts + who (handles & notes), lazy-fetched on open.
- Render social-context line; silent degradation. (`frontend` `socialContext.svelte.ts`,
  `linkblog.svelte.ts` boost state, `ArticleCard.svelte`.)

### Phase 4 — Migration + teardown
- One-time backfill: for each existing `app.skyreader.social.share`, create the publication (if
  needed) + an equivalent `site.standard.document`.
- Transition window: keep reading the old collection so nothing disappears.
- Retire: `app.skyreader.social.share` + `app.skyreader.social.shareReadPosition` lexicons, the
  D1 `shares` table, the share branch of the Jetstream poller. Read-state folds into normal
  per-URL tracking.

### Phase 5 — Network-wide mentions on every item ("the Atmosphere knows about this")

Phase 3 puts social context on *linkblog posts*. Phase 5 generalizes it to **every item in the
feed** — regular RSS articles and standard.site links alike — by asking Constellation "who across
the Atmosphere has linked this URL?" and surfacing a quiet count: *"3 people are talking about
this."* It's the same backlink lookup Phase 3 already does, widened from one collection to all of
them and moved server-side so it's computed once and shared by every reader.

This phase ships independently of the linkblog write path — it enriches content that already
exists.

#### What Constellation gives us

Constellation indexes the whole firehose into a backlink graph keyed on the target string, so an
external article URL is the target of many record types, not just `site.standard.document`:

- `app.bsky.feed.post` — external embeds (`.embed.external.uri`) and rich-text link facets
  (`.facets[].features[].uri`)
- `site.standard.document` (linkblog entries), leaflet/whitewind/frontpage posts, etc.

Constellation indexes **plain `https://` web URLs**, not only `at://` targets — verified live
against `GET /links/all`: `https://atproto.com/blog/indexing-standard-site` returns
`app.bsky.feed.post` linkers (via `.embed.external.uri` and facet links) plus `network.cosmik.card`;
`https://www.theverge.com/` returns 30+ distinct bsky linkers. So the lookup works for arbitrary
feed-article URLs.

Use **`GET /links/all?target=<url>`** — one request returns *every* `(collection, path)` source
pointing at the URL with `records` + `distinct_dids` per path, so we don't enumerate collections by
hand; Constellation reports what's out there. Two non-obvious wrinkles the live data revealed:

- **Whitelist what counts as "talking."** Constellation indexes far more than discussion. The same
  query also surfaces our *own* `app.skyreader.feed.subscription.siteUrl`, bookmark/card types
  (`network.cosmik.card`, `app.blento.card`), etc. — subscribing to or bookmarking a URL is not
  commentary. Count post/linkblog-style collections (`app.bsky.feed.post`, `site.standard.document`,
  leaflet/whitewind/frontpage); ignore subscription/card records.
- **The headline number is a distinct-DID *union*, not a sum.** A single bsky post links a URL via
  `.embed.external.uri`, `.embed.media.external.uri`, *and* `.facets[].features[].uri`; a person who
  embeds *and* facet-links double-counts if you add the per-path `distinct_dids`. A truthful "N
  people" requires unioning the actual DID *sets* across the counted paths/collections (fetch the
  DID lists via `/links/count/distinct-dids` / `/links` per source and union), not summing the
  per-path totals from `/links/all`. Use `/links/all` to discover *which* sources exist, then union
  DIDs over the whitelisted ones.

#### Cache server-side, keyed by normalized URL — not in the feed blob

The mention count for a URL is identical for every user, so computing it per-card-per-user is pure
waste. Cache it **once in the proxy**, shared by all readers. Crucially, do **not** fold counts
into the feed's `parsed_json` blob (`app.ts` `cache.parsed_json`): that blob is re-parsed wholesale
every warm refresh, which erases any notion of "new items." Instead, a dedicated table keyed by the
**normalized article URL**:

```sql
CREATE TABLE IF NOT EXISTS mention_cache (
  url_hash      TEXT PRIMARY KEY,   -- hash of the *normalized* URL
  url           TEXT NOT NULL,
  distinct_dids INTEGER NOT NULL DEFAULT 0,
  sources_json  TEXT,               -- optional per-collection breakdown from /links/all
  first_seen_at INTEGER NOT NULL,
  checked_at    INTEGER NOT NULL
)
```

Keying by URL (not by feed) dedups across **both** users and feeds: the same article appearing in
three feeds — or linked in a linkblog *and* present in an RSS feed — is one row. At serve time,
left-join each item's normalized URL against `mention_cache` and attach the count; a miss or zero
renders nothing (silent degradation, same contract as Phase 3 — `constellation.ts`).

#### Cadence is the hard part, not volume

A freshly-published article has **~0 mentions at the moment it enters the feed** — nobody has seen
it yet to talk about it. So "enrich on first cache" yields zero for everything new, the opposite of
useful; discussion accumulates over the following hours/days. `mention_cache` therefore needs its
**own** freshness logic, decoupled from the ~5-minute feed TTL:

- On first sighting of a URL, query once, then **re-poll on a decay curve** — recheck hot for the
  first ~24–48h, back off, then freeze the row as "settled" and stop querying.
- **Never** re-query every URL on every warm tick — that just relocates the volume problem onto our
  own server.

Hook the *trigger* into the existing self-warming loop (`warmStaleFeeds()`, `app.ts`): it already
iterates active feeds with their items in hand, and only touches feeds someone actually requested
(`last_requested_at` window), which naturally scopes enrichment to content people read. Gate each
URL on `checked_at` + item age so most ticks do nothing. Net cost drops from `N_users × M_items` to
`M_distinct_URLs × repoll_count` — tractable enough that self-hosting Constellation stays deferred.

#### URL canonicalization is the make-or-break

Constellation matches the target **string exactly**. A feed's article URL almost never equals the
URL someone pasted into Bluesky: tracking params (`?utm_*`, `?ref=`), trailing slash, scheme,
`www`, AMP/mobile variants, feed GUID vs. canonical. Without a normalization pass (strip tracking
params; canonicalize scheme/host/slash; optionally query a couple of variants) the feature returns
false zeros for articles that have real discussion and feels broken. This is the actual engineering
work of the phase, independent of where the result is cached.

#### Render & signal

- A quiet count-only line on regular `ArticleCard`s, behind a **minimum threshold** (≥2–3 distinct
  DIDs) so we never query-then-hide noise. Calm and terse (PRODUCT.md) — *"3 people linked this."*
- Prefer the honest mechanical phrasing (*linked this*) over implying verified discussion
  (*talking about this*) unless we actually inspect the posts.
- Expand-to-see-who (handles + notes, the Phase 3 `alsoLinkedBy` shape) is an optional follow-on,
  fetched lazily on open — it carries the per-linker PDS `getRecord` cost, so keep it off the
  always-on path.

#### Work items

- `feed-proxy`: `mention_cache` table + cleanup branch alongside the existing TTL sweep
  (`app.ts` cleanup); a `getArticleMentions(url)` helper that uses `/links/all` to discover sources
  then unions distinct DIDs over a whitelisted set of collections (generalize `constellation.ts`); a
  URL-normalization helper; re-poll/decay gate wired into `warmStaleFeeds()`;
  serve-time join attaching counts to feed items.
- `frontend`: count line + threshold in `ArticleCard.svelte`; optional expand reusing the Phase 3
  social-context UI.

### Phase 6 — Linkblog discovery & onboarding

The empty state of "following linkblogs" is dead until you can *find* the ones worth following. This
phase answers **"which people I already follow on Bluesky have a Skyreader linkblog?"** and seeds a
logged-out/logged-in **`/discover`** of all linkblogs. Like Phase 0/5 it's read-side and ships
independently of the write path.

The feature is an **intersection**: `(my Bluesky follows) ∩ (everyone with a skyreader-links
publication)`. The two halves have very different costs.

- **My follows** — cheap. `app.bsky.graph.getFollows?actor=<did>` on the public AppView
  (`public.api.bsky.app`, already used for `getProfile`), no auth, 100/page, and each entry already
  carries handle + displayName + avatar — i.e. the follows call *is* the empty-state render data.
- **Membership ("has a linkblog")** — the cost center, and the design decision.

#### Decision (settled): publication marker → Constellation registry

Every `site.standard.publication` we write carries one **constant** field,
`skyreaderLinkblog: "https://skyreader.app/linkblog"` (`LINKBLOG_MARKER_URL` in
`backend/src/services/linkblog-sync.ts`). Constellation indexes that constant target across all
publications, so a **single** query enumerates every Skyreader linkblog author — no per-follow PDS
probing, no maintained indexer (the philosophy of this whole plan):

```
GET /links/all?target=https://skyreader.app/linkblog
  → links["site.standard.publication"][".skyreaderLinkblog"].distinct_dids   # the count
GET /links?target=https://skyreader.app/linkblog&collection=site.standard.publication&path=.skyreaderLinkblog
  → linking_records: [{ did, rkey }, …]                                       # the actual authors
```

**Why a marker rather than probing follows.** Probing each follow's PDS for the publication is
accurate and needs no new field, but scales with **O(my follows)** — a cold-start tax for
power-followers, blind to how small the product actually is. The registry scales with **O(total
linkblog population)**: while Skyreader is young that's ~one cheap query regardless of follow count,
and it's the same dataset `/discover` wants anyway. Intersect the registry DIDs with the follows
list locally.

**Why this is safe / why it works (both verified):**
- *Publications are extendable* — the `site.standard.publication` lexicon docs say so explicitly,
  and AT Proto records are open unions (validators ignore + pass through unknown fields). We write
  straight to the PDS via `putRecord`, so standard.site's renderer simply ignores the field.
- *Constellation indexes URI values at arbitrary custom paths on arbitrary lexicons* — confirmed
  live: `GET /links/all` for a web URL returns our own `app.skyreader.feed.subscription`'s `.siteUrl`
  field, a custom path on a custom lexicon Constellation has no built-in knowledge of. So the marker
  at path `.skyreaderLinkblog` will be indexed the same way.

**Constraints that fall out of "it's a registry key":**
- The marker MUST be a single global constant, **not** env-derived — dev/staging/prod must all write
  the identical target string or the registry fragments. (Hence a hardcoded `https://skyreader.app/…`
  even in local dev, where OAuth writes to the user's *real* PDS and hits the *real* firehose.)
- **Backfill is lazy**, no migration job: `ensureLinkblogPublication()` stamps the marker onto any
  pre-marker publication on the user's next share (non-destructive, at most one extra write per
  user), and `updatePublication()` re-stamps it on any settings save.

#### Work items — all done

- **Write path** — `LINKBLOG_MARKER_URL` constant + `skyreaderLinkblog` on the publication record in
  `ensureLinkblogPublication()` (create + lazy backfill) and `updatePublication()`.
  `backend/src/services/linkblog-sync.ts`.
- **`feed-proxy`** — `getLinkblogRegistry(db)` pages Constellation `/links` for the marker target,
  collecting distinct author DIDs, cached in a single-row `linkblog_registry_cache` (15-min TTL,
  serves stale on outage). Served at `GET /linkblog-registry`. (`feed-proxy/src/linkblog-registry.ts`,
  `app.ts`.)
- **`backend`** — `bsky-appview.ts` (`fetchFollows`/`fetchProfiles` against the public AppView, no
  auth); `linkblog-discovery.ts` intersects the registry with the user's follows
  (`getLinkblogFriends` = follows ∩ registry, profiles free from getFollows; `getLinkblogDiscover` =
  whole registry, friends-first, others' profiles resolved, capped at 100). Routes
  `GET /api/linkblog/discover/friends` and `GET /api/linkblog/discover` (`routes/linkblog.ts`,
  `FeedProxyClient.fetchLinkblogRegistry`). Each person carries `publicationUri` + `blogUrl` so the
  client can subscribe directly.
- **`frontend`** — `stores/linkblogDiscovery.svelte.ts` (lazy, session-cached, `subscribe()` =
  `atproto.documents` sub scoped to the publication); `components/LinkblogDiscovery.svelte` (people
  list, avatar/handle, one-tap Follow → Following state from existing subs); `/sources/discover`
  page (full registry) + friends onboarding wired into the `/sources` People empty state and an entry
  link. Calm/terse per PRODUCT.md, One-Blue Follow button per DESIGN.md.

**Caveat — verify in prod:** the marker→Constellation registry only fully proves out once real
stamped publications hit the firehose. The indexing mechanism is verified live (Constellation indexes
custom-lexicon URI paths — `app.skyreader.feed.subscription.siteUrl`), but the first real check is
querying `/links?target=https://skyreader.app/linkblog&collection=site.standard.publication&path=.skyreaderLinkblog`
after a publication is stamped.

#### Open questions (Phase 6)

- **`/discover` ranking** — recency of last post, recommend counts (Constellation), "recommended by
  people you follow," or a mix? Presentation choice; data's all there.
- **standard.site-native discover** — the publication lexicon also has `preferences.showInDiscover`
  (boolean). Set it (true by default?) so linkblogs surface in *standard.site's* discover too, or
  keep discovery Constellation-only for now? Orthogonal to our registry.
- **Marker stability** — keep the marker unversioned (`/linkblog`) and re-backfill if semantics ever
  change, vs. a versioned target (`/linkblog/v1`) that fragments the registry across versions.
  Defaulting to unversioned.

### Phase 7 — Link-post rendering & reshare refinement

Phases 1–3 shipped a working link post, but the *feel* was off: a heavyweight "linked by" badge
above the row, the commentary as a double-quoting `blockquote`, a visible "Loading article
content…" flash when opening (the full article was inline-fetched into the card), and two storage
shapes for a reshare (bare `recommend` boost vs. `document` quote). This phase makes a link post
read like *an article that happens to have a person attached*, and collapses the reshare model.

**Settled changes:**

1. **One reshare shape — the document.** Drop the bare-`recommend` boost from the share affordance.
   Every reshare writes a `site.standard.document` (a real linkblog entry, note optional), keyed by
   the external article URL and toggled by the one Share button. Resharing *another* linkblog post
   carries the original doc's AT URI as a `rel: "repost"` link alongside the `rel: "related"` article
   ref (already implemented in `linkblog-sync.ts`) — preserving the via-attribution chain. Label is
   just **Share / Shared** everywhere (the "Boosted"/"Quoted" split is gone). Social proof doesn't
   regress: Constellation's "who else linked this article" (Phase 5) now counts every reshare.
   - The `recommend`/boost **write path is removed entirely**: `writeBoost`/`deleteBoost` +
     `buildRecommendRecord` + `RECOMMEND_COLLECTION` (`linkblog-sync.ts`), the
     `POST/DELETE /api/linkblog/boost` routes, `boost`/`unboost`/`isBoosted` (`linkblog.svelte.ts`),
     the `LinkblogBoost` type, the `createBoost`/`deleteBoost` API client methods, the
     `linkblogBoosts` Dexie table (dropped in **db v33**), and the now-dead
     `repo:site.standard.graph.recommend` OAuth scope. A future ♥ "recommend" would be reintroduced
     fresh if ever wanted. *(Constellation's recommend-**count** read path in the proxy/social-context
     is a separate Phase-3 read feature and is left in place — see open question below.)*

2. **Collapsed row — inline "via" pill.** The `.share-attribution` top row is gone. The byline is a
   small **avatar + @handle pill** trailing the title in the metadata cluster (postfix; title leads,
   per "the text is the product"). It uses the **sharer's avatar** (not the Skyreader logo) so the
   *who* is glanceable; the leading icon stays the **article's favicon** (source identity, consistent
   with RSS rows).

3. **Expanded — note as prose, card opens the reader.** The note renders as **normal prose** (not a
   blockquote — it's the author's own voice, and blockquote breaks once notes get rich formatting).
   The card **no longer inline-fetches the full article** (no loading flash): expanded = note +
   **website link-card** (favicon · site · title · excerpt · thumb). Tapping the card opens the
   **in-app fullscreen reader** (`SavedReader`), which fetches the full article with its own loading
   state — keeping reading in-app rather than bouncing to a raw browser tab. "Open in browser" stays
   a quiet secondary action. (`SavedReader`'s own note lead also switches blockquote → prose.)

**Deferred follow-ups (shape decided, not built):**

- **Read-state / dedup by normalized URL** — the same article can appear as a link post *and* in an
  RSS sub. Key read-state on the normalized article URL (the Phase 5 normalization) so reading once,
  via either path, marks both.
- **Merge same-URL shares from multiple sharers** — collapse N followed linkbloggers sharing the
  same article into one card with stacked avatars + each note, overlapping with Phase 5's "N people
  linked this." Changes the card model (one card, N sharers), so noted now.

## What we retire

- Lexicons: `app.skyreader.social.share`, `app.skyreader.social.shareReadPosition`.
- D1: the `shares` table + indexes.
- Backend: share routes (`backend/src/routes/shares.ts`), `pushShareToPds`, reshare-chain
  counting, and the share branch of `backend/src/durable-objects/jetstream-poller.ts`.
- The denormalized `reshare_count` (replaced by Constellation queries).

## Copy & voice (Atmosphere framing)

A linkblog is **meant to be public**, so the usual public-visibility tradeoff becomes the pitch,
not a caveat: "Your linkblog lives in your PDS — portable across the Atmosphere, public by design."
Keep it calm and terse (PRODUCT.md). Lead with portability/ownership, not "PDS."

## Open questions

- **Recommends UI weight** — show a raw count, or "recommended by people you follow" + a total?
  (Constellation gives both; this is a presentation choice.)
- **Offline shares** — excerpt is always available; full body needs a prior fetch. Do we
  pre-cache the full article on save for offline-readable shares, or accept excerpt-offline?
- **Publication customization scope** — name/description/icon only (URL root stays
  DID-stable), or also expose a slug / custom domain (BYO-domain) sooner?
- **Quote vs boost affordance** — one share button with a "add a comment?" affordance that
  picks document-vs-recommend, or two distinct actions?

## References

- [standard.site docs](https://standard.site/docs/introduction/)
- [`site.standard.document` lexicon](https://standard.site/docs/lexicons/document/)
- [`site.standard.graph.recommend` lexicon](https://standard.site/docs/lexicons/recommend/)
- [Indexing Standard.site (atproto blog)](https://atproto.com/blog/indexing-standard-site)
- [Constellation backlink index](https://constellation.microcosm.blue/) ·
  [source](https://github.com/at-microcosm/microcosm-rs/tree/main/constellation) ·
  [API guide](https://www.bskyinfo.com/tools/constellation/)
- Existing code: `feed-proxy/src/standard-site.ts`, `backend/src/routes/shares.ts`,
  `backend/src/durable-objects/jetstream-poller.ts`, `frontend/src/lib/stores/shares.svelte.ts`,
  `frontend/src/lib/components/ArticleCard.svelte`
