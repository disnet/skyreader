# The Shelf: reference material alongside the Saved queue

## Why

Saved is built as a **to-read queue**: Inbox → read → Archive, newest first. That works for an
article you read once. It doesn't work for **reference material**: books (EPUB), papers (PDF), long
documents you return to. A book you've finished isn't "done" the way an archived article is. You
come back to it, quote it, file it with related material. Archiving it hides the thing you'll want
next, and a newest-first list buries it under this week's links.

PDF and EPUB support (uploads and links) made this gap obvious, so the Saved pile now needs a second
way to be read: as a **shelf**, not a queue.

## Shape

**The Shelf is a view over the same saves, not a second pile.** Nothing moves between them.

- **Saved** stays the queue (Inbox / Archive, unchanged).
- **Shelf** (`/shelf`) shows the saves the reader keeps. It has no Inbox/Archive split, and
  finishing an item doesn't take it off. A save can be on both: archiving it leaves the queue and
  keeps it on the Shelf.

### What puts a save on the Shelf

1. **Its kind, by default.** PDFs and EPUBs (uploaded or saved by link) are on the Shelf unless
   taken off. Webpages are off unless kept.
2. **A `kept` item label** that overrides the default: `props.kept` is `true` (keep) or `false`
   (take a default-on save off). There's no label for "default". Taking a webpage off clears its
   label rather than writing `false`.
3. **Being in a collection.** A collection member is on the Shelf by definition, so taking an item
   off the Shelf also removes it from its collections.

The `kept` label rides the existing managed-label delta (`itemLabels.svelte.ts`,
`MANAGED_LABELS`), so it syncs across devices, works offline and for guests (queued like any
label), and needed no schema. Like `archived`, a save answers to several keys
(`savedItemLabelKeys`). Reads take the newest `kept` label across all of them, and writes cover the
primary key plus any alias already carrying one.

### Collections

Collections are the one part that needed real tables (`0093_shelf_collections.sql`):

- `shelf_collections`: `(user_did, id)`, name, description, `position` (REAL, for cheap
  reordering), timestamps. `id` is a client-minted TID, so creates are optimistic and idempotent.
- `shelf_collection_items`: `(user_did, collection_id, saved_rkey)`, `position`, `added_at`.
  Members are keyed by the save's **rkey**. The client mints it before the server sees the save, it
  never changes, and uploads have it even though they have no URL.

Why tables and not tags: collections are **ordered**, **described**, and meant to be **shareable
later** (export to a Semble/Margin collection, or open as a reading room). A tag is none of those.
Tags stay what they are: loose, cross-cutting labels that also filter the Saved list.

API (`backend/src/routes/shelf.ts`, all session-only, all scoped to the caller's DID):

| Method   | Path                                     | Notes                                                                               |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET`    | `/api/shelf/collections`                 | Every collection with its members, in order                                         |
| `POST`   | `/api/shelf/collections`                 | `{id, name, description?}`; idempotent on `id`                                      |
| `PATCH`  | `/api/shelf/collections/:id`             | `{name?, description?, position?}`                                                  |
| `DELETE` | `/api/shelf/collections/:id`             | Removes memberships too; the saves are untouched                                    |
| `POST`   | `/api/shelf/collections/:id/items`       | `{rkey}` or `{rkeys}`; appends; idempotent; a bulk add past the cap adds none (409) |
| `DELETE` | `/api/shelf/collections/:id/items`       | `{rkeys}`; bulk remove; idempotent                                                  |
| `DELETE` | `/api/shelf/collections/:id/items/:rkey` | Idempotent                                                                          |
| `PUT`    | `/api/shelf/collections/:id/items`       | `{rkeys}`; named first, unnamed keep their order                                    |

Limits: 200 collections, 2,000 items each, 100-char names, 1,000-char descriptions. Deleting a save
(`DELETE /api/saved/:rkey`, `/by-guid/`) drops its memberships. A member whose save disappears any
other way (a backed-collection snapshot removing it, say) is skipped by the client when it renders.

An import from another read-later app (`routes/saved-import.ts`) files everything in the export,
new and already-saved, in a collection named "Imported from <app>", created on the first import.
Past 2,000 items it continues in "Imported from <app> (2)" and so on; an article already in one of
them isn't added again, so a re-run import changes nothing. At the 200-collection cap the saves
import without one.

**Sync.** The set is small, so the client fetches it whole (`shelfStore.load`, once per account per
session, after boot) and caches it in Dexie `metadata` for offline display. Writes are optimistic,
need the network and an account, and **roll back with a toast** on failure rather than queueing. A
reorder or membership change racing another device is resolved by the server's idempotent, merge-y
endpoints, not by a delta. If collections grow or cross-device editing gets busy, the upgrade is a
`?since=` delta like labels'.

### Privacy

Collections and the `kept` label are **private and D1-only** by default. Nothing here reaches the
PDS or a Semble/Margin backing collection, unless the reader **links** a collection (below), which
makes that one public. Uploads never leave, matching the "native-pinning exception" in
`EXTERNAL_BACKED_SAVES_PLAN.md`.

### Linked collections

A Shelf collection can be linked to one of the reader's own Semble or Margin collections, and the two
stay in step both ways (`services/shelf-link.ts`, migration `0109_shelf_collection_links.sql`). It
reuses the backed-saves read and write paths (`services/backing/read.ts`, `write.ts`), scoped to one
collection, with one change of shape: the Shelf collection stays **canonical** (it has an order the
foreign side doesn't keep, and uploads the foreign side can't hold), so the two are reconciled by
**diff**, not by replacing membership wholesale.

**Import** (Shelf → "Import from Semble or Margin") is the same link in one step, done on the client
(`shelfStore.importLinked`): it creates a Shelf collection under the foreign one's name and
description, then links it; a refused link deletes the new collection again. Foreign collections already linked to a Shelf collection aren't offered.

The client links with `deferSync`, so the link PUT only saves the link (owed a sync) and answers at
once; the dialog closes and the client runs the first sync itself, showing "Syncing…" on the
collection. A sync whose snapshot was cut short by the fetch budget but still brought members in
stays owed, and the client goes round again while that holds, refreshing the saves between rounds,
so a large collection comes in whole in one visit, a share at a time.

The diff's baseline is `shelf_link_members`: every membership record (`collectionLink` /
`collectionItem`) seen at the last reconcile, with the article it resolved to. A reconcile
snapshots the foreign collection with the baseline as `skipLinks` (so it only resolves what's new,
like a room) and then:

1. **Removed there** (a baseline record no longer listed, on a whole listing): the article leaves the
   Shelf collection, unless another record still holds it. The save stays.
2. **Added there** (a listed record not in the baseline): the article becomes a save (a stub,
   extracted later) if it isn't one, and joins the collection at the end, oldest addition first.
   A save made this way starts **archived** (an `archived` label on its rkey), so a linked or
   imported collection fills the Shelf without flooding the Queue's inbox; a save that already
   existed keeps its Queue state. The client pulls the label delta with the saves after a sync.
3. **Removed here** (a baseline record still listed whose article isn't in the collection, including
   a deleted save): the membership record is deleted, never the card or note.
4. **Added here** (a linkable member with no record): one is written. Only on a whole listing with
   at most 3 records unresolved, since an unresolved record could be the same article; the allowance
   is for records that will never resolve (an item in a repo that's gone), which would otherwise
   stop every write for good. Up to 20 per reconcile; the client calls `sync` again while
   `pending` > 0, and the Shelf page says how many are still waiting.

A baseline row changes only once the PDS has answered, so a failed write is simply retried, and no
tombstones are needed. Every foreign write goes through the reconcile, which holds a per-collection
lock (`link_lock_until`, compare-and-set); a local change sets `link_dirty`, which skips the
one-minute gate and sends a running reconcile round again.

It runs: inline when linking, on `POST …/sync` (the client calls it on opening a linked collection;
there's no manual sync button, since opening already does it), and behind the response after a local add/remove/delete-save (at most two
collections per request, sharing its subrequest cap). Not behind `GET /api/shelf/collections`,
which would race the client's sync-on-open. The lock's expiry is also the run's token: every later
write checks it, so a run that outlived its lock, or whose link was changed under it, stops.

Two guards on "removed there": a listing that comes back empty when the baseline had articles
checks the collection record, and a deleted collection unlinks rather than emptying the Shelf
collection. Saves made since linking are keyed (`backfillUrlNormalized`) before anything is
imported, so an article already saved isn't saved twice.

Rules: only the reader's own collection (its DID must match), never the one backing the whole
Library (checked both ways: backing refuses a linked collection too), and at most one Shelf
collection per foreign collection (a partial unique index). Linking
with no `collectionUri` creates one named after the Shelf collection. Unlinking, or deleting the
Shelf collection, leaves the foreign collection as it is.

| Method   | Path                              | Notes                                                     |
| -------- | --------------------------------- | --------------------------------------------------------- |
| `PUT`    | `/api/shelf/collections/:id/link` | `{provider, collectionUri?}`; needs the provider's scopes |
| `DELETE` | `/api/shelf/collections/:id/link` | Stop syncing; both sides keep what they hold              |
| `POST`   | `/api/shelf/collections/:id/sync` | `{force?}`; gated to once a minute unless forced or dirty |

A foreign item added there with a Semble/Margin-backed Library becomes a native-only save (shown by
the backed list like an upload); it isn't also copied into the Library's backing collection.

## UI (first slice, shipped)

- **`/shelf`** (`components/shelf/ShelfPage.svelte`):
  - Collection chips (Everything, each collection, New collection), selected by `?collection=` so a
    reload or link lands on the same one.
  - **Continue reading**: started, not finished (< 97%), most recent first. Driven by the existing
    `readProgress` labels through `getReadActivity`, so no new "last opened" state was needed.
  - Filter by title/author/site, kind (Books / PDFs / Articles), and sort (recently read, recently
    saved, title, author by surname, or the collection's own order).
  - **Covers** (grid) or **List**, remembered per device (`localStorage['skyreader-shelf-view']`).
    A cover is the save's image, or its title set typographically. Books get a spine edge.
  - Items open in the shared reader stack (`?read=`), same as Saved.
- **Saved cards** gain **Add to Shelf / Take off Shelf** and **Add to collection**.
- **Add to collection** is one picker (`ShelfCollectionPicker`, mounted in `AppShell`, driven by
  `shelfStore.openPicker`). Checkboxes apply at once, and a collection can be created from it.
- Nav: **Shelf** sits under Saved in the sidebar, the dropdown and the mobile switcher.

## The Library (second slice, shipped)

Three surfaces showed the same saves (Home, Saved, Shelf) and nothing said how they related, so
Saved and Shelf became the two halves of one **Library**:

- **Queue** is the new name for Saved (`/saved`, unchanged route): Inbox / Archive, newest first.
  **Shelf** keeps `/shelf`. The sidebar, the header dropdown and the mobile switcher show one
  **Library** row (it opens the Queue, and stays lit on either half), with the Shelf's collections
  and then the Queue's saved channels nested under it.
- **`LibraryIntro`** (`components/library/`) opens both pages with a Queue | Shelf switch (it
  first carried a line on what each half is for; that was dropped as noise). It sits in the page body, not the desktop header, so phones get it too.
- **State shows on the item.** A Queue card that's also on the Shelf says **On Shelf**; a Shelf item
  archived in the Queue says **Archived**. Both item menus group their actions under **Queue**
  (Archive / Move to inbox) and **Shelf** (Add / Take off, collections) headings
  (`PopoverMenu`'s `section`), so the two read as independent. Archive behaves the same everywhere:
  it toggles and closes the reader.
- **Home points into the Library.** "Recently saved" links to the Queue, and a new **From your
  Shelf** lane (`HOME_SECTION.shelf`) shows the top of the Shelf in its own order and links to it.
  **Continue reading** uses the Shelf's rule (`isInProgress` in `utils/shelf.ts`): started, under
  97%, and not archived unless it's on the Shelf, so a book put down halfway stays resumable.

Pure helpers (`utils/shelf.ts`: kind, progress, filter, sort, continue reading) are unit-tested.
The page is covered by `e2e/shelf.spec.ts` and the API by `backend/test/shelf-collections.spec.ts`.

### Naming

The surface is the **Shelf** and its groups are **Collections**. "Library" now names the saves as a
whole (Queue + Shelf); the feed stream is just **Feeds** in copy, so the two don't collide.
"Library & privacy" in Settings covers the same saves.

## Next

Ordered by how much they add to "reading should add up":

1. **Item hub page.** A reference's own page: metadata, every highlight and note grouped by
   chapter/page, resume. This is where the Shelf becomes sensemaking rather than storage.
2. ~~**Keep from the reader.**~~ Shipped: the reader bar's Add to Shelf button and ⋯ menu.
3. ~~**Collections in the sidebar.**~~ Shipped: nested under Library, beside the saved channels.
   Drag to reorder is still to do.
4. **Better metadata.** ISBN, authors, year from EPUB OPF metadata, and DOI/title/authors from PDF
   info, with author/year sorting that doesn't depend on the extractor's byline. EPUB cover images.
5. **Share a collection.** ~~Export to Semble/Margin (public)~~ (shipped as linking, above) ~~or open
   as a reading room~~ (shipped: a linked collection's link line carries **Open as room**, and a room
   started from `/rooms` is imported as a linked Shelf collection; see the spike doc's "Rooms and the
   Shelf"). Uploads have no URL, so a shared collection carries only its linkable members,
   and the UI must say so. Always surface that a shared collection is public.
6. ~~**External backing.**~~ Settled by linking: a Shelf collection links to its own Semble/Margin
   collection, independent of whether the Saved list is backed.
