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

| #   | Decision                   | Choice                                                                                                                                                                                     |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Social-feed mechanism      | **Fold into the pull model** — subscribing to a linkblog = an `atproto.documents` subscription scoped to that publication. No firehose/D1 for shares.                                      |
| 2   | Where the shared URL lives | The document's **`links`** field (RFC-8288-style external resource ref).                                                                                                                   |
| 3   | Rich rendering / interop   | `content` = **`pub.leaflet.content`** with a `website` link-card block + text block(s) for the note.                                                                                       |
| 4   | Reshares                   | Split: **boost** = `site.standard.graph.recommend` (bare); **quote** = a new `site.standard.document` whose `links` points at the original doc's AT URI (`rel: "repost"`).                 |
| 5   | Share body                 | Store a **generous excerpt** (~first paragraph) + card metadata; Skyreader fetches/renders the **full article on demand** via the `links` URL (existing feed-proxy reader path).           |
| 6   | Publication                | A **dedicated** `skyreader-links` publication, separate from any other standard.site blog the user has, with **user-customizable** name/description/icon.                                  |
| 7   | Social context             | **Constellation** (`constellation.microcosm.blue`) for recommend counts AND **"who else in the Atmosphere linked this article"** — both **in v1**. Cached in the proxy, degrades silently. |
| 8   | Public render              | Logged-out **`/blogs/<handle-or-did>/`** SSR page rendering the linkblog from the proxy's PDS cache.                                                                                       |

## Data model

### The linkblog publication — `site.standard.publication`

- rkey: `skyreader-links` (fixed, one per user; distinct from the user's other publications).
- `url`: the **canonical base** → `https://skyreader.app/blogs/<did>/` (DID-based; see _Handle vs DID_).
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
  "description": "<~first paragraph excerpt>", // durable fallback copy
  "textContent": "<plaintext note + excerpt>", // search / fallback
  "links": [
    // ← the external article
    { "uri": "https://example.com/the-article", "rel": "related" },
  ],
  "content": {
    // ← rich, interoperable body
    "$type": "pub.leaflet.content",
    "...": "website link-card block (article) + text block(s) (the note)",
  },
  "bskyPostRef": { "uri": "...", "cid": "..." }, // optional: off-platform comments
}
```

- The **excerpt is deliberately generous** — it's the only durable copy if the source paywalls,
  link-rots, or is read offline. We do **not** denormalize the full article body anymore.
- Populated **at share time with no extra fetch** — the user is already reading the article in
  Skyreader, so the first paragraph + card metadata are in hand.

### A boost — `site.standard.graph.recommend`

```jsonc
{
  "$type": "site.standard.graph.recommend",
  "document": "at://<author>/site.standard.document/<rkey>",
  "createdAt": "<now>",
}
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

`ArticleCard`'s `isDocumentMode` renders a document as _the thing you read_ (canonicalUrl = the
doc). A link post is the inverse: the **primary card is the external article**; the linkblog entry
is a _secondary_ permalink. Add a sibling mode keyed off "has an external `links` ref" (or "from a
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

### Phase 5 — Atmosphere context on every item ("where this is being talked about")

Phase 3 puts social context on _linkblog posts_. Phase 5 generalizes it to **every item in the
feed** — regular RSS articles and standard.site links alike — by asking Constellation "who across
the Atmosphere has referenced this URL, and _how_?" It's the same backlink lookup Phase 3 already
does, widened from one collection to all of them, **sliced by the kind of reference**, and moved
server-side so it's computed once and shared by every reader.

The original cut of this phase surfaced one flat count (_"3 people linked this"_). That throws away
the most useful signal — _where_ and _how_ the link is being engaged — and is also dishonest:
saving and highlighting aren't discussing. A thoughtful **linkblog note**, a **Bluesky** thread, a
**margin.at** highlight on a specific passage, and a saved **Semble** card are four different
invitations. So the headline becomes a **lead lane** (the most meaningful kind, with its honest
verb) and the rest roll into _"+N more,"_ expanding to a per-kind breakdown.

This phase ships independently of the linkblog write path — it enriches content that already
exists.

#### Source lanes — the whitelist becomes a typed mapping

Constellation indexes the whole firehose into a backlink graph keyed on the target string, so an
external article URL is the target of many record types — and it indexes **plain `https://` web
URLs**, not only `at://` targets (verified live: `GET /links/all` for
`https://atproto.com/blog/indexing-standard-site` returns `app.bsky.feed.post` linkers via
`.embed.external.uri` + facet links plus `network.cosmik.card`; `https://www.theverge.com/` returns
30+ distinct bsky linkers). So the lookup works for arbitrary feed-article URLs.

Rather than a yes/no "counts as talking" whitelist, Phase 5 maps each meaningful `(collection,
path)` source into a named **lane** with its own label, honest verb, and icon:

| Lane          | Collection → path                                                                                            | Verb          | What it is                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------- |
| **Linkblogs** | `site.standard.document` → `.links[].uri`                                                                    | _noted_       | Skyreader / standard.site link posts (commentary) |
| **Bluesky**   | `app.bsky.feed.post` → `.embed.external.uri`, `.embed.media.external.uri`, both `…#link.uri` facet spellings | _posted_      | Posts embedding or facet-linking the URL          |
| **margin.at** | `at.margin.note` → `.target.source`                                                                          | _highlighted_ | Highlights / annotations anchored on the page     |
| **Semble**    | `network.cosmik.card` → `.content.url`, `.url`                                                               | _saved_       | The URL saved into a card / collection            |

- **Linkblogs** and **Bluesky** carry commentary text (a note / a post body) — these are
  _discussion_. **margin.at** and **Semble** are _marks_ on the article (a highlight, a saved card),
  qualitatively different and labeled honestly as such.
- **Ignored, not bucketed:** our own `app.skyreader.feed.subscription.siteUrl`, generic bookmarks
  (`community.lexicon.bookmarks.bookmark`), referrer/analytics paths, and post-like collections from
  other apps we don't lane yet (`pub.leaflet.document`, `net.anisota.feed.post`, `app.tomarigi.feed.post`,
  `place.stream.chat.message`). A new linking app simply doesn't appear until we add a lane for it —
  graceful, never a miscount.
- **The whitelist must be path-precise, not collection-precise** — verified live, this is the
  make-or-break. `GET /links/all?target=https://anisota.net/harvest` returns
  `net.anisota.beta.game.session.sessionContext.referrer` (337 dids) and
  `net.anisota.beta.game.log.metadata.referrer` (330 dids): a game logging the page as an HTTP
  _referrer_, not 600+ people discussing it. The same trap lives _inside_ a laned collection — for
  `app.bsky.feed.post`, count only `.embed.external.uri` / `.embed.media.external.uri` / the two
  `…#link.uri` facet paths, and drop `.text`, `.embed.images[].alt`, `.bridgyOriginalUrl`. A lane is
  a set of `(collection, exact-path)` tuples, never a whole collection.
- **NSIDs verified live (2026-06-01):** `at.margin.note.target.source` (margin.at) confirmed on both
  test URLs; `network.cosmik.card` (`.content.url` / `.url`) is the only card-type backlink on a
  known-Semble URL — Semble writes the shared **Cosmik** card lexicon, not a `semble.*` NSID. Also
  noted: `site.standard.document` can reference a URL via an inline body facet, not only `.links[].uri`
  — the Linkblogs lane may need that second path so body-mentions aren't missed.

Use **`GET /links/all?target=<url>`** — one request returns _every_ `(collection, path)` source with
`records` + `distinct_dids` per path; bucket each into its lane (or drop it). Two non-obvious
wrinkles the live data revealed, now applied **per lane**:

- **Bucket, don't enumerate.** `/links/all` tells us which sources exist; we never enumerate
  collections by hand. The lane registry decides which buckets render.
- **Each per-lane count is a distinct-DID _union_, not a sum.** A single bsky post links a URL via
  `.embed.external.uri`, `.embed.media.external.uri`, _and_ `.facets[].features[].uri`; summing the
  per-path `distinct_dids` double-counts someone who embeds _and_ facet-links. A truthful per-lane
  "N people" unions the DID _sets_ across that lane's paths (fetch the DID lists via
  `/links/count/distinct-dids` / `/links` per source and union). The **total** — for the threshold
  and the _"+N more"_ roll-up — is the union across _all_ lanes: a person who noted _and_ posted is
  one person in the total, but legitimately appears in both lanes.

#### Cache server-side, keyed by normalized URL — per-lane breakdown

The breakdown for a URL is identical for every user, so computing it per-card-per-user is pure
waste. Cache it **once in the proxy**, shared by all readers. Crucially, do **not** fold it into the
feed's `parsed_json` blob (`app.ts` `cache.parsed_json`): that blob is re-parsed wholesale every
warm refresh, which erases any notion of "new items." Instead, a dedicated table keyed by the
**normalized article URL**, storing the per-lane breakdown rather than a single integer:

```sql
CREATE TABLE IF NOT EXISTS mention_cache (
  url_hash      TEXT PRIMARY KEY,   -- hash of the *normalized* URL
  url           TEXT NOT NULL,
  total_dids    INTEGER NOT NULL DEFAULT 0,  -- distinct-DID union across ALL lanes (threshold + "+N more")
  lanes_json    TEXT,               -- [{ lane, dids, sampleDids? }] per non-empty lane, in priority order
  first_seen_at INTEGER NOT NULL,
  checked_at    INTEGER NOT NULL
)
```

Keying by URL (not by feed) dedups across **both** users and feeds: the same article appearing in
three feeds — or linked in a linkblog _and_ present in an RSS feed — is one row. `lanes_json` keeps
lanes in priority order so the lead is `lanes[0]` without re-sorting. A miss or a sub-threshold
total renders nothing (silent degradation, same contract as Phase 3).

**Read path — a dedicated `/mentions` endpoint, not a feed-item join (changed from the original
plan).** The original cut said "attach the breakdown to each feed item at serve time." That doesn't
survive the client: the frontend's article ingest (`articleMerge.selectNewArticles`) **only inserts
new rows and never updates existing ones**, so a count embedded at ingest would freeze at first
sight — the opposite of "discussion accumulates over hours/days." So mentions are fetched **by URL,
decoupled from the article**, exactly like Phase 3: `POST /mentions { urls[] }` → cached breakdown
per URL (returns empty + triggers a decay-gated background enrich on a cold miss; never blocks). The
client (`articleMentions.svelte.ts`) batches + dedups per-card calls and memoizes for the session,
re-polling a cold miss once. Backend passthrough: `POST /api/v2/mentions` (`feeds-v2.ts`).

#### Cadence is the hard part, not volume

A freshly-published article has **~0 mentions at the moment it enters the feed** — nobody has seen
it yet to talk about it. So "enrich on first cache" yields zero for everything new, the opposite of
useful; discussion accumulates over the following hours/days. `mention_cache` therefore needs its
**own** freshness logic, decoupled from the ~5-minute feed TTL:

- On first sighting of a URL, query once, then **re-poll on a decay curve** — recheck hot for the
  first ~24–48h, back off, then freeze the row as "settled" and stop querying.
- **Never** re-query every URL on every warm tick — that just relocates the volume problem onto our
  own server.

Hook the _trigger_ into the existing self-warming loop (`warmStaleFeeds()`, `app.ts`): it already
iterates active feeds with their items in hand, and only touches feeds someone actually requested
(`last_requested_at` window), which naturally scopes enrichment to content people read. Gate each
URL on `checked_at` + item age so most ticks do nothing. Net cost drops from `N_users × M_items` to
`M_distinct_URLs × repoll_count` — tractable enough that self-hosting Constellation stays deferred.

#### URL canonicalization is the make-or-break

Constellation matches the target **string exactly**. A feed's article URL almost never equals the
URL someone pasted into Bluesky: tracking params (`?utm_*`, `?ref=`), trailing slash, scheme,
`www`, AMP/mobile variants, feed GUID vs. canonical. Without a normalization pass the feature
returns false zeros for articles that have real discussion and feels broken. This is the actual
engineering work of the phase, independent of where the result is cached.

**Shipped (`url-normalize.ts`), and what the live data forced:** lowercase host, drop fragment +
default port, strip a tracking-param allowlist, sort remaining params, trim a non-root trailing
slash. Two things are deliberately **not** normalized, both verified against live Constellation —
because it matches the exact shared string and a feed's article URL is normally the site's own
canonical (which is also what people paste):

- **Keep `www`.** Stripping it turned `https://www.theverge.com/` (22–30+ real Bluesky linkers)
  into a _false zero_ — the shared URL keeps the `www`. This was caught only by running the real
  lookup, not the mocks.
- **Keep the scheme** (http feeds stay http) — upgrading would mismatch linkers who pasted http.

Single canonical form for v1 (no multi-variant probing yet); this is the one place to tune if
matching proves lossy.

#### Render & signal — lead lane, roll-up, honest verbs

- **Lead lane inline.** The always-on line on a regular `ArticleCard` shows the single
  highest-priority non-empty lane with its lane icon, count, and honest verb: _"✍ 3 linkblog
  notes."_ Priority order = **Linkblogs → Bluesky → margin.at → Semble** (commentary before marks).
  Behind a **minimum threshold** (total ≥ 2–3 distinct DIDs) so we never query-then-hide noise.
- **Roll-up.** Trailing _"· +N more ▾"_ where N is the distinct people in the _other_ lanes not
  already counted in the lead lane (union math, not a sum). Tapping it expands the row.
- **Expanded breakdown.** Each non-empty lane on its own line — icon, count, honest verb
  (_noted / posted / highlighted / saved_). The **Linkblogs** and **Bluesky** lanes can lazily
  resolve to the actual people + notes (the Phase 3 `alsoLinkedBy` shape) on open — this carries the
  per-linker PDS `getRecord` cost, so keep it off the always-on path. margin.at / Semble stay
  count-only in v1.
- **Honest phrasing throughout** — _noted / posted / highlighted / saved_, never a blanket "talking
  about this." A highlight isn't a discussion; a saved card isn't commentary.
- Calm and terse (PRODUCT.md): one line at rest, never a metrics strip (the algorithmic-feed
  anti-reference). Color stays reserved per DESIGN.md — neutral lane icons, muted-ink count, no
  badge fills.

##### Render refinement — the Atmosphere row (shipped, supersedes the lead-lane line above)

The first cut put an always-on lead-lane line on _every_ row (collapsed included) and expanded the
roll-up vertically. In practice it added chrome to the scannable list and split "see who's talking"
from "add your own" across the card. The shipped design folds both into one **Atmosphere row**:

- **Only when the card is open.** The row is gone from the collapsed list entirely — collapsed rows
  stay clean title lines ("the text is the product"). It renders below the article body, above the
  action bar, for articles only (link posts keep the Phase 3 context block).
- **All lanes in one inline row, no vertical roll-up.** Each lane is a pill — `[icon] [count]` when
  others have referenced it, `[icon] [label]` when empty. No lead-lane / "+N more" chevron.
- **Each lane does double duty (see + create).** Tapping a lane expands an accordion (one at a time)
  that lazily resolves its **network references for all four lanes** — @handle · note · ↗ link-out
  (the deferred "per-person expand," now built; see below). A **"+ create"** sits at the foot of the
  expansion: note → the share flow, Margin/Semble → their save handlers, Bluesky → a compose intent.
- **Create-capable lanes are always present when open** (note / Margin / Semble), even at zero
  count, so the affordance is always reachable; Bluesky shows only when it has a count.
- Semble/Margin therefore **move out of the buried overflow menu** into the lane row for articles
  (documents keep the action-bar/overflow copies). Counts stay always-on + cheap (`articleMentions`);
  people resolve only on expand.

#### Work items — shipped

- `feed-proxy`:
  - **lane registry** `lanes.ts` (`{ id, label, verb, noun, icon, collections, excludePaths }[]`),
    path-precise via `laneForSource(collection, path)`. All four NSIDs/paths verified live: Linkblogs
    `site.standard.document`, Bluesky `app.bsky.feed.post` (excludes `.text` / `.embed.images[].alt` /
    `.bridgyOriginalUrl`), margin.at `at.margin.note.target.source`, Semble `network.cosmik.card`.
  - `url-normalize.ts` (see canonicalization note — keeps `www`/scheme).
  - `mentions.ts`: `computeMentions(url)` (`/links/all` → bucket → union DIDs per lane + total),
    `enrichMentions` (decay gate, `first_seen_at`-anchored hot→cool→settled curve, upsert),
    `readCachedMentions` (no-network read + threshold + due flag). `mention_cache` table + cleanup
    branch (`app.ts`).
  - `POST /mentions` endpoint (batch, deduped, non-blocking background enrich). Warm-loop pre-warm
    hook `warmFeedItemMentions` gated by `warmMentionsEnabled` (off in tests, on in prod via
    `WARM_MENTIONS`).
  - Tests `mentions.test.ts` (normalization, bucketing/noise-exclusion, per-lane + total DID union,
    cache/threshold/decay) + a live smoke check against real Constellation.
- `backend`: `FeedProxyClient.fetchArticleMentions` + `handleV2Mentions` (`feeds-v2.ts`), routed at
  `POST /api/v2/mentions` (`index.ts`).
- `frontend`:
  - `articleMentions.svelte.ts` — batched, deduped, session-memoized lazy store (always-on counts).
  - `mentionLaneItems.svelte.ts` — lazy, session-memoized per-`(url, lane)` store for the expand;
    shared in-flight promise; silent degradation.
  - `ArticleCard.svelte` — the **Atmosphere row** (see "Render refinement" above): only-when-open,
    all lanes inline, accordion expand → per-lane people (@handle · note · ↗) + "+ create" footer.
    Semble/Margin gated to document mode in the action bar/overflow. `bluesky` butterfly in
    `Icon.svelte`; margin/Semble/standard-site brand glyphs reused.
  - `MentionLane` / `ArticleMentions` / `MentionLaneEntry` types; `api.fetchArticleMentions` +
    `api.fetchMentionLaneItems`.

**Per-person expand — shipped (all four lanes).** The expand lazily resolves the actual references
for the opened lane via a new proxy path `POST /mention-lane` (`feed-proxy/src/mention-lane.ts`:
`getMentionLaneItems` → `/links/all` discovery filtered to the lane → `/links` per source, dedup by
author, cap 8 → per-collection note + link-out). Link-outs are lane-specific: Bluesky
(`bsky.app/profile/<did>/post/<rkey>`) and Linkblogs (`skyreader.app/blogs/<did>/<rkey>`) build a
stable permalink from did+rkey; margin.at / Semble degrade to handle + best-effort note (no known
permalink yet). Cached in `constellation_cache` (`lane-items:<lane>|<normUrl>`, 5-min TTL, empties
cached too). Backend passthrough `FeedProxyClient.fetchMentionLaneItems` + `handleV2MentionLane`
(`POST /api/v2/mention-lane`). Tests `mention-lane.test.ts`.

**Deferred follow-on — follows-aware ordering.** The shared cache is unpersonalized, but the client
could re-rank lanes/people toward DIDs the user follows (Phase 6 follows data), e.g.
_"2 people you follow noted this."_ Off the shared path, client-side only; noted, not built.

**Open follow-up — margin.at / Semble link-outs + note shapes.** The two _mark_ lanes resolve
handle + a best-effort note but no permalink (their record shapes / public URL formats weren't
verified live). Verify `at.margin.note` and `network.cosmik.card` shapes against real records and
add real link-outs.

### Phase 6 — Linkblog discovery & onboarding

The empty state of "following linkblogs" is dead until you can _find_ the ones worth following. This
phase answers **"which people I already follow on Bluesky have a Skyreader linkblog?"** and seeds a
logged-out/logged-in **`/discover`** of all linkblogs. Like Phase 0/5 it's read-side and ships
independently of the write path.

The feature is an **intersection**: `(my Bluesky follows) ∩ (everyone with a skyreader-links
publication)`. The two halves have very different costs.

- **My follows** — cheap. `app.bsky.graph.getFollows?actor=<did>` on the public AppView
  (`public.api.bsky.app`, already used for `getProfile`), no auth, 100/page, and each entry already
  carries handle + displayName + avatar — i.e. the follows call _is_ the empty-state render data.
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

- _Publications are extendable_ — the `site.standard.publication` lexicon docs say so explicitly,
  and AT Proto records are open unions (validators ignore + pass through unknown fields). We write
  straight to the PDS via `putRecord`, so standard.site's renderer simply ignores the field.
- _Constellation indexes URI values at arbitrary custom paths on arbitrary lexicons_ — confirmed
  live: `GET /links/all` for a web URL returns our own `app.skyreader.feed.subscription`'s `.siteUrl`
  field, a custom path on a custom lexicon Constellation has no built-in knowledge of. So the marker
  at path `.skyreaderLinkblog` will be indexed the same way.

**Constraints that fall out of "it's a registry key":**

- The marker MUST be a single global constant, **not** env-derived — dev/staging/prod must all write
  the identical target string or the registry fragments. (Hence a hardcoded `https://skyreader.app/…`
  even in local dev, where OAuth writes to the user's _real_ PDS and hits the _real_ firehose.)
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
  (boolean). Set it (true by default?) so linkblogs surface in _standard.site's_ discover too, or
  keep discovery Constellation-only for now? Orthogonal to our registry.
- **Marker stability** — keep the marker unversioned (`/linkblog`) and re-backfill if semantics ever
  change, vs. a versioned target (`/linkblog/v1`) that fragments the registry across versions.
  Defaulting to unversioned.

### Phase 7 — Link-post rendering & reshare refinement

Phases 1–3 shipped a working link post, but the _feel_ was off: a heavyweight "linked by" badge
above the row, the commentary as a double-quoting `blockquote`, a visible "Loading article
content…" flash when opening (the full article was inline-fetched into the card), and two storage
shapes for a reshare (bare `recommend` boost vs. `document` quote). This phase makes a link post
read like _an article that happens to have a person attached_, and collapses the reshare model.

**Settled changes:**

1. **One reshare shape — the document.** Drop the bare-`recommend` boost from the share affordance.
   Every reshare writes a `site.standard.document` (a real linkblog entry, note optional), keyed by
   the external article URL and toggled by the one Share button. Resharing _another_ linkblog post
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
     fresh if ever wanted. _(Constellation's recommend-**count** read path in the proxy/social-context
     is a separate Phase-3 read feature and is left in place — see open question below.)_

2. **Collapsed row — inline "via" pill.** The `.share-attribution` top row is gone. The byline is a
   small **avatar + @handle pill** trailing the title in the metadata cluster (postfix; title leads,
   per "the text is the product"). It uses the **sharer's avatar** (not the Skyreader logo) so the
   _who_ is glanceable; the leading icon stays the **article's favicon** (source identity, consistent
   with RSS rows).

3. **Expanded — note as prose, card opens the reader.** The note renders as **normal prose** (not a
   blockquote — it's the author's own voice, and blockquote breaks once notes get rich formatting).
   The card **no longer inline-fetches the full article** (no loading flash): expanded = note +
   **website link-card** (favicon · site · title · excerpt · thumb). Tapping the card opens the
   **in-app fullscreen reader** (`SavedReader`), which fetches the full article with its own loading
   state — keeping reading in-app rather than bouncing to a raw browser tab. "Open in browser" stays
   a quiet secondary action. (`SavedReader`'s own note lead also switches blockquote → prose.)

**Deferred follow-ups (shape decided, not built):**

- **Read-state / dedup by normalized URL** — the same article can appear as a link post _and_ in an
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
