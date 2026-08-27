# Highlight review mode

A recurring, finite surface — "revisit a handful of your highlights" — plus opt-in ingest of the
reader's own Margin (`at.margin.note`) highlights, so the review pool covers everything they've
highlighted across the Atmosphere rather than only what they highlighted in Skyreader.

This records the decisions the implementation rests on. For where highlights themselves live, see
[the Reader FDR](../../DESIGN.md) and `frontend/src/lib/stores/itemLabels.svelte.ts`.

## The shape of a review

**The view is the reminder.** V1 has no push and no email — that delivery stack is entirely
greenfield. Instead the deck surfaces through calm in-app entry points: a **Review entry in the
nav** (sidebar, mobile switcher and nav dropdown), a Home panel (`HighlightReviewCard.svelte`), a
Review link in the `/highlights` header, and the `8` shortcut. A reader who never opens the app is
never reminded — that gap is the price of not building Web Push, and it's what a follow-up would
close.

All of them appear on the same predicate — `hasHighlights`, "is there anything the deck could ever
deal" — rather than on today's deck being non-empty. The `8` shortcut is gated on it too, so a new
account that presses it doesn't land on a page with nothing to deal. A link that vanishes once the day's portion is
spent would take the encore state ("That's today's review") with it, which is the state it exists
for. The nav entry is the standing one, so it carries the only count: today's deck size, in the same
muted `.nav-count` the unread counts use. It is a badge you clear by reading and nothing else —
no streak, no lifetime total, no "unreviewed" backlog that can only grow. It goes quiet the moment
the deck is done, and the entry hides entirely until the reader has highlighted something, so a new
account never sees a dead tab. The Home panel keeps no count of its own beyond the button it already
had; it still hides itself once the deck is done.

All four entry points read one derived summary (`highlightReviewStore`, over
`summarizeHighlightDeck`) rather than each walking the corpus, so they can't disagree about the
number and the scan is paid once. The local day is `$state` inside that store, re-armed on a timer to
the next local midnight and re-checked on focus and visibility: a `$derived` recomputes only when
something it read changes, and the wall clock is not something it read, so an installed PWA left open
overnight would otherwise keep showing yesterday's count. The Home panel additionally reads the ranked deck
(`highlightReviewStore.cards`, a separate `$derived` so the nav badge never pays to rank) and names
_who_ it draws from: a person is a better reason to open the deck than a description of how it works.

Bylines are missing more often than not — RSS rarely carries one, and a Margin import never does —
so `resolveHighlightSource` returns `author` unguessed (null) and the panel falls back to the domain,
then the title, rather than letting a source drop out of the sentence. A document carries only its
author's DID, and resolving that to a profile is an async fetch, so the lookups map DID to the name
the reader subscribed under: same name, already on the device.
`describeHighlightSources` caps the list at two names plus a count, naming a third rather than
writing "and 1 more" — that costs the same room as the name it hides.

**The deck is a page, so it wears the app's chrome.** On mobile it mounts `MobileBottomBar` and its
switcher/notification sheets exactly as `/highlights` does — in the installed PWA there is no
browser back button, so the bar's switcher is the only in-app way off the deck. The bar stays put
rather than riding scroll direction (`controlsVisible={true}`): a card fits a screen, so there's no
scroll to read intent from. Its desktop header drops the nav dropdown down there, keeping only the
one thing the bar can't carry — `1 of 5` — and hides outright on the end-of-deck states, where
there's no progress to show.

**The deck is ephemeral and deterministic, not a frozen issue.** Unlike the daily magazine, a review
session is a few minutes over a handful of cards, so the mid-read-shift and cross-device resume
problems that forced magazines to be durable don't apply. `buildHighlightDeck`
(`frontend/src/lib/utils/highlightReview.ts`) derives the deck at open:

- **Eligibility** — exclude anything the reader has retired (`reviewIntent: 'never'`), anything
  already reviewed today (local calendar day, not UTC), and anything created in the last 24 h
  (reviewing what you just made is noise). The freshness filter _relaxes_ rather than emptying a
  non-empty pool, so a reader whose only highlights are from this morning still gets a deck.
  Retirement is the one permanent exclusion, so it's checked before the pool is built.
- **Order** — `reviewPriority` ascending: `lastReviewedAt`, shifted by the reader's intent,
  never-reviewed first. Ties (which is most of the never-reviewed bucket) break on the magazine's
  FNV-1a `dailyScore(dateKey, id)`, so the same day deals the same deck and tomorrow rotates.
- **Frequency is a bias on that order, not a schedule.** `reviewIntent` — `soon` / `later` /
  `someday` / `never`, one control per card — ranks a highlight as though it had been reviewed 30
  days earlier or 120 days later than it actually was. A hard interval you had to wait out would let
  a small library go empty for weeks, which is the same "nothing to review" dead end the freshness
  filter bends over backwards to avoid; biasing the order means the deck always deals the same
  number of cards and tuning only changes _which_ ones come first. `later` is the neutral middle and
  the default, so an untuned highlight and an explicit `later` rank identically. Never-reviewed
  still beats reviewed unconditionally: the stand-in timestamp for "never" sits far enough below any
  real one that no offset can lift a seen highlight above an unseen one, so intent orders within
  those two classes rather than across them.
- **`never` retires, it does not delete.** The highlight stays in the list and on Margin; it just
  stops being dealt, on every device, until the reader puts it back (the `/highlights` list is where
  they can). It's the only intent that acts on the session in progress, so it's the only one with an
  undo — a ten-second notice that restores both the card and the pace it was on. Undo reads that
  pace from the live store rather than the dealt deck, or setting `soon` and then `never` on one
  card would undo to the default.
- **No scheduling beyond that.** No intervals, no ease factors, no grading a recall. The field shape
  leaves room if it ever earns its way in.

The component holds the dealt deck in `$state`, not a `$derived` — deriving it would rebuild the
deck the moment the first card is stamped and pull the ground out from under the reader. It also
re-reads the current highlight from the store (`live`) for anything that has to be current — a note
just typed, a pace just set — because the deck entry is the highlight as it was dealt.

**Review state lives inside the `Highlight` object.** `lastReviewedAt?: number` (epoch ms) and
`reviewIntent?: ReviewIntent` ride the existing label sync, tombstone and offline machinery for free
— no migration, no Dexie version bump (`props` isn't indexed), and the pace a reader sets on one
device reaches the others with the highlight. The `reviewed` mutation in `highlightAliases.ts` only
ever moves the stamp forward, so a slow device flushing an older review can't make a highlight look
due again; the `intent` mutation writes `null` as an absent field rather than a stored `'later'`, so
an untuned highlight stays untouched.

**Deck size is device-local** (`highlightReviewCount`, default 5, options 3/5/10), same posture as
`dailyMagazineMinutes`.

**Deck size lives with the deck; the Margin toggle can't.** Both are in `HighlightSettings.svelte`,
behind a gear in the review header (rendered inline in the review body rather than in an overlay —
the page is one card tall, so there's nothing for a modal to protect). Deck size belongs there and
only there: it configures a thing that is on screen while you change it, which is the whole argument
for moving it out of `/settings` — you can see what "5" means. The Home panel's own deck-size select
went with it; the count in its button already says how big the deck is.

Margin ingest is the exception, because every entry point to the deck is gated on the reader already
having a highlight. A reader with a Margin library and nothing highlighted in Skyreader has no Review
entry in the nav, no link in the `/highlights` header and no Home panel, so a toggle that lives only
behind the deck's gear is a toggle they cannot reach — and it is precisely the toggle that would give
them a deck. So `/settings` renders the same component with `showDeckSize={false}`: the ingest switch
and nothing else, under the statement of where a highlight lives.

**"Review more" is offered wherever the deck runs out**, in two shapes, both as a secondary button:
another hand is offered, never urged.

While highlights are still due today, it reads "Review N more" and deals from what's left. That one
costs nothing to make honest — the hand just finished stamped its own cards, so they're ineligible
and the next hand is genuinely the next ones due.

Once the day's portion is spent, "more" can only mean going around again, so `DeckOptions
.includeReviewedToday` lifts the daily filter for that one deal. The button drops its count (a count
would imply new material) and says what it does: "This brings back the ones you saw earliest today."
The existing rank order needs no special case — least-recently-reviewed-first means an encore starts
with the morning's cards, and anything never reviewed still sorts ahead of every repeat. The lifted
filter is sticky for the visit (`encoreMode`), so a settings-driven redeal can't quietly drop an
encore hand back to the empty daily pool. Nothing but the button ever sets it: the daily filter is
what keeps the deck from nagging, and only the reader may waive it.

That exhausted state is also now a state of its own — "That's today's review", reached by coming
back after finishing rather than by finishing here. It used to share "Nothing to review right now"
with the genuinely-empty case, which read as "you have no highlights" to a reader who has plenty.

"Nothing to review right now" then splits once more, on whether the corpus is empty at all. A reader
who has retired every highlight they own falls through the same branch as a reader who has never
made one, and "highlight a passage while reading" is the wrong instruction for a full list where
every card says never — so that case says "Nothing in rotation" and points at the list, which is
where a highlight comes back from.

The session tally (`reviewed`) spans every hand, so a reader who takes three says "13 highlights
revisited" rather than restarting the count. Within a hand it moves on a high-water mark, not on
every advance: stepping back and coming forward again is navigation, so the card you already passed
is not counted twice. `index` and `interacted` are per hand, which is what
`deckUntouched` reads — a fresh hand at index 0 is untouched no matter what came before it, so
resizing the deck there redeals rather than silently waiting.

`interacted` is set by **every** card action, not just the ones that write: setting a pace, opening
the note editor, saving to Margin, confirming a removal, and opening the source article. It is set on
the _gesture_, in `commitSwipe`, not in the `advance`/`stepBack` those defer by a frame — an import
resolving inside that window would otherwise find the deck untouched and redeal it out from under a
card already flying off screen. Opening the
source is the easiest one to forget and the worst one to miss — the reader is off reading, which is
precisely when a late import must not redeal underneath them, or they come back to a different card
than they left.

Changing either mid-session is governed by `deckUntouched`: an untouched deck redeals immediately —
resizing a deck and watching nothing happen would make the control look broken — and a deck the
reader has started keeps the hand it was dealt, with the change applying next session. That is the
same predicate the open-time Margin poll uses (`shouldRedealAfterImport`), which is why they share
it; turning ingest on from the panel redeals under exactly the same rule, so switching it on while
staring at "Nothing to review right now" doesn't leave you staring at it.

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
  (what a Semble/Margin-backed account has), then — only for the URLs that pass didn't answer — a
  host-prefix-narrowed `url_normalized IS NULL` read normalized in-process (what a default-backing
  account has — every save, not a legacy tail).
  The second pass filters by scheme+host in SQL, the one part a raw and a normalized URL always
  share, so the poll never reads the whole saves table; `ORDER BY id` makes duplicate URLs resolve to
  the same save every time. The client has neither the normalization logic nor the saves table.
- **A partial poll says so.** `truncated` propagates from the page cap all the way to a quiet notice
  on `/highlights` — otherwise "these are your highlights" would be a lie. The service remembers the
  last poll that actually reached the PDS (`marginImportTruncated()`) rather than the surface reading
  its own call's return: most calls short-circuit on the 15-minute gate, and the corpus is no less
  partial for some other surface having done the fetching.
- **The store gate lives in the service.** The import unions against the highlights it can see and
  writes the result back as the item's whole set, so running before the local read has landed would
  import against an empty corpus and overwrite an item's existing highlights with only the imported
  ones — locally _and_ in D1. Every caller shares one in-flight poll, so a single ungated caller
  defeats everyone else's gate; the gate therefore sits in `maybeImportMarginHighlights` itself,
  where nothing can walk past it, rather than being re-implemented at each surface. It sits above the
  interval stamp, so an attempt that arrives too early doesn't burn the next fifteen minutes. The
  list and the deck keep their own `storesReady` effects, which is what makes the call happen at the
  right moment; the service's gate is what makes it safe.
- **Every outcome has a name.** `MarginImportOutcome` distinguishes `imported` from `skipped`
  (`disabled` / `offline` / `throttled` / `stores-loading`), `scope-expired` and `failed`. It used to
  be one `null` covering all of them, and the settings toggle read that `null` as a network problem —
  so a reader whose Margin grant had lapsed watched the switch flip itself back off and got told to
  try again later, with no prompt to log back in. Surfaces now say the true thing, and the toggle
  keeps its own promise: told the stores are still loading, it retries when they land, because
  `/settings` has no deck or list effect that would do it for them.
- **An imported highlight's id is its rkey** (`margin:<rkey>`), and that prefix is also the only
  mark of an imported highlight — `marginRkey` is not, since Skyreader stamps it on its own
  highlights the moment they are pushed out. The re-key pass reads the id, not the rkey: a highlight
  Skyreader made is keyed to the article it was made on, and moving it onto a later save of the same
  URL would tear it off that article. The id is not a random string, either. Two devices can
  both poll before either one's label write has synced down, so both see an empty `knownRkeys` and
  both import the same note; ids are what `unionHighlightSources` merges on, so a random id would
  leave two copies of the same passage alive forever.
- **Symmetric lifecycle.** Imported highlights carry `marginUri`/`marginRkey` exactly like one
  Skyreader pushed out, so re-polls dedup on the rkey, note edits update the same record, and
  deletion deletes the Margin record. That last one is what stops a deleted highlight resurrecting on
  the next poll — and it is a cross-app delete, so `RemoveHighlightModal` always says "This also
  removes it from Margin" before it happens.
- **A note edit merges, it doesn't rebuild.** That symmetry cuts both ways: the update path can now
  reach a record _Margin_ wrote, and `putRecord` replaces the whole thing. Rebuilding it from the
  fields Skyreader models would stamp our `generator` onto the reader's own record, swap
  `target.source` for our normalized URL and drop every field of this third-party lexicon we don't
  know about. So `mergeMarginNoteUpdate` reads the record first and changes only the comment body,
  keeping even the `format` the record declared. `buildMarginNoteRecord` is the fallback for when
  there's nothing to merge onto, where `putRecord` is creating the record and our shape is the right
  one.
- **Unmatched imports still render, and stop being unmatched.** A note whose article isn't in any
  local cache is keyed by its normalized URL and carries `sourceUrl`/`sourceTitle`;
  `resolveHighlightSource` (`frontend/src/lib/utils/highlightSource.ts`) falls back to those, shared
  by the list and the deck so the two degrade identically. Re-anchoring needs no work: if the user
  later opens the article, `findTextInDOM` anchors by `exact`/`prefix`/`suffix` as usual. But the
  import is idempotent on the rkey, so a note imported _before_ its article was saved would sit under
  that URL key forever — no highlight on the article in the reader, and a group of its own in the
  list — even once the server could match it. So each poll runs a second pass,
  `planMarginHighlightRekeys`, that moves known notes onto the canonical key their save now has,
  adding before removing so an interruption leaves a visible duplicate rather than nothing. Only ever
  _toward_ a match: a note that loses one (the reader unsaved the article) stays put instead of
  shuttling back and forth every fifteen minutes.

The toggle is device-local. Once one device imports, the highlights sync everywhere as normal label
rows.

## Copy

Highlights are private to Skyreader (D1 + IndexedDB). Saving one to Margin publishes _that note_ to
the user's PDS. Never say highlights live on the PDS, and Margin
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
