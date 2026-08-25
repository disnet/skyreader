# Highlight review mode

A recurring, finite surface — "revisit a handful of your highlights" — plus opt-in ingest of the
reader's own Margin (`at.margin.note`) highlights, so the review pool covers everything they've
highlighted across the Atmosphere rather than only what they highlighted in Skyreader.

This records the decisions the implementation rests on. For where highlights themselves live, see
[the Reader FDR](../../DESIGN.md) and `frontend/src/lib/stores/itemLabels.svelte.ts`.

## The shape of a review

**The view is the reminder.** V1 has no push and no email — that delivery stack is entirely
greenfield. Instead the deck surfaces through calm in-app entry points: a Home panel
(`HighlightReviewCard.svelte`), a Review link in the `/highlights` header, a switcher entry, and the
`8` shortcut. The Home panel hides itself once the deck is done or empty: no streaks, no badges,
nothing to clear. A reader who never opens the app is never reminded — that gap is the price of not
building Web Push, and it's what a follow-up would close.

**The deck is ephemeral and deterministic, not a frozen issue.** Unlike the daily magazine, a review
session is a few minutes over a handful of cards, so the mid-read-shift and cross-device resume
problems that forced magazines to be durable don't apply. `buildHighlightDeck`
(`frontend/src/lib/utils/highlightReview.ts`) derives the deck at open:

- **Eligibility** — exclude anything already reviewed today (local calendar day, not UTC), and
  anything created in the last 24 h (reviewing what you just made is noise). The freshness filter
  _relaxes_ rather than emptying a non-empty pool, so a reader whose only highlights are from this
  morning still gets a deck.
- **Order** — `lastReviewedAt` ascending, never-reviewed first. Ties (which is most of the
  never-reviewed bucket) break on the magazine's FNV-1a `dailyScore(dateKey, id)`, so the same day
  deals the same deck and tomorrow rotates.
- **No spaced repetition.** Least-recently-reviewed-first is the whole algorithm in v1. The field
  shape leaves room to add scheduling later.

The component holds the dealt deck in `$state`, not a `$derived` — deriving it would rebuild the
deck the moment the first card is stamped and pull the ground out from under the reader.

**Review state lives inside the `Highlight` object.** `lastReviewedAt?: number` (epoch ms) rides the
existing label sync, tombstone and offline machinery for free — no migration, no Dexie version bump
(`props` isn't indexed). The `reviewed` mutation in `highlightAliases.ts` only ever moves the stamp
forward, so a slow device flushing an older review can't make a highlight look due again.

**Deck size is device-local** (`highlightReviewCount`, default 5, options 3/5/10), same posture as
`dailyMagazineMinutes`.

Two devices opening the deck before `lastReviewedAt` syncs will show overlapping decks. Harmless
(you see a highlight twice), self-healing after sync; not worth a lock.

## Margin ingest

Skyreader has always pushed highlights _out_ as `at.margin.note` records. `GET
/api/integrations/margin/highlights` is the only path that reads the user's own notes back.

- **Public read, scoped gate.** The read is auth-free public XRPC against the user's own repo (the
  same `listAllRecordsPublic` primitive the backed-saves snapshot uses). It is still gated on the
  margin scopes: without them, editing an imported highlight's note would queue a PDS write the
  session can't perform — a worse state than not importing at all.
- **Defensive parsing.** `at.margin.note` is a third-party lexicon that has already changed shape
  once (see [EXTERNAL_BACKED_SAVES_PLAN.md](EXTERNAL_BACKED_SAVES_PLAN.md)). `parseMarginHighlightNote`
  skips anything it can't use — a bookmarking note, a missing or non-`TextQuoteSelector` selector, an
  empty quote, a non-http source — and never throws the whole poll away on one bad record.
  `backend/test/margin-highlights.spec.ts` pins the shape, so drift shows up as a test failure rather
  than a silent import of nothing.
- **Server-side URL match.** The backend normalizes each `target.source` and joins it against the
  user's `saved_articles`, attaching `match: {itemGuid, uri} | null`. Two passes, because
  `url_normalized` is only written on the backed-save path: an indexed `url_normalized IN (…)` lookup
  (what a Semble/Margin-backed account has), then a host-prefix-narrowed `url_normalized IS NULL`
  read normalized in-process (what a default-backing account has — every save, not a legacy tail).
  The second pass filters by scheme+host in SQL, the one part a raw and a normalized URL always
  share, so the poll never reads the whole saves table; `ORDER BY id` makes duplicate URLs resolve to
  the same save every time. The client has neither the normalization logic nor the saves table.
- **A partial poll says so.** `truncated` propagates from the page cap all the way to a quiet notice
  on `/highlights` — otherwise "these are your highlights" would be a lie.
- **Symmetric lifecycle.** Imported highlights carry `marginUri`/`marginRkey` exactly like one
  Skyreader pushed out, so re-polls dedup on the rkey, note edits update the same record, and
  deletion deletes the Margin record. That last one is what stops a deleted highlight resurrecting on
  the next poll — and it is a cross-app delete, so `RemoveHighlightModal` always says "This also
  removes it from Margin" before it happens.
- **Unmatched imports still render.** A note whose article isn't in any local cache is keyed by its
  normalized URL and carries `sourceUrl`/`sourceTitle`; `resolveHighlightSource`
  (`frontend/src/lib/utils/highlightSource.ts`) falls back to those, shared by the list and the deck
  so the two degrade identically. Re-anchoring needs no work: if the user later opens the article,
  `findTextInDOM` anchors by `exact`/`prefix`/`suffix` as usual.

The toggle is device-local. Once one device imports, the highlights sync everywhere as normal label
rows.

## Copy

Highlights are private to Skyreader (D1 + IndexedDB). Saving one to Margin publishes _that note_ to
the user's PDS; the highlight itself stays here. Never say highlights live on the PDS, and Margin
ingest copy must surface that the source records are public. See the Copy & Voice rules in the root
`CLAUDE.md`.

## Known gaps

- **Row-level sync races get more frequent.** `lastReviewedAt` bumps rewrite the whole per-item
  `highlights` array, and the documented gap stands: removing a single highlight from a
  multi-highlight item may not propagate to a device that already cached it
  (`itemLabels.svelte.ts`). More writers means more chances to resurrect a deleted highlight on a
  stale device. The per-id union merge keeps this rare and non-destructive — worst case a ghost
  highlight reappears until re-deleted. Per-highlight tombstones are the known fix, deferred here as
  in the Reader FDR.
- **Volume.** A heavy Margin user could import hundreds of notes. The import groups by item and does
  one union write per item (`itemLabelsStore.addHighlights`), which keeps writes bounded, but one
  heavily-annotated article becomes one large `props` blob. Acceptable at realistic scale.
- **No reminder without the app.** See "the view is the reminder" above.
