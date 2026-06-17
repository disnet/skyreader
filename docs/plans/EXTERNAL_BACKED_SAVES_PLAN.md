# External-Backed Saves: make the Saved list *be* a Semble/Margin collection

> Today Skyreader **writes** to Semble (`network.cosmik.card`) and Margin (`at.margin.note`) as
> one-way exports, and can **list** a user's collections — but it never reads items back. This plan
> turns that one-way export into genuine two-way interop: a user can designate that their Saved list
> **is** a chosen Semble or Margin collection, kept in sync. Add a save in Skyreader or anywhere
> else in the Atmosphere, and it shows up in both.

## Decisions

- **Both tools from the start.** Design one generic backing abstraction, not two bespoke paths.
- **Adopt, don't mirror.** When a list is backed, the foreign collection is the source of truth
  *for membership*. Skyreader stops writing the `app.skyreader.feed.saved` PDS export for that list;
  there is no dual-write of a native save record. "Adopt" does **not** mean "stop using D1": D1 stays
  the **authoritative local store for reading work** (extracted body, word count, highlights, labels),
  fed alongside the collection's membership, not a second source of truth.
- **Separate membership from enrichment** (see below). Backed membership is a *replaceable snapshot*,
  kept in its own table and rebuilt wholesale from each provably-complete poll. Reading work lives in
  `saved_articles`, keyed by `url_normalized`, and is **never deleted by a poll**. The Saved list is
  the membership snapshot joined to the enrichment store at read time. This makes the read path
  safe-by-construction: a botched poll can only stale the displayed membership (recovered on the next
  good poll), never strip a body or a highlight.
- **Poll, don't subscribe.** The read path is an on-open (and optionally background) `listRecords`
  **snapshot poll of the user's own collection**, not a Jetstream firehose subscription. The data
  lives in the user's PDS, so a snapshot makes the link↔card join a pure in-memory operation with no
  out-of-order reconcile. A firehose fast-path is at most a later latency optimization layered on top.
- **D1 is canonical for saves today** (this shapes the whole design — see below).
- Implementation is phased; the risky read path is spiked first.

### D1 is the canonical save store

Per `backend/src/routes/saved.ts`, the `app.skyreader.feed.saved` PDS record is an opt-in *export*,
not the source of truth:

- `handleMetadataSave` (`saved.ts:214`) writes the PDS record only when `pdsSyncEnabled && source === 'feed' && body.url`.
- `handleUrlSave` (`saved.ts:316`) writes only when `pdsSyncEnabled`.
- `document` and `share` saves **never** write a PDS save record (the write branch is scoped to
  `source === 'feed'`); when sync is off, `record_uri` is a *synthesized* `at://…` string pointing at
  a record that was never written (`saved.ts:212`, `:315`).

So no atproto record is reliably canonical for a save today — the **D1 row is**. "Backing" therefore
means letting a *foreign collection* feed the canonical D1 store, not displacing one PDS record with
another. Keeping D1 authoritative and treating the collection as an upstream source is the natural
shape, not a compromise.

**Two stores, not one (the read-path shape).** The original instinct was to reconcile the collection
snapshot *into* `saved_articles` as a set-diff. That forces three fragile invariants at once
(never-delete-on-partial-snapshot, merge-not-replace, scope-by-collection), and any one of them wrong
silently destroys reading work or wipes the list. Instead, split the responsibilities:

- **Enrichment store** — `saved_articles`, keyed by `url_normalized`. Holds the extracted body, word
  count, content type, and links to highlights/labels. Append/upsert only from the reader's side;
  **a poll never deletes from it.** Reading work is structurally safe.
- **Membership snapshot** — `backed_collection_members`, the latest *provably-complete* `listRecords`
  snapshot of a backed collection, **replaced wholesale** on each good poll (never row-diffed). Holds
  the `external_*` handles and the join key.

When backing is on, the Saved set is `membership ⋈ enrichment` (join on `url_normalized`) ∪ native
items (uploads). A poll that errors or comes back `truncated` simply doesn't replace the snapshot, so
the worst case is a stale membership view, recovered on the next complete poll — never a lost body or
highlight. This collapses the three set-diff invariants into a single guard ("don't replace on an
incomplete snapshot") and removes the destructive-diff failure mode entirely.

## The shape of the idea

A "save" stops being a Skyreader-shaped `app.skyreader.feed.saved` record and becomes a **membership
in a foreign collection** the user owns on their PDS. Skyreader becomes one of several editors of
that collection; the collection outlives Skyreader and is editable from Semble, Margin, or any other
Atmospheric app. What stays in Skyreader's D1 is the extracted article body, word count, `contentType`,
read/tag labels — and the canonical save row itself.

This is the strongest expression of the "portable across the Atmosphere" framing in CLAUDE.md: not
"we back up your saves to your PDS in our format," but "your saves are a real shared object you can
edit anywhere." The honest tradeoff to surface in copy: **enrichment doesn't round-trip** — the
foreign record carries the URL; your highlights, word counts, and extracted body stay Skyreader-side,
so the other app sees the link, not your reading work.

## The two foreign data models

Both tools model a collection as **two record types**: the item, and a separate membership/link
record. This indirection is the crux of the feature.

| | Item record | Membership record | Collection record |
|---|---|---|---|
| **Semble** | `network.cosmik.card` (`type:URL\|NOTE`; `content.url` + `content.metadata`) | `network.cosmik.collectionLink` (card ↔ collection, **nested strong refs** `{card:{uri,cid}}`/`{collection:{uri,cid}}`) | `network.cosmik.collection` |
| **Margin** | **`community.lexicon.bookmarks.bookmark`** (URL in **`subject`**) for *saves*; `at.margin.note` for *annotations* | `at.margin.collectionItem` (`annotation` ↔ `collection`, **flat at-uri strings**) | `at.margin.collection` |

> ⚠️ **CORRECTED BY PHASE 0 LIVE DATA (2026-06-18).** The Margin row above was rewritten after running
> the Phase 0 read-path spike (since removed; its logic now lives in
> `backend/src/services/backing/read.ts`) against a real Margin
> collection. The pre-spike plan asserted a Margin save is an `at.margin.note` with
> `motivation:"bookmarking"` and the URL in `target.source`. **That is wrong in current live use.** See
> the corrected model below.

**Margin saves are `community.lexicon.bookmarks.bookmark`, not `at.margin.note`.** Live finding: in a
real Margin collection, the `at.margin.collectionItem.annotation` resolved to a
`community.lexicon.bookmarks.bookmark` record — the **shared community bookmark lexicon** — not an
`at.margin.note`. The bookmark shape is minimal: `{ $type, subject: <web URL>, createdAt }`. Every
`at.margin.note` in the same repo was `motivation:"highlighting"` — i.e. Margin now uses
`at.margin.note` for *annotations/highlights* and the community bookmark lexicon for *saves*. This is
actually a **better** portability story (saves ride a cross-app standard), but it rewrites our Margin
read/write spec. Consequences threaded through this doc:

- **Collections are heterogeneous; the read path must be multi-type aware.** A single collection's
  membership records can point at *different* item types (a `community.lexicon.bookmarks.bookmark`
  here, an `at.margin.note` there, a Semble card elsewhere). The read path resolves *whatever* the
  membership points at and extracts a URL from whichever shape it is — `bookmark.subject`,
  `note.target.source`, `card.content.url`. **Writing stays single-type per provider** (back Semble →
  always write Semble records; back Margin → always write the Margin-native save type), so we only ever
  *author* one shape, but must *read* many.
- **Membership targets can be cross-repo.** Live, the `collectionItem.annotation` pointed at a bookmark
  in a *different* DID's repo than the collection owner. The join must resolve each item by the DID in
  its own `at-uri` (`getRecord` per item, resolving that DID's PDS) — **never** assume the collection
  owner's repo. (The spike `listAllRecords`-the-owner-repo shortcut silently dropped the cross-repo
  bookmark as `note-not-in-repo`; fixed to per-uri `getRecord`.)
- The membership record `at.margin.collectionItem` references the item via its **`annotation`** field
  (an `at-uri` string) and the collection via **`collection`** (also an `at-uri` string) — flat string
  fields, unlike Semble's nested `.card.uri` / `.collection.uri`.
- The `community.lexicon.bookmarks.bookmark` record has **no metadata/extension bag and no
  `sourceHash`** — even more minimal than the old `note` assumption, so the canonical-`at://`
  round-trip remains **Semble-only** (the identity-model conclusion is unchanged, just for a stronger
  reason). Our join key stays `normalizeArticleUrl(subject)`.
- **Write-path open question (needs auth to settle):** does Skyreader's Margin save now write a
  `community.lexicon.bookmarks.bookmark` (+ `collectionItem`) instead of the `at.margin.note`
  `motivation:"bookmarking"` the stale `integrations.ts` handler writes? Live evidence says the
  community bookmark is what Margin's own ecosystem uses for saves. Confirm against what Margin's UI
  writes before finalizing the Phase 1 Margin write half.

**What's proven.** Write shapes exist in `backend/src/routes/integrations.ts`: Semble card lines
~133–142, collectionLink fan-out ~150–184; Margin `collectionItem` write (~298–308) **already uses
the new `annotation`/`collection` fields**. Collection *listing* is proven for both
(`GET /api/integrations/{semble,margin}/collections`). The Semble membership join is proven live:
feed-proxy reads real `network.cosmik.collectionLink` records authored by other apps, resolving
`.card.uri` and `.collection.uri` (`feed-proxy/src/mention-lane.ts:181–214`, verified 2026-06-01).
Margin's join shape is confirmed from its real lexicon (2026-06-17): `collectionItem.annotation`
points at the note, `.collection` at the collection — flat strings, so the join code branches per
provider on field shape.

**What's unproven** (Phase 0 de-risks this): the read path reading items back end-to-end, Semble's
`at://`-in-metadata round-trip, and a live Margin `collectionItem`→`note` pair confirming the data
matches the lexicon.

> ⚠️ **Third-party lexicons, still fragile.** The Semble card lexicon is pinned (see identity model),
> and Margin's `note`/`collectionItem` paths are confirmed from real lexicons — but these are lexicons
> we don't control. Margin just proved the risk by retiring `at.margin.bookmark`: a version bump
> breaks sync, exactly as it now breaks our stale `bookmark` write path. Native
> `app.skyreader.feed.saved` has no such risk. Re-confirm both lexicons at the start of Phase 0; pin
> the `note`/`collectionItem` revisions we build against.

## Identity model: which URI plays which role

| Role | Answers | URI used |
|---|---|---|
| **Join key** | "is this the same save?" (dedup, cross-app identity) | normalized **web URL** |
| **Foreign handles** | "which records do I delete on unsave?" | `at://` of the card/note (`external_item_uri`) **and** the collectionLink/collectionItem (`external_link_uri`) |
| **Canonical atproto ref** | "what's the native record behind this, if any?" | `at://` stored *inside the card* (Semble only) |
| **Legacy guid** | Skyreader-internal source ref | `itemGuid` (RSS guid / doc recordUri) — orthogonal, unchanged |

**Why the web URL is the join key, not `at://`.** The entire Atmosphere layer in this repo already
keys on normalized web URLs: Constellation backlinks resolve against a URL target
(`constellationTargets`/`normalizeArticleUrl`), and the lanes count `network.cosmik.card.content.url`
and `at.margin.note.target.source` — both URLs (`feed-proxy/src/lanes.ts`). A save identified by web
URL slots straight into that graph (back something into Semble and it can light up the margin.at /
Bluesky lanes for the same article); an `at://`-keyed save would be invisible to all of it. URLs are
messy (trailing slash, tracking params, www, http/https), which is why `normalizeArticleUrl` exists —
reuse it as the dedup key.

**Where the `at://` goes — Semble only.** The Semble card's `content.metadata` (`#urlMetadata`) is
already an *identifier bag* (`doi`, `isbn` next to `title`/`author`/`siteName`/`imageUrl`). A canonical
`at://` is a peer identifier there: `content.url` holds the web URL (so Semble renders it and the
mention graph sees it); `content.metadata.<ext>` holds the `at://` so atproto-aware apps can round-trip
to the native record. `card.type` is `knownValues:["URL","NOTE"]` (open, not a closed enum) and the
metadata object tolerates extra fields, so this survives validation. We do **not** use
`parentCard`/`originalCard` (`com.atproto.repo.strongRef`) for this — those mean card-to-card lineage,
not "this card points at an atproto resource."

**Margin has no peer slot.** Confirmed against the real `at.margin.note` lexicon: a note has
`motivation`, `body` (`{value, format, uri}`), `target` (`{source, sourceHash, title, selector,
state}`), `tags`, `facets`, `rights`, `labels`, `generator`, `color` — but **no generic
metadata/identifier bag**. `target.source` is a single required `uri` and must hold the *web* URL (so
the mention graph and Margin's `sourceHash` indexing see it); there's no clean peer field for a
canonical `at://`. So **Margin-backed documents fall back to web-URL-only** (the blogs/viewer URL in
`target.source`) — no native `at://` round-trip — and the canonical `at://` lives only in our D1
`item_guid` for those. This is a Margin engine gap, not a blocker (the save is fully functional and
joins by URL); surface it where the engine picker is described.

## Scope: everything URL-resolvable is backable (documents included)

Documents are **not** URL-less. `resolveDocumentUrl` (`feed-proxy/src/mention-lane.ts:156, 245`)
already maps a `site.standard.document` to its canonical web URL (`skyreader.app/blogs/<did>/<rkey>`).
So every save type has a web URL:

- `source:'url'` / `source:'feed'` — the article URL.
- `source:'document'` — the resolved blogs URL in `content.url` (Semble) / `target.source` (Margin),
  **plus**, on Semble only, the doc's `at://` recordUri stashed in `content.metadata`. Documents are
  first-class backable items, and on **Semble** arguably the *best* fit — they're already
  atproto-native, so the `at://` round-trips perfectly.

*Caveat on "adopt — drop native" for documents:* a document is inherently **dual-record**. The
`site.standard.document` record *is* the content and cannot be dropped — backing it adds a *second*
record (the card/note pointing at the blogs URL) alongside it. So for documents the "drop native" half
of adopt never applies; the native doc always persists and the card/note is a pure pointer.
(Membership truth still comes from the collection; the D1 row stays canonical.)

A backed Saved list is therefore mostly **not a forced union** — most of the list can live in the
collection. Two exceptions: (1) legacy native saves predating the backing, transient until the Phase 5
migration; and (2) **uploads**, native-only by default and never in the collection (see below) — so
any list containing an upload is *permanently* `collection-members ∪ native-uploads`.

Read-path note: a backing collection may contain non-save members authored elsewhere — Semble
`type:NOTE` cards (free text, no URL), or Margin notes whose `motivation` isn't `bookmarking` / that
carry no usable `target.source`. Those aren't article saves; **skip any member with no resolvable URL**
rather than rendering a URL-less save.

## Uploads (EPUB/PDF): the native-pinning exception

Users upload EPUBs and PDFs — content that **doesn't exist on the open web**, so it has no URL to key
on or render. This is the one item type that legitimately breaks "adopt — drop native," forced by two
atproto facts:

1. **The card lexicon has no file type.** `network.cosmik.card.type` is `knownValues:["URL","NOTE"]`
   and `urlContent.url` is a *required URI* — no blob field. A Semble card structurally cannot *hold*
   a file, only point at a URL.
2. **Blobs must be pinned by a record.** `com.atproto.repo.uploadBlob` stores the file on the user's
   PDS addressed by CID, but an **unreferenced blob is garbage-collected**. A plain `content.url`
   string is not a record reference and won't pin anything — some record must hold the `BlobRef`.

So uploads require a native record. That does **not** mean "private in Skyreader" — two independent
axes:

- **Ownership** — file on Skyreader servers (lock-in) vs. on the user's PDS (portable). Always the PDS.
- **Visibility** — projected into a public collection or not. A separate, per-upload choice.

What we avoid is *lock-in*, not *non-projection*. An upload owned on the user's PDS but not in a Semble
collection is portable and owned, just unpublished.

### Architecture (mirrors documents → blogs URL)

1. **Upload → blob on the user's PDS** (`uploadBlob`). Owned, portable, not Skyreader-hosted.
2. **Pin with a native record** `app.skyreader.feed.upload` holding `{ blob: BlobRef, title, author,
   mimeType, size, cover? }` — the canonical file object in the *user's* repo. Design it clean enough
   to propose as a shared standard later (the line between "owned" and "locked in").
3. **Serve a viewer URL** `skyreader.app/file/<did>/<rkey>` that resolves the blob from the user's PDS
   and renders the reader — the same pattern as `skyreader.app/blogs/<did>/<rkey>` for documents.
4. **When backed (and opted in),** project a Semble card / Margin note whose `content.url` /
   `target.source` = the viewer URL. On Semble, stash the upload record's `at://` + blob CID in
   `content.metadata`; on Margin (no metadata slot) the note is viewer-URL-only and the `at://`/CID
   stay in D1. The card/note is a **pointer into the collection, not the source of truth.**

The identity model holds: viewer URL = join key. Highlights still round-trip — a Margin note targets
the viewer URL with a TextQuoteSelector (`motivation:"highlighting"`), so an uploaded EPUB joins the
annotation graph like anything else.

### Three decisions baked in

- **Projection is off by default for uploads.** A PDS blob is publicly fetchable by CID, and uploads
  are frequently copyrighted; projecting one into a *public* Semble collection advertises the CID.
  Default to **native-only (owned on PDS, not projected)**, with explicit per-upload opt-in to add it
  to the backing collection. *(Forward path: once atproto permissioned data lands — see below — an
  upload can be both owned **and** private, and this default can revisit. It's a "for now," not a
  ceiling.)*
- **EPUB ≫ PDF for the product spine.** EPUB is XHTML → converts to calm-reading HTML and supports
  TextQuoteSelector highlights → Margin notes cleanly. PDF is positional: needs a text layer (pdf.js)
  to extract quotes, and coordinate-based highlight anchoring doesn't map to TextQuoteSelector. **Ship
  EPUB first;** PDF is a degraded second tier.
- **Blob size is PDS-capped** (host-dependent, often tens of MB). EPUBs are tiny; textbook PDFs can
  exceed it. Cap at the PDS limit and surface it honestly — do **not** silently fall back to
  Skyreader-hosted storage, which reintroduces the lock-in we're avoiding.

<a id="forward-permissioned-data"></a>
> **Forward path — permissioned data.** atproto private/permissioned data is on the near horizon.
> Once a PDS can store non-public records and blobs, uploads (and any copyrighted save) can be **owned
> on the user's PDS *and* genuinely private** — collapsing the ownership-vs-visibility tension. At that
> point: revisit the projection default, and consider whether sensitive saves should live in
> permissioned records rather than relying on CID-obscurity. Treat today's "native-only, public-blob"
> handling as the pre-permissioned interim.

## Data model

### Backing configuration (one per user)

Backing is a **single account-level setting** — it backs *all* of the user's saves, not a per-list or
per-channel choice. The user picks one engine and one collection; every save they make (in any channel,
from any source) lands in that collection. The setting is one of:

```
backing = 'skyreader'            // default, app.skyreader.feed.saved (today's behavior)
        | 'semble:<collectionUri>'
        | 'margin:<collectionUri>'
```

**This is a choice of *which engine backs the public backup*, not a downgrade.** Present it as picking
the **backup engine** for your saves: Skyreader (`app.skyreader.feed.saved`), Semble
(`network.cosmik.card`), or Margin (`at.margin.note`). All three put your saves on the user's PDS; they
differ only in *which schema* it speaks and therefore *which apps can edit it natively*. Choosing
Semble/Margin isn't losing portability — it's choosing schema compatibility with that ecosystem. It's
a lateral choice between equally-portable engines, surfaced in the UI as an engine picker.

Store it on a single `user_settings` row, not on any channel — there is exactly one backing per
account, applied to all saves. (The River Redesign's channels are just views over the one Saved set;
they don't each get their own backing.)

**Which collection: reuse an existing one, or let us create the default.** Once the user picks an
engine, they choose the target collection — either:

- **Reuse an existing collection** (the common case — e.g. a "To Read" list they already keep in
  Semble/Margin). Picked via the existing `CollectionPicker.svelte` against the existing
  list-collections endpoints (`GET /api/integrations/{semble,margin}/collections`). Backing then adopts
  that collection as-is; its current members are read in on the first poll (Phase 2 backfill), and
  Skyreader's existing native saves are offered for one-time export *into* it (Phase 5).
- **Create a new collection** (the default if they don't pick one). Skyreader creates a
  `network.cosmik.collection` / `at.margin.collection` record named **"Skyreader Saves"** in the user's
  repo and backs that. The new-collection path needs a `createCollection` step on the provider
  abstraction (a single `putRecord`/`applyWrites` of the collection record); collection *creation* is
  new (today only listing + item/membership writes are proven), so Phase 0 should confirm the collection
  record shape for each provider.

Either way the chosen/created collection's `at://` is what lands in the `backing` setting
(`semble:<collectionUri>` / `margin:<collectionUri>`). Surface both options in the enable flow with
"Skyreader Saves" pre-selected as the default, so a user who just wants it to work gets a clean new
collection, and a user with a curated list can point at it.

### D1: two stores + a tombstone table (migration `0057_external_backed_saves.sql`)

```sql
-- (1) Enrichment store gains the cross-app join key. `normalizeArticleUrl` lives in
--     feed-proxy/src/url-normalize.ts today, so the backend needs a shared/duplicated copy
--     for the backfill and write paths.
ALTER TABLE saved_articles ADD COLUMN url_normalized TEXT;      -- normalizeArticleUrl(url) — the cross-app JOIN KEY
CREATE UNIQUE INDEX idx_saved_articles_dedup ON saved_articles(user_did, url_normalized);

-- (2) Membership snapshot: the latest PROVABLY-COMPLETE listRecords snapshot of a backed
--     collection, replaced WHOLESALE per good poll. The external_* fields are foreign HANDLES
--     (what to read/delete), not identity. Reading work never lives here.
CREATE TABLE backed_collection_members (
  user_did            TEXT NOT NULL,
  external_collection TEXT NOT NULL,  -- backing collection URI
  url_normalized      TEXT NOT NULL,  -- join key into saved_articles
  url                 TEXT NOT NULL,  -- resolved web URL (raw)
  external_provider   TEXT NOT NULL,  -- 'semble' | 'margin'
  external_item_uri   TEXT NOT NULL,  -- at://…/network.cosmik.card/… or …/at.margin.note/…
  external_link_uri   TEXT NOT NULL,  -- the collectionLink/collectionItem membership (deleted on unsave)
  metadata            TEXT,           -- JSON: card/note title/author/etc + canonical at:// (Semble only)
  PRIMARY KEY (user_did, external_collection, url_normalized)
);
CREATE INDEX idx_backed_members_collection ON backed_collection_members(user_did, external_collection);

-- (3) Short-lived unsave tombstones: suppress a just-unsaved URL until a snapshot confirms the
--     foreign membership is actually gone, so a fire-and-forget membership delete that hasn't
--     propagated yet can't be resurrected by the next poll. See Phase 4.
CREATE TABLE backed_unsave_tombstones (
  user_did            TEXT NOT NULL,
  external_collection TEXT NOT NULL,
  url_normalized      TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (user_did, external_collection, url_normalized)
);
```

The **join key is `url_normalized`** (reuse `normalizeArticleUrl`), so the same article saved natively
and via the collection — or via two apps — collapses to one row. The `external_*` fields live on the
membership snapshot, not on `saved_articles`: `external_item_uri` is the card/note we may read or
delete; `external_link_uri` is the membership we delete on unsave (remove the *membership*, not
necessarily the card — a card can live in several collections). For `source:'document'`, the card's
canonical `at://` lives in `content.metadata` on the foreign side, in the snapshot's `metadata` JSON,
and in the existing `item_guid` column on the enrichment row — no new `saved_articles` column.

`record_uri` (the `app.skyreader.feed.saved` URI) stays `NULL` for backed saves — no PDS export record.
This is not losing the canonical save: the reading work is the **enrichment row**, and membership is
the snapshot. For sync-off users `record_uri` is already a synthesized placeholder today, so "NULL for
backed" is a small change.

**Why a snapshot table and not a JSON blob.** Storing the snapshot as one queryable table (vs a blob
per collection) keeps the read-time join to `saved_articles` a plain SQL join and lets the wholesale
replace be one D1 batch (`DELETE … WHERE user_did=? AND external_collection=?` then bulk `INSERT`),
which is atomic. A blob would force the join into app code for no benefit.

## Phases

### Phase 0 — De-risk the read path (spike, throwaway-OK)

The spike proves a **snapshot poll + in-memory join converges and stays correct**, for **both**
providers' real records. Why a snapshot poll, not the firehose:

- **The firehose is global, not per-user.** `JetstreamPoller` opens a connection scoped *by collection
  NSID server-side* and filters DIDs *locally* (`jetstream-poller.ts:212` subscriptions, `:394`
  documents, `:604` saved). Adding `network.cosmik.card` means ingesting **every Semble user's cards
  across the whole network** and discarding all but a handful of registered DIDs — bad
  signal-to-noise, *and* it's the source of the out-of-order problem (link and card arrive as
  separate, unordered events).
- **The data lives in the user's own PDS.** A `listRecords` snapshot of the user's collection returns
  a *consistent set*, so the link↔card join is a pure in-memory operation with **no ordering problem
  at all**. The primitive exists and is in production: `pdsClient.listAllRecords`
  (`pds-client.ts:372`), used by `subscription-sync.ts:114`. The every-minute cron (`index.ts:542`)
  and the DO alarm loop both have natural slots for a per-user poll.
- **D1 membership is a self-healing cache, not reconciled truth.** A periodic full re-list makes any
  bug self-correct on the next poll instead of permanently corrupting the Saved list. The tradeoff is
  latency (bounded by poll cadence) + per-user PDS fan-out — both trivial for an opt-in,
  single-list-per-user feature, and freshenable with on-open polling.

Spike steps:

1. Snapshot (Semble): `listAllRecords('network.cosmik.collectionLink')`, filter to links whose
   `.collection.uri` is the chosen collection, resolve each `.card.uri` to its card, read `content.url`
   (skip `type:NOTE` cards — no URL). The feed-proxy join (`mention-lane.ts:181–214`) already proves
   the parse; this proves it over a *whole-collection* snapshot.
   Snapshot (Margin): `listAllRecords('at.margin.collectionItem')`, filter to items whose `collection`
   (`at-uri` string) is the chosen collection, resolve each `annotation` (`at-uri` string) to its
   `at.margin.note`, read `target.source` (skip notes with `motivation !== 'bookmarking'` or no usable
   `target.source`). Confirm the flat-string field shape matches the lexicon on real records.
2. Re-poll: run the snapshot again after an add/remove done **from the provider's own UI**, confirm
   the computed URL set matches with no durable reconcile state and no event ordering to manage.
3. Confirm there's no metadata/extension slot on `at.margin.note` for the canonical `at://` (the
   lexicon shows none); confirm Margin-backed documents therefore degrade to web-URL-only cleanly.
4. Probe the `at://`-in-metadata round-trip: write a Semble card with `content.url` = a web URL and an
   `at://` in `content.metadata`, read it back, confirm the extension field survives lexicon
   validation and is preserved.
5. Confirm the `network.cosmik.collection` / `at.margin.collection` record shape and that creating one
   (`createCollection`, for the default "Skyreader Saves" path) then writing members into it works — so
   the default-create flow is proven alongside reuse of an existing collection.
6. Output: "URLs currently in collection X" that stays correct across add/remove done from the
   provider's own UI, derived purely from snapshots.

If snapshots converge cleanly (expected — it's a consistent read), the rest is wiring. A firehose
fast-path can be added later *as an optimization on top of* a poll that remains the backstop. If even
the snapshot join is ambiguous, reconsider scope.

### Phase 1 — Data model + settings

Migration `0057`, the `backing` setting, and a provider abstraction so Semble and Margin share one
code path:

```
interface BackingProvider {
  provider: 'semble' | 'margin';
  listCollections(pds): Promise<{uri, name}[]>;                                   // for the picker (exists today)
  createCollection(pds, name): Promise<{uri}>;                                    // default "Skyreader Saves"
  listMembers(pds, collectionUri): Promise<{itemUri, linkUri, url, metadata}[]>;  // snapshot poll
  createMember(pds, collectionUri, save): Promise<{itemUri, linkUri}>;            // write
  removeMember(pds, {itemUri, linkUri}): Promise<void>;                           // unsave
}
```

(No `wantedCollections`/`parseEvent` — those would serve a firehose path; add them only if a firehose
fast-path is later layered on.)

> **Discover the abstraction, don't design it up front.** Take **one** provider all the way through
> Phase 4 (write + delete + re-poll convergence) *first*, then extract this interface from working code
> and add the second. The shapes differ in real ways — Semble's nested `collectionLink`
> (`{card:{uri}}` / `{collection:{uri}}`) fan-out vs Margin's flat-string `collectionItem`
> (`annotation` / `collection`), and Semble has a metadata slot for the canonical `at://` while Margin
> has none — so an interface frozen before either runs end-to-end risks leaking. Semble first (its
> indirection is the harder shape).

The Semble write half already exists in `integrations.ts` and gets refactored behind this. The
**Margin write half needs updating first**: it still creates the removed `at.margin.bookmark`
(`integrations.ts:~275–285`) and must move to `at.margin.note` (`motivation:"bookmarking"`, URL in
`target.source`, description in `body.value`) — the `collectionItem` write (~298–308) already uses the
new `annotation`/`collection` fields. No behavior change to today's one-off "Save to Semble/Margin"
buttons beyond that lexicon fix — those keep working as ad-hoc exports independent of backing.

### Phase 2 — Read path: snapshot poll → membership table, joined to enrichment at read time

The read path is two stores (see "Two stores, not one" above): a **membership snapshot** replaced
wholesale, joined at read time to the **enrichment store** a poll never touches.

- **Backfill on enable:** call `listMembers` (a `listAllRecords` snapshot). For each member, upsert an
  *enrichment* row into `saved_articles` keyed by `url_normalized` (merge-only — see invariant 2), and
  write the membership rows into `backed_collection_members`. Bodies extracted lazily on first open via
  the existing extract pipeline (same path `source:'url'` saves use — this part is free). Members whose
  resolved URL is a `skyreader.app/blogs/...` doc URL resolve back to the native document reader rather
  than re-extracting.
- **Ongoing (the same `listMembers` snapshot, on a cadence):** re-poll each backed user's collection
  and **replace the membership snapshot wholesale** — one D1 batch: delete this collection's rows,
  bulk-insert the snapshot's rows (excluding any URL with a live tombstone, see Phase 4). No row-diff,
  no durable reconcile state, no event ordering. Any prior membership bug self-corrects on the next
  complete poll. Enrichment rows are upserted (merge-only) for new URLs but **never deleted here**.
  Drive it primarily from **Saved-list open** (so a save made elsewhere appears promptly); a background
  cadence (every-minute cron `index.ts:542`, minute-gated, or the DO alarm loop) is optional and can be
  deferred past v1.
- **Read (`handleGetSaved` when backing is on):** `backed_collection_members` LEFT JOIN
  `saved_articles` on `(user_did, url_normalized)`, scoped to `external_collection`, UNION native items
  (uploads). The backing applies to the whole Saved set, so every channel-filtered view reads from the
  same membership-joined-enrichment result. Enrichment rows not present in the current snapshot are
  dormant cache (kept for cheap re-add; GC lazily if ever needed).
- **Firehose (optional, later):** if poll latency proves too coarse, a Jetstream fast-path can push
  near-real-time deltas *on top of* the poll, which stays the backstop. Not needed to ship.

**Invariants for the read path** (the two-store split already neutralizes the destructive-diff failure
mode; what remains):

1. **Never replace the snapshot on a partial/failed poll.** A poll that errors, times out, or comes
   back `truncated` (`listAllRecords` exposes a `truncated` flag — `pds-client.ts:401`) is "no
   information," not "the collection is empty." Replace `backed_collection_members` **only when the
   snapshot is provably complete** (full pagination, no error, not truncated); otherwise leave the last
   good snapshot in place. This is now the *single* guard: a failed poll can only stale the displayed
   membership, never delete reading work.
2. **Enrichment upsert must *merge*, not *replace*.** The `url_normalized` unique index collapses a
   native save and the same URL from the collection onto one enrichment row. The `ON CONFLICT` path
   must **preserve local enrichment** (extracted body, word count, highlights, labels, read-state) and
   never overwrite `content`/`word_count` with the (often sparse) card metadata. (The `external_*`
   handles no longer live on this row — they're in the membership snapshot — so the merge surface is
   smaller than before.)
3. **Reads are auth-free; only writes need a session.** `com.atproto.repo.listRecords` is a public
   endpoint, so the poll needs only DID→PDS resolution, not a live DPoP session — background polling
   works for logged-out users and the cron needs no token refresh (confirm in Phase 0). Writes
   (`createMember`/`removeMember`) do need the user's session, but those only fire during in-app
   save/unsave, when a session exists.
4. **Skip unchanged repos cheaply.** Before a full `listRecords`, a `describeRepo`/repo-`rev` check can
   skip users whose repo hasn't changed since the last poll — keeps any background fan-out cheap as the
   backed-user count grows. (Only relevant if a background cadence is added; the open-driven poll is
   already scoped to one user.)

### Phase 3 — Write path (adopt)

When backing is on, `handleCreateSaved`/`handleMetadataSave`/`handleUrlSave`
(`backend/src/routes/saved.ts`) branch for **every** save: **in place of the optional
`app.skyreader.feed.saved` PDS export**, call `provider.createMember`, then write the enrichment row to `saved_articles` and the
membership row to `backed_collection_members` (`external_item_uri`/`external_link_uri`/
`url_normalized`). (For sync-off users, and for `document`/`share` saves, there is *no* PDS write
happening today, so for those this branch adds the foreign membership rather than replacing an existing
write.) For a `source:'document'` save, `createMember` sets the member's URL (Semble `content.url` /
Margin `target.source`) to the resolved blogs URL; on Semble it also stashes the doc's `at://`
recordUri in `content.metadata`, while a Margin-backed document is web-URL-only with the `at://` kept
D1-side. The enrichment row stays canonical and still holds extracted content + word count exactly as
today. The frontend `savesStore` (`saves.svelte.ts`) is largely unchanged — it still POSTs
`/api/saved`; the backend decides where the foreign membership lands.

**Create both foreign records atomically.** `createMember` is a *two-record* write — Semble's card +
`collectionLink`, Margin's note + `collectionItem` — and both records live in the *user's own repo*. A
sequential two-`putRecord` create fails halfway under network error and orphans the item (no
membership) or dangles a membership (no item). Use **`com.atproto.repo.applyWrites`** to create both in
one transactional batch instead. The primitive is already proven in this codebase:
`pdsClient.applyWrites` (`pds-client.ts`), used for subscription sync (`subscriptions.ts:286`). Same
applies to the Phase 5 export and Phase 4 delete (membership-only delete is single-record, but if a
provider ever needs paired deletes, batch them too).

### Phase 4 — Delete symmetry

- **Unsave in Skyreader:** delete `external_link_uri` (the membership) **only — never the card/note
  itself**. The item is a shared object that may belong to other collections or carry annotations made
  in Semble/Margin; removing it from *our* collection must not destroy the user's record elsewhere.
  Unsave = leave the collection, not delete the item. (This makes the orphan case a non-issue: we never
  delete the item, so we never reason about whether it's orphaned.)
- **Unsave durability — write a tombstone.** Today's native delete is *fire-and-forget* to the PDS
  (`saved.ts:542`), and the membership snapshot is rebuilt from the collection. So an unsave whose
  `external_link_uri` delete hasn't propagated (or failed) would be **resurrected** by the next poll:
  the collection still lists it, the wholesale replace re-adds it. The self-healing read path heals away
  your unsaves. Fix:
  - On unsave, in one D1 step: remove the row from `backed_collection_members` (immediate UI removal)
    **and** insert a row into `backed_unsave_tombstones` for that `(user_did, external_collection,
    url_normalized)`. Then fire the membership delete.
  - The Phase 2 wholesale replace **excludes any URL with a live tombstone**, so a snapshot taken before
    the delete propagates can't re-add it.
  - **Clear the tombstone when the snapshot confirms the delete:** a complete poll whose snapshot no
    longer contains the URL deletes the tombstone (the unsave is now reflected upstream). A complete
    poll that *still* contains it means the delete didn't land — keep the tombstone and re-fire the
    membership delete. Tombstones are therefore "short-lived" by construction: they exist only across
    the propagation gap, plus a TTL backstop so a permanently-stuck delete eventually surfaces rather
    than silently suppressing forever.
- **Removed elsewhere:** the next complete snapshot poll simply doesn't include the membership, and the
  wholesale replace drops it from `backed_collection_members` — no firehose delete event to catch, no
  diff. This closes the loop that makes it feel like *one* list.

### Phase 5 — Enable/disable UX + migration of existing native saves

- Account settings surface to pick the **backup engine** for all your saves → provider → choose the
  collection. The picker offers the user's existing collections (reuse, e.g. a "To Read" list) **and** a
  "Create new collection" option defaulting to **"Skyreader Saves"** (`createCollection`), pre-selected
  so the zero-config path just works. The resulting `at://` is written to the `backing` setting.
- On enable, offer (don't force) a one-time export of existing native saves — URL, feed, *and*
  documents (each via `createMember`, documents through their resolved blogs URL + `at://` metadata).
  Each `createMember` writes the membership row, so exported saves show up via the membership snapshot
  like any backed save — no separate "backed" flag to set. After migration the only residual
  non-collection items are uploads (native by
  default — see Phase 7); everything URL-resolvable now lives in the collection.
  - **Export must be idempotent.** Before `createMember`, dedup against the collection's *existing*
    members by `url_normalized` (a save already in the collection from another app, or a re-run, must
    not create a duplicate card/note). Reuse the Phase 2 snapshot to know what's already there.
- On disable, saves revert to native and the **foreign records stay in place** — they're the user's
  data; opting out of backing must never delete their collection or its cards/notes. Consistent with
  the unsave policy: Skyreader leaves the user's repo alone. (Revert = stop treating the collection as
  the backup engine, not tear it down.)

### Phase 6 — Copy & voice

Per CLAUDE.md Atmosphere framing and the no-em-dash rule: lead with portability, name the
public-visibility and enrichment-doesn't-round-trip tradeoffs plainly, keep it terse. Frame as choosing
the **backup engine** for your saves (Skyreader / Semble / Margin) — a schema-compatibility
choice, not a downgrade — and "your saves live in your Semble/Margin collection," not "we sync to a PDS
lexicon."

> **Backing publishes all your saves — say this loudly.** Backing is account-wide and we deliberately
> do *not* offer a per-save exclude, so turning on a Semble/Margin backing makes **every save in your
> account public** (their collections are public). That is a one-switch, all-saves consent moment, not a
> quiet sync setting. The enable flow must state, unmissably and before the user commits, that backing
> publishes *all* of your saves publicly — no fine print, no per-item escape hatch implied. If a user
> has saves they don't want public, the answer is "don't turn on backing," and the copy must make that
> the obvious read. (Until atproto permissioned data lands, there is no private backing.)

### Phase 7 — Uploads (EPUB/PDF) — separable, can land independently

Implements the native-pinning exception above. Does **not** depend on backing being shipped — an upload
is a valid native save on its own; backing just adds the optional projected card.

1. `app.skyreader.feed.upload` lexicon + `uploadBlob` flow to the user's PDS; D1 enrichment row keyed
   off the upload record's `at://` (reuse `item_guid`), `source:'upload'`.
2. EPUB → reader HTML conversion + the `skyreader.app/file/<did>/<rkey>` viewer route (mirror the blogs
   resolver). PDF is a later, degraded tier (pdf.js text layer for quotes).
3. Optional per-upload "add to collection" → `createMember` with the viewer URL + `at://`/CID metadata,
   **off by default** (copyright/visibility).
4. Highlights on uploads target the viewer URL via TextQuoteSelector → existing Margin note path.

## Open questions to settle before Phase 1

1. **Conflict / edit races** — same URL added in both apps near-simultaneously: the `url_normalized`
   unique index on the enrichment store collapses them; with snapshot polling each poll is a consistent
   set so there's no ordering race, but still use `ON CONFLICT(user_did, url_normalized)` *merge*
   upserts (not blind inserts) so a save made in Skyreader between two polls doesn't collide with the
   same URL arriving in the next snapshot. (Membership itself is a wholesale replace, so it has no
   per-row race at all.)
2. **Multiple collections per card (Semble)** — a card in the backing collection *and* others: we only
   care about membership in the backing collection; the `.collection.uri` filter scopes the snapshot
   (proven in feed-proxy), and the wholesale replace is already scoped by `external_collection`, so a
   card removed from *our* collection while still in another correctly drops from the membership table
   without touching the enrichment row or other collections.
3. **`at://`-in-metadata durability** — confirm the extension field survives Semble's validation and a
   PDS round-trip (Phase 0 step 4); if Semble strips unknown metadata fields, documents degrade to
   web-URL-only (still functional, just no native round-trip).
4. **Scope coverage** — existing OAuth scopes (`scopes.ts`) already cover read+write for both providers'
   card/collection/link records; confirm no new scope is needed for *reading the user's own* item
   records (should be covered by `repo:` grants). Uploads add `uploadBlob` + a new
   `app.skyreader.feed.upload` write scope.
5. **Blob GC / pinning lifecycle** — confirm the upload record reliably pins the blob and that deleting
   the record (unsave) releases it; decide retention if a projected card is deleted elsewhere but the
   native upload record remains (the record is truth, so keep the blob).

### Resolved

- **Orphan policy on unsave** — membership-only delete; never delete the card/note. Unsave removes the
  item from our collection, not from the user's repo. (Phase 4.)
- **Margin metadata slot** (2026-06-17) — read against the real `at.margin.note` lexicon: there is **no
  metadata/extension field** to carry a peer `at://`. `target.source` is a single required `uri` that
  must hold the web URL. So Margin-backed documents fall back to web-URL-only; the `at://` round-trip is
  a Semble-only capability, and the canonical `at://` stays in D1 `item_guid`. (Also: Margin retired
  `at.margin.bookmark`; our stale `bookmark` write path moves to `note`, folded into Phase 1.)

## Why this is worth it (and the honest risks)

**Upside:** turns a shallow one-way export into the deepest interop story in the app — the clearest
proof that a reader's reading life is portable and outlives Skyreader. Strong differentiation, fits the
product spine (reading → sensemaking) and the Atmosphere framing exactly.

**Risks, eyes open:**

1. **Read-path correctness** — a consistent-snapshot poll that *replaces a membership table wholesale*
   and joins it to a never-deleted enrichment store; self-healing, uses an existing production
   primitive (`listAllRecords`, which exposes `truncated`). Splitting membership from enrichment means
   a bad poll can only stale the displayed list, never destroy reading work. The residual cost is poll
   latency + per-user PDS fan-out, not convergence risk; the residual correctness concern is unsave
   durability, handled by the Phase 4 tombstone.
2. **Coupling to third-party lexicons we don't control** — the `at://`-in-metadata extension rides on
   Semble tolerating unknown fields (a real, if low, fragility) — mitigated by D1 staying the canonical
   local store, so a lexicon bump or provider outage degrades to "sync paused," not "saves vanished."
3. **Not a literal forced union** — the list is mostly the collection once legacy saves migrate, but
   uploads keep it permanently `collection ∪ native-uploads`, and documents are inherently dual-record.
   "It just *is* the collection" is the headline, not the literal invariant.
4. **Enrichment is Skyreader-side only** — so "portable" is partial; say so in the copy.
5. **Uploads** are the principled exception (no foreign lexicon can hold a blob), so they keep a native
   pinning record and project only optionally — and copyrighted blobs on a public PDS are a real
   exposure until atproto permissioned data lands.
