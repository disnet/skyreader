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
- **"Read" means read-through-the-room.** A read is counted when a user opens an article *from the
  room surface*, into a D1 `room_reads` table keyed by `(collection_uri, url_normalized, did)`.
  We do **not** join room items against existing read state. See below for why.
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
- `/rooms` directory / discovery (forces Jetstream→D1 indexing of the join NSID).
- Private rooms (D1 membership; the full design's recommendation is private-membership rooms with
  a public reading list and an optional published digest).
- Room-level curation UX (adding articles to the collection from Skyreader — already possible via
  the existing Semble write path, but not a spike goal).
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

Also: `/rooms` with no `?uri=` lists the rooms you've joined (your own readAlong records, read
publicly from your own PDS) plus a paste-a-link box — join is still link-only; this is not the
deferred directory. Room surface: `GET /api/rooms?uri=` (backing read path + `room_reads` counts),
`POST /api/rooms/read`, migration `0077_room_reads.sql`, `RoomPage.svelte`, membership via
Constellation `/links/distinct-dids` on `.subject`. The lexicon is published at
`/.well-known/lexicons/app/skyreader/reading/readAlong.json`. The Semble pitch (render "n reading
along in Skyreader" from the NSID) is still unraised — raise it before this ships beyond a spike.

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
