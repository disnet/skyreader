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

| Method   | Path                                     | Notes                                            |
| -------- | ---------------------------------------- | ------------------------------------------------ |
| `GET`    | `/api/shelf/collections`                 | Every collection with its members, in order      |
| `POST`   | `/api/shelf/collections`                 | `{id, name, description?}`; idempotent on `id`   |
| `PATCH`  | `/api/shelf/collections/:id`             | `{name?, description?, position?}`               |
| `DELETE` | `/api/shelf/collections/:id`             | Removes memberships too; the saves are untouched |
| `POST`   | `/api/shelf/collections/:id/items`       | `{rkey}`; appends; idempotent                    |
| `DELETE` | `/api/shelf/collections/:id/items/:rkey` | Idempotent                                       |
| `PUT`    | `/api/shelf/collections/:id/items`       | `{rkeys}`; named first, unnamed keep their order |

Limits: 200 collections, 2,000 items each, 100-char names, 1,000-char descriptions. Deleting a save
(`DELETE /api/saved/:rkey`, `/by-guid/`) drops its memberships. A member whose save disappears any
other way (a backed-collection snapshot removing it, say) is skipped by the client when it renders.

**Sync.** The set is small, so the client fetches it whole (`shelfStore.load`, once per account per
session, after boot) and caches it in Dexie `metadata` for offline display. Writes are optimistic,
need the network and an account, and **roll back with a toast** on failure rather than queueing. A
reorder or membership change racing another device is resolved by the server's idempotent, merge-y
endpoints, not by a delta. If collections grow or cross-device editing gets busy, the upgrade is a
`?since=` delta like labels'.

### Privacy

Collections and the `kept` label are **private and D1-only**. Nothing here reaches the PDS or a
Semble/Margin backing collection. That matches how uploads already behave (the "native-pinning
exception" in `EXTERNAL_BACKED_SAVES_PLAN.md`). External backing for collections is deliberately
deferred (see below).

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
- **Saved cards** gain **Keep on Shelf / Take off Shelf** and **Add to collection**.
- **Add to collection** is one picker (`ShelfCollectionPicker`, mounted in `AppShell`, driven by
  `shelfStore.openPicker`). Checkboxes apply at once, and a collection can be created from it.
- Nav: **Shelf** sits under Saved in the sidebar, the dropdown and the mobile switcher.

Pure helpers (`utils/shelf.ts`: kind, progress, filter, sort, continue reading) are unit-tested.
The page is covered by `e2e/shelf.spec.ts` and the API by `backend/test/shelf-collections.spec.ts`.

### Naming

"Library" already means the feed library in the app and docs (and "Library & privacy" in
Settings), so the surface is the **Shelf** and its groups are **Collections**.

## Next

Ordered by how much they add to "reading should add up":

1. **Item hub page.** A reference's own page: metadata, every highlight and note grouped by
   chapter/page, resume. This is where the Shelf becomes sensemaking rather than storage.
2. **Keep from the reader.** A Keep / Add to collection control in `SavedReader`'s toolbar, not just
   on cards.
3. **Collections in the sidebar** (nested under Shelf, like saved channels), and drag to reorder.
4. **Better metadata.** ISBN, authors, year from EPUB OPF metadata, and DOI/title/authors from PDF
   info, with author/year sorting that doesn't depend on the extractor's byline. EPUB cover images.
5. **Share a collection.** Export to Semble/Margin (public) or open as a reading room. Uploads have no
   URL, so a shared collection carries only its linkable members, and the UI must say so. Always
   surface that a shared collection is public.
6. **External backing.** Whether a Semble/Margin-backed Saved list should mirror Shelf collections.
   Deferred until sharing (5) has settled what a public collection looks like.
