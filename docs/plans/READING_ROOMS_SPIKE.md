# Reading Rooms Spike: public read-alongs on Semble collections

> A "reading room" is a set of articles people read together. The full vision (shared progress,
> spoiler-gated annotations, room discussion, private clubs) is deliberately **not** this document.
> This is a minimal public spike to test the first-order hypothesis: **does shared presence around a
> reading list create pull?** Do people join a room, and does "4 people are reading this" make you
> open the article?
>
> Design discussion that produced this spike (full-feature decomposition, communities-proposal
> assessment, private-vs-public fork) is summarized in the Appendix.

## The spike in one paragraph

A public reading room **is a Semble collection** — the collection's at-uri is the room's identity,
its record supplies the title and description. **Joining** writes one public record
(`app.skyreader.reading.readAlong`, subject = the collection at-uri) to the joiner's own repo.
The room page shows the collection's articles (via the proven external-backing read path), the
avatars of everyone who joined (via Constellation backlink queries — no new backend index), and an
anonymous per-article read count ("3 read this") served from a small D1 table that only counts reads
made *through the room surface*. Comments, annotations, shared progress positions, and a rooms
directory are all deferred.

## Decisions

- **Room identity = the collection at-uri.** No room entity, no room metadata store, no naming or
  governance problem. Open vs. closed Semble collections both work: "closed" only gates *curation*
  in Semble, and reading along is orthogonal to curation rights — a closed collection is simply a
  curator-led room (a syllabus), which is a legitimate room flavor we get for free.
- **Join is a public record in the joiner's own repo.** Structurally a follow:
  `{ subject: <collection at-uri>, createdAt }`. This is also the consent boundary — joining is an
  explicit public act, which is what licenses showing the joiner's avatar on the room page.
  Unjoin = delete the record.
- **Membership is aggregated via Constellation, client-side.** Same pattern as the @mention inbox
  (backend subsystem removed; frontend polls Constellation directly): query backlinks to the
  collection URI, filtered to the `readAlong` NSID. Zero backend, reflects deletes. This matches
  the project's momentum away from firehose→D1 indexing (mentions, standard.site lazy fetch).
- **No rooms directory in the spike.** Join is by link only (someone shares a room URL).
  Constellation answers "who joined *this* room" but cannot enumerate "what rooms exist" — a
  `/rooms` discover page is exactly the thing that would force a Jetstream→D1 index of the join
  NSID. Defer the directory, not just comments.
- **"Read" means read-through-the-room, and it's explicit.** A read is counted when a user presses
  **"Mark as read"** at the end of an article opened *from the room surface* (not merely on open —
  opening is curiosity, marking is the done signal), into a D1 `room_reads` table keyed by
  `(collection_uri, url_normalized, did)`. We do **not** join room items against existing read
  state. See below for why.
- **Read status is served, not written.** Counts are aggregate and anonymous ("3 read this"),
  computed in D1, never written to public records. Consistent with the existing stance that read
  state lives server-side, not on the PDS.
- **Reading the collection reuses the external-backing read path** (`backend/src/services/backing/read.ts`):
  per-URI `getRecord`, heterogeneous item types, cross-repo membership, snapshot semantics.
  Extracted bodies land in the url-keyed enrichment store (`saved_articles`) **without** creating
  Saved-list membership — the membership/enrichment split from the backed-saves plan was built for
  exactly this reuse.
- **Comments/annotations/progress positions: deferred.** The spike tests presence, not conversation.

## Why read-through-the-room, not existing read state

Three reasons, in descending order of importance:

1. **Privacy.** Joining a room must not retroactively disclose reading history. If we joined room
   items against existing read state, joining would reveal that you'd already read 30 of its
   articles years ago. Counting only reads made through the room means the social signal starts at
   the moment of consent.
2. **No join-key problem.** Room items are URLs from a foreign collection, not feed items or saves;
   `room_reads` keyed by `url_normalized` sidesteps reconciling against `item_labels_cache`
   entirely.
3. **Honest semantics.** The count undercounts (someone read the piece elsewhere), and that's fine —
   the number means "read *here, together*," which is the thing the spike is measuring anyway.

## The join lexicon

`frontend/lexicons/app/skyreader/reading/readAlong.json` (and backend copy, per existing lexicon
layout):

```json
{
  "lexicon": 1,
  "id": "app.skyreader.reading.readAlong",
  "defs": {
    "main": {
      "type": "record",
      "description": "Declares that the author is reading along with a collection.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "createdAt"],
        "properties": {
          "subject": {
            "type": "string",
            "format": "at-uri",
            "description": "The collection being read along with (e.g. a network.cosmik.collection)."
          },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

Named for what it asserts — "I'm reading along with this collection," not "membership" (there is no
membership authority to be a member *of*). `subject` is a generic at-uri: nothing Semble-specific,
so a Margin collection (or anything else) can host a room later without a lexicon change. If the
primitive proves out, graduating to a community namespace is a rename, not a redesign.

**The Semble pitch.** Because the record is public and Constellation is queryable by anyone, Semble
can render "n people reading along in Skyreader" on their own collection pages with zero
coordination beyond knowing the NSID. This is the cheapest possible first deep-integration ask —
an afternoon on their side, no ACLs, no webhooks — and it makes the join record mutually valuable
from day one. Raise it before building; if they'd rather the NSID live somewhere shared, better to
know now.

### The whole integration, concretely (what to hand Semble)

Two constants and three URL shapes. Nothing to authenticate, nothing to coordinate, no webhook.

**1. The count** — one unauthenticated GET per collection, which is all a collection page needs:

```
GET https://constellation.microcosm.blue/links/count/distinct-dids
      ?target=<collection at-uri, url-encoded>
      &collection=app.skyreader.reading.readAlong
      &path=.subject

→ { "total": 4 }        // "4 people are reading along in Skyreader"
```

**2. The people**, if they want avatars rather than a number:

```
GET https://constellation.microcosm.blue/links/distinct-dids
      ?target=<collection at-uri>
      &collection=app.skyreader.reading.readAlong
      &path=.subject
      &limit=100[&cursor=…]

→ { "linking_dids": ["did:plc:…", …], "cursor": "…" }
```

Page while `cursor` is present and the page is non-empty, dedupe, then resolve DIDs to profiles
however they already do. These are the exact two calls Skyreader makes of itself
(`fetchRoomMemberCount` / `fetchRoomMembers` in `frontend/src/lib/services/rooms.ts`), so anything
they render agrees with our room page by construction.

**3. The join link** — the other half of the trade, and the part that sends readers back:

```
https://skyreader.app/rooms?uri=<encodeURIComponent(collection at-uri)>
```

e.g. `https://skyreader.app/rooms?uri=at%3A%2F%2Fdid%3Aplc%3Aabc123%2Fnetwork.cosmik.collection%2F3muahss6xki2b`
— a "Read this along with others" button next to the count. A visitor who follows it lands on the
room whether or not they have an account; Join is where sign-in is asked for. Nothing else is
needed: the room's title, description, and article list are read off the collection record itself,
so Semble passes only the at-uri it already has. (The paste box on `/rooms` also accepts a bare
`semble.so/profile/<handle>/collections/<rkey>` page URL, via `resolveRoomInput` — so a plain
Semble link a person copies by hand still finds its room. The `?uri=` form is the one to build.)

Four caveats worth stating in the same breath, because each is a way a naive integration reads as
broken:

- **Constellation is an index, not the authority.** It lags a write by seconds, so someone who just
  joined from Skyreader will not appear on their next page load.
- **A failed lookup is not zero.** We render no marker at all on error rather than a confident
  "nobody is here" (`fetchRoomMemberCount` returns `null`, not `0`); an empty room shows nothing
  either, since "0 reading along" is worse than silence.
- **`path=.subject` is load-bearing.** Without it the query returns every record type pointing at
  the collection, `collectionLink` membership included.
- **No batched-targets form exists**, so a page listing many collections means one request each.
  Our own `/rooms` index fires them after the rows render and lets slow ones land late.

## Data model (D1)

One new table:

```sql
CREATE TABLE room_reads (
  collection_uri TEXT NOT NULL,
  url_normalized TEXT NOT NULL,
  did            TEXT NOT NULL,
  read_at        INTEGER NOT NULL,
  PRIMARY KEY (collection_uri, url_normalized, did)
);
```

Counts are `COUNT(DISTINCT did)` per `(collection_uri, url_normalized)`. No `rooms` table, no
`room_members` table — identity is the at-uri, membership lives in members' repos.

## Surfaces

- **Room page** (`/rooms/<encoded collection at-uri>` or similar): collection title/description
  from the collection record; article list from the backing read path; "N reading along" with a few
  avatars (Constellation + profile resolution); per-article read counts; Join/Leave button.
  Articles open in the reader via the normal saved-article extraction path (enrichment store,
  no Saved membership).
- **Join flow**: paste/receive a room link → room page → Join writes the `readAlong` record
  (requires Atmospheric sync consent framing — see copy below).
- **Optional cheap hedge** against the "quiet room" problem: link each member's avatar to their
  existing public linkblog, so joiners have *something* of each other to read without any comment
  infrastructure.

## Copy notes (per CLAUDE.md Atmosphere framing)

- Joining is **public to the whole Atmosphere** — it writes a record to the user's repo. Say so at
  the join moment, calmly: e.g. "Joining is public: anyone can see you're reading along."
- Read activity is **only ever an anonymous count inside Skyreader**. Never per-user, never a
  record. The honest line, true by construction: *joining is public; what you read here shows up
  only as a count.*
- No em-dashes in user-facing copy; keep it terse, reading-first.

## What the spike tests — and what it doesn't

**Tests:** whether shared presence around a reading list creates pull (join rate given a shared
link; whether read counts correlate with opens; whether rooms get shared at all).

**Does not test:** "reading together." There is no conversation, so a room is ambient presence
around a list. **Interpretation guard:** weak engagement here means *presence alone* may not carry
the feature — it does not falsify rooms-with-conversation, which the full design treats as the core
payload. Don't over-read a quiet spike.

## Implementation order

1. **Lexicon + join/leave.** `readAlong` record write/delete from the frontend (user's own repo,
   standard record CRUD). Smallest testable unit.
2. **Room page read path.** Resolve collection at-uri → title/items via the backing read service;
   open-in-reader via enrichment store.
3. **Membership display.** Constellation backlink query for the NSID + subject, resolve DIDs to
   profiles, render avatars/count. (Mirror the mention-inbox client-side pattern.)
4. **Read counts.** `room_reads` migration; record on open-from-room; count endpoint; render.
5. **Copy pass** per the framing notes above.

Steps 1–3 involve no backend changes at all; step 4 is one table, one route.

## Deferred (explicitly)

- Comments, annotations, highlights surfaced to the room, shared progress positions, spoiler
  gating — the conversation layer (D1-shaped in the full design; for room discussion
  specifically, Roomy is now the leading candidate — see the Roomy section below).
- `/rooms` **global** directory (forces Jetstream→D1 indexing of the join NSID). The follow-graph
  slice of discovery is built — see "Rooms your follows are in" below — but "what rooms exist at
  all" still isn't answerable client-side.
- Private rooms (D1 membership; the full design's recommendation is private-membership rooms with
  a public reading list and an optional published digest).
- ~~Room-level curation UX~~ — built, see "Adding articles to a room" above. Still deferred:
  removing an article (only the record's author can delete their own membership), and any notion
  of who added what.
- Communities-proposal alignment (room as community DID). Watch, don't build: the OpenSocial
  proposal is pre-implementation (community DID + own PDS + OAuth delegation; proxy permissions,
  invite spam, multi-host spaces unresolved as of the Aug 2026 working group). The spike's
  concepts (identity, membership-in-own-repo, roles-later) are shaped to upgrade into it if it
  lands.

## Implementation notes (built 2026-09-03)

Landed as specced, with two deviations forced by what the codebase actually does:

- **Reader path is the stateless `/api/extract`, not the enrichment store.** Writing a bare
  `saved_articles` row (enrichment without membership) is not actually membership-free for a user
  with external backing on: `listBackedSaved`'s native-only branch would surface it in their Saved
  list. The feed proxy caches extraction per URL, so opening from the room extracts on demand and
  writes nothing to D1. Revisit only if room opens need offline bodies.
- **Join/leave go through the backend.** The frontend has no PDS write path (no agent/DPoP in the
  browser; every repo write rides the backend's `PDSClient`), so `POST/DELETE /api/rooms/join`
  write/delete the readAlong record server-side. That also meant a new OAuth scope,
  `repo:app.skyreader.reading.readAlong` (`READING_ROOM_SCOPES`), added to `ALL_POSSIBLE_SCOPES`
  only — existing sessions hit the standard scope-upgrade re-auth on first join.

### Adding articles to a room (built 2026-09-03)

A room whose collection accepts additions gets an add box above its list: one input that takes a
pasted link **or** searches the reader's own saved library as they type (`RoomAddBox.svelte`;
library matches are metadata-only, over the already-hydrated `savesStore`). A library pick carries
its title/author/description straight into the foreign record; a bare URL gets extracted
server-side for a title, best effort.

Two things this forced, both load-bearing:

- **Who may add is the collection's own rule, read off its record.** Semble's `accessType` is
  `OPEN` (anyone) / `CLOSED` (owner plus listed `collaborators`) — confirmed against the published
  lexicon at
  `at://did:plc:b2p6rujcgpenbtcjposmjuc3/com.atproto.lexicon.schema/network.cosmik.collection`.
  So an open collection is a room anyone can co-curate, and a closed one stays curator-led.
  `at.margin.collection` carries no access field at all, so a Margin room is **owner-only**: a
  missing permission reads as the stricter answer. `GET /api/rooms` reports this as `canAdd`;
  `POST /api/rooms/items` enforces it (plus the provider's own repo scopes) rather than trusting
  the UI.
- **The room read path now unions in membership from OTHER repos.** A contributor can only ever
  write into their own repo, so the owner-repo-only snapshot would have hidden every foreign add
  from everyone, the contributor included. The collection's backlinks in Constellation are the only
  way to find those, so `snapshotBackedCollection` grew an opt-in `includeForeign` — rooms ask for
  it, backed **saves deliberately do not**, since a stranger adding to a user's public collection
  must not inject rows into that user's Saved list. Constellation is an index, not the authority:
  every record it names is fetched and re-checked against the collection uri, and an outage yields
  `complete: false` (the room says the list may be short) rather than a silently truncated list. A
  fresh add is shown optimistically for the same reason the join button shows your own avatar
  early: the index lags the write by seconds.

**Reading order: unread first, then oldest addition first.** The second key is the membership
record's own timestamp (Semble's `collectionLink.addedAt`, Margin's `collectionItem.createdAt`),
threaded through the snapshot as `BackedMember.addedAt` — not the item record's `createdAt`, which
is when the card was made and can long predate its filing. Nothing else can serve as the order: the
owner's links arrive in `listRecords` order, a contributor's arrive from Constellation, and
`resolveMembers` finishes them out of order anyway (bounded concurrency), so an unsorted list would
put every foreign add at the end and shuffle within a poll. `snapshotBackedCollection` sorts
(undated last, `linkUri` as the tiebreak, so the same collection always resolves the same way), the
dedupe of cross-repo duplicates therefore keeps the *earliest* add, and both surfaces re-apply the
rule client-side through the shared `sortRoomItems` (`frontend/src/lib/utils/roomArticle.ts`) since
marking something read must move it down live. One consequence for the add box: a fresh add now
sorts to the end of the unread pile, which can be below the fold, so it confirms with a toast rather
than by appearing at the top.

A room also links back out to where its list actually lives: the header carries "View collection on
Semble," and each row of the `/rooms` index carries the same link as a quiet icon. This is the exact
inverse of the paste-a-link parser (`collectionPageLink` sits next to `sembleCollectionPageToUri`),
and it inherits that parser's constraint: Semble keys a collection page by the owner's **handle**,
not their DID, so the link needs a DID → handle resolution and is simply **absent** when that fails
(`handle.invalid` included) rather than built from a guess. Same for a provider with no such page:
`at.margin.collection` has no constructible collection view, so a Margin room links nowhere. The
feed proxy's filed-in-a-collection cards already took this stance
(`feed-proxy/src/mention-lane.ts`); the reader now matches it.

One consequence worth knowing: writing a Semble `collectionLink` at someone else's collection needs
that collection's **cid** for the strongRef, and `PDSClient.getRecord` only ever reads the session's
own repo — hence `getRecordPublicWithCid`, threaded into `createMember` as `collectionCid`.

A post-build revision (same day): reads were originally counted on open-from-room; that conflated
opening with finishing, so the count is now driven by an explicit **"Mark as read"** button at the
end of the article (`SavedReader`'s host-provided `onMarkRead`/`markedRead` props, wired only by
`RoomPage`). The same action sits in the reader toolbar (desktop header + mobile bottom bar); the
dedicated Tag toolbar button moved into the ⋯ / Style & Actions menus to make room (the `t`
shortcut still works). One-way: the backend has no unmark, and the button becomes a quiet
"You read this" once pressed.

Home also grew one lane per joined room (same day): the room's articles as tiles, opening in the
reader via the shared extract path (`utils/roomArticle.ts`) with the same Mark-as-read wiring
(archive/remove suppressed — the reader item is synthetic, not a save). Room data is cached per
session in `stores/rooms.svelte.ts` (readAlong list + `GET /api/rooms` per room, loaded once per
account; the room page pushes its read marks into the cache via `noteReadElsewhere`, and triggers a
full cache refresh whenever a room view is left — that page is where joins/leaves/new articles
happen). Since **Local caching** below, that session cache sits on a disk cache, so a cold tab
paints its lanes before any request settles. Lane tiles sort unread-first and read ones get a quiet
check + dimmed title (`LaneCardVM.read` → `HomeLaneCard`).

Also: `/rooms` with no `?uri=` lists the rooms you've joined (your own readAlong records, read
publicly from your own PDS) plus an open box — join is still link-only; this is not the
deferred directory. That box (`RoomOpenBox.svelte`) is the same one-field-two-jobs shape as
`RoomAddBox`: paste a room or collection link, **or** click in and pick one of your own
Semble/Margin collections, narrowed as you type (`collectionsStore`, the cached list the save
picker already keeps, so it opens with the click and costs nothing until someone opens it). A
collection you keep IS a room, so the fastest way into one shouldn't be a round trip to semble.so
to copy a URL back. Rows already under "Your rooms" are marked, not hidden — picking one is still
the quickest way back in. Rooms is reachable on mobile from the bottom bar's switcher
(`MobileFeedSwitcher`, account-only, beside Discover in the sidebar's order), which means the page
itself has to carry `StaticPageChrome` — that switcher is the only in-app way off a page in an
installed PWA. The chrome takes a `readerOpen` flag so the page's bottom bar stands down while a
room article is open, the way every feed surface already gates its own, and the whole thing is
gated on `auth.isInApp` so a signed-out visitor on a shared room link gets no app chrome. Each listed room carries the collection's own name **and description**
(`fetchCollectionMeta`, one public `getRecord` per room), matching what the room page shows; a
room view links back to that index with an "All rooms" link rendered outside the load/error branch,
since a room reached by a shared link is often the first page a visitor sees. Each index row also
carries the room's presence marker ("3 reading along"), so a room reads as busy or quiet **before**
you open it — the whole point of the spike is whether presence creates pull, and burying it one
click deep tests something weaker. That's `fetchRoomMemberCount`, one
`/links/count/distinct-dids` per room rather than paging the DID list, since no avatars are drawn
here; counts land after the rows render, so a slow Constellation never holds up the list. Three
absences are deliberate: no marker while the count is in flight, none on a failed lookup (null, not
a confident zero), and none for an empty room. A room you've joined floors at 1, since Constellation
lags your own join record by seconds — the same reason the join button shows your avatar early.
Room surface: `GET /api/rooms?uri=` (backing read path + `room_reads` counts),
`POST /api/rooms/read`, migration `0077_room_reads.sql`, `RoomPage.svelte`, membership via
Constellation `/links/distinct-dids` on `.subject`. The lexicon is published at
`/.well-known/lexicons/app/skyreader/reading/readAlong.json`. The Semble pitch (render "n reading
along in Skyreader" from the NSID) is still unraised — raise it before this ships beyond a spike;
the calls and the join-link shape to hand them are written out under "The whole integration,
concretely" above.

### Rooms your follows are in (built 2026-09-03)

The `/rooms` index now carries a third section, "Where people you follow are reading": rooms found
by scanning the reader's own Bluesky follow graph for `readAlong` records. Join stays link-only for
strangers; this is the one discovery path that needs no directory, because the answer is already
sitting in repos we can name.

**Why the scan runs the opposite way from everything else here.** Constellation is indexed by
target: it answers "who joined THIS room" and cannot enumerate rooms, which is exactly why the
directory was deferred. Asking per repo instead ("what has this account joined") is a plain
`listRecords` on their PDS, so walking the follow graph answers a useful slice of the directory
question with no index at all. Still no Jetstream, still no D1, still nothing global.

That walk already existed. `/discover` scans the same graph for `site.standard.publication`
records, so the graph maintenance moved out of `stores/followingPublications.svelte.ts` into
`services/followGraph.ts` (one owner of `db.follows`, one TTL, one background walk, deduped when
both surfaces ask at once) and rooms became a second scanner over it:
`scanReadAlongs` + `stores/followingRooms.svelte.ts`, cached in Dexie v39 `followingRooms`, keyed
`[did+subject]`. Three details that are load-bearing:

- **The PDS endpoint is cached on the follow row** (`pdsForFollow`). Two scanners resolving the
  same few thousand DIDs through plc.directory is the dominant cost of adding the second one.
  A moved account leaves a stale endpoint that would read as "no rooms" forever, so a scan that
  fails against the cached PDS forgets it and the next pass re-resolves.
- **A re-scan replaces an account's rows rather than merging** — it is also how a room someone left
  stops being listed. Re-scan TTL is 3 days, shorter than the publications week: joining a room is
  a much more frequent act than starting a publication.
- **No Constellation count on these rows.** The people you follow *are* the presence signal here,
  and a count per row would be one request each. The row shows their avatars and names; the total
  stays on the room page.

Rows are dropped, not shown as husks, when the collection record can't be fetched (same stance as
the featured list), rooms you've already joined stay under "Your rooms", and a room your follows
are in is filtered out of Featured, which says the same thing with weaker evidence.

### Local caching (built 2026-09-15)

Every room list now paints from disk and refreshes behind the paint. Before this, opening a room
meant watching "Loading room…" while the backend walked a foreign collection record by record, and
the /rooms index re-described every room off its owner's PDS on each visit — for lists that change
maybe daily. The reader paid a remote read for something they had already seen.

`services/roomCache.ts` owns both halves. The article list is a per-room snapshot in Dexie v40
`roomSnapshots`, keyed `[did+subject]`; the index's lists (your rooms described, the featured rows)
and the Constellation presence readings are small metadata blobs, since each is always read whole.
Everything is dropped by `clearAllData` on sign-out.

- **The snapshot is per reader, not per room.** `readByMe`, `canAdd` and `joined` are answers about
  one account, so a shared device must never paint one reader's marks for the next. A signed-out
  visitor's copy is filed under an anonymous owner (`ANON_ROOM_DID`) — a room reached by link is
  often a visitor's first page, and it carries no personal read state to leak.
- **A failed refresh leaves the last good copy standing.** The room page only shows "Could not load
  this room" when it has nothing cached; `roomsStore` falls back to a room's snapshot when that one
  room's read fails, rather than dropping its lane. `fetchMyRooms` returns **null** (not `[]`) when
  the PDS doesn't answer, so a blip can't read as "you left every room" — the same stance
  `fetchRoomMemberCount` already took for Constellation.
- **The join list is cached in its own right** (`rooms.joined`, subjects in PDS order), so lanes
  painted from cache are in the order the refresh will put them in and nothing reshuffles when it
  lands.
- **The snapshot is written from an effect**, not at each call site: a join, a leave, a mark-as-read
  and an article added here all reassign `room`, and no path can update it and forget the cache.
  `roomsStore` writes read marks through to the snapshot for the same reason.
- **Constellation is cached in one place for both surfaces.** The index asks it for a count per row
  (`fetchRoomMemberCount`), the room page for the readers themselves (`fetchRoomMembers`); both
  write the same per-room reading (`total` + the readers the avatar row draws, capped at 12), so
  whichever surface you reach first warms the other. A count-only refresh keeps the readers an
  earlier room-page visit stored; an empty array, a room that really has nobody, replaces them.
  The readers are cached **as drawn** (handle, name, avatar), not as bare DIDs: a DID still costs a
  profile lookup before it can be rendered, and a presence line that arrives a beat late is the
  pop this cache exists to remove.
- **Presence is read beside the snapshot, not behind the room fetch.** `loadRoom` reads both from
  disk in one `Promise.all` and paints them in the same tick, then starts the Constellation and
  collection-link lookups *before* awaiting `/api/rooms` — they are their own lookups, and gating
  them on the slowest read on the page was what made the presence line grow in under the reader
  after everything else had settled. Joining writes the optimistic row through to the cache too, so
  coming back before Constellation catches up doesn't drop you from the room you just joined.
- **Presence readings are cached, failures aren't.** A null count is a failed lookup, not a number,
  and `fetchRoomMembers` now returns null (not `[]`) when Constellation never answers, so an outage
  leaves the count and the avatar row as they were instead of emptying the room out. A later page
  failing mid-walk still returns what was collected — a short list beats no list.
- **Presence is the most perishable thing here**, since it's a claim about who is around right now:
  a reading nobody has refreshed in a week is dropped rather than painted, and the blob keeps the 60
  most recently refreshed rooms. Snapshots, being just article lists, are pruned at 30 days.

## Roomy as the conversation layer (assessed 2026-09-03)

If the spike proves presence, the deferred conversation layer's leading candidate is **Roomy**
(muni.town's atproto group-messaging app; local checkout at `~/dev/roomy`), displacing the
appendix's "per-article threads in D1" sketch: one Roomy space per reading room. On-brand
(the "cozy community software" lineage matches the Reading Room framing), real chat UX for free,
and the integration is small. Assessment from a deep read of the checkout — note Roomy's
`README.md`/`ARCHITECTURE.md` are stale; `AGENTS.md` + `packages/appserver/docs/plans/` are
accurate.

**Do not bolt this onto the spike itself.** The spike tests presence without conversation
(see the interpretation guard); adding chat day one confounds the two. This is phase 2, gated on
the spike showing pull.

### Shape of the integration

- **Creation is trivial.** A Skyreader bot atproto account (app password suffices) calls the
  appserver procedure `space.roomy.space.createSpace` → space DID. The whole headless client is
  ~15 lines (`roomy/packages/cli/src/auth.ts`): `AtpAgent.login()` → `ServiceAuthClient` →
  `DirectXrpcClient(appserverUrl, "did:web:api.roomy.space")`. SDK is `@roomy-space/sdk` on npm
  (0.4.0), explicitly intended for third-party apps; appserver URL/DID are constructor args.
- **Lazy creation.** On first "discuss" interaction for a room, backend creates the space and
  persists `collection_uri → space_did` (+ channel ULID) in D1 next to `room_reads`. Create the
  channel with a **client-minted ULID** and stamp the collection at-uri into the event's open
  `extensions` map — copy the discord-bridge pattern exactly
  (`roomy/packages/discord-bridge/src/services/room-sync.ts`), it's the reference headless
  integrator.
- **Deep link:** `https://roomy.space/<spaceDid>` or `/join?space=<spaceDid>`. URLs carry raw
  DIDs (no handle routing); ugly but stable.

### Constraints (the two real ones)

1. **The bot cannot enroll users.** Each user must call `joinSpace` with their own auth — so
   joining the room (readAlong record) and joining its chat are separate acts. Cheap version:
   link out to Roomy's `/join` page, user logs in with Bluesky there. Integrated version:
   Roomy auth is just `com.atproto.server.getServiceAuth` JWTs, and our backend already holds
   the user's OAuth session — one added scope
   (`rpc:com.atproto.server.getServiceAuth?aud=<appserverDid>`, same scope-upgrade dance as
   `readAlong`) lets the backend mint service-auth tokens so users join/post from inside
   Skyreader.
2. **No embeddable chat exists** (no widget, no iframe build; "app-lite" means thin client, not
   embed). Inline chat means building our own UI against `getMessages` + the sync WebSocket.
   The pleasant surprise: **anonymous read of a public space works** (CORS is `*`), so the room
   page can render the discussion read-only for everyone, with "join to reply" linking out.
   Gotcha: non-members get an empty sidebar from `getMetadata`, so we must carry the channel
   ULID in D1 ourselves.

### Tensions to price in

- **Portability.** Roomy messages are not atproto records — unsigned CBOR blobs in one
  appserver's SQLite (`signature x''`), invisible to the firehose/Constellation, no export
  story. The appserver is documented as transitional (Rust rewrite planned); the XRPC lexicon
  surface is the stable contract, the storage is not. Roomy membership is also not a record, so
  it can't feed our Constellation avatar display. Arguably fine for ephemeral chat, but it sits
  awkwardly next to the ownership foundation — the durable record (readAlong) stays in the
  member's repo, the chat does not.
- **Coordination.** Like the Semble NSID pitch: talk to muni.town before shipping.
  Programmatic space creation on their production appserver, IP-based rate limits (100 req/60s),
  and a "make a Roomy space for any collection" story they may actively want.

### Sequencing

1. Deep-link-out (~a day): lazy space creation, D1 mapping, one "Discussion" link on the room
   page.
2. If the link gets used: read-only inline render + join-to-reply.
3. Only then consider full in-app posting via the service-auth scope.

## Appendix: how we got here (full-feature decomposition)

"Read a collection together" bundles four layers that want different representations:

1. **Article set** — stable, co-curated, wants portability → **Semble collection.** Cross-repo
   `collectionLink` membership is proven live (backed-saves Phase 0): each member can add links
   from their own repo, so a shared collection is already a co-curated reading list with no new
   lexicon and no community DID.
2. **Membership/identity** — spike: at-uri + readAlong records; later: possibly a community DID.
3. **Progress** — presence-like, mutable, privacy-sensitive → **D1, never PDS.** Also required
   server-side for the full design's spoiler gating (annotations shown only up to where you've
   read = a D1 join of progress × comments).
4. **Annotations/discussion** — the real social payload; deferred. Full-design sketch: member
   highlights stay records in each member's own repo (on-thesis: your sensemaking work is yours),
   surfaced to the room via D1 association; per-article threads in D1 reusing the merged
   discussion-stream UI (superseded as the room-discussion candidate by Roomy — see the section
   above); optional published room digest via linkblog/standard.site machinery
   ("private process, public product").

Bigger Semble asks, sequenced *after* the NSID/reader-count pitch: collaborators/ACLs on
collections (multi-curator support acknowledged in their UI, link-removal semantics), change
notification (webhook or bumped `updatedAt`) so room lists feel live without aggressive polling,
and whether NOTE cards attached to a collection are intended as a discussion surface (a candidate
portable home for room comments).
