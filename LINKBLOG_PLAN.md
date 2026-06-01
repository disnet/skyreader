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
