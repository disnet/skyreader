# Rereading: earlier readings and coming back to a piece

From _Creative Reading: Scaffolding Reading for Transformation_ (Liu et al., HT '26): readers
"revisit texts to see how their meaning has changed for us over time," and reading creates the
reader. Skyreader brings back single highlights (the review deck) but treated a piece as read
once. This makes a reread a first-class act, in two parts, built in this order.

## Part 2 (built first): Come back to this

- **Choices:** in 2 weeks, in a month, in 3 months, or a picked day. A day means its start, local
  time (`utils/resurface.ts`).
- **Where:** a save's ⋯ menu in the Queue (`SavedCard`), on the Shelf (`ShelfItem`), and in the reader
  (overflow menu and the phone sheet); and at the end of an article (`ComeBackLater`, above the
  Discussion). In the reader a feed post that isn't saved is saved first (`resurfaceStore.set`
  waits for the row to land, as the Save panel does).
- **Storage:** the `resurface` item label, `props: { at, setAt }`, last write wins, cleared by
  deleting it. Same alias rule as `kept`: reads take the newest across a save's keys, writes go to
  the primary key and any alias already carrying one. Rides the managed-labels delta; no migration.
- **Coming back:** no notification, badge or email. Due saves (archived ones too) show in Home's
  **Back again** lane (`BackAgain.svelte`), longest-waiting first, each saying when the reader
  asked. Opening a due save in the reader clears the label; **Not yet** reopens the picker.
  Nothing is hidden or archived while it waits.
- **Not:** spaced repetition. Intervals don't grow on their own.
- **Later:** a highlight entry point (bring the piece back opened at that passage) and a Queue
  filter.

## Part 1: Earlier readings

- **A reading** is one pass. A piece has a new reading when it's opened after **14 days** with no
  reading activity on it. PDFs count; EPUBs don't (a book is read over many sittings).
- **Storage:** a `readings` item label under the highlights' canonical key,
  `props.readings: [{ startedAt }]`, unioned across devices and alias keys (`mergeReadings`: two
  starts closer than the gap are one return). No label means one reading. A highlight belongs to
  the reading whose window holds its `createdAt`; **Still matters** appends to its `rereadAt`.
  Counted when the reader opens a piece (`noteReadingOpened`), from read progress, read marks, PDF
  places and highlight times.
- **In the reader:** marks from earlier readings in a faded fill, notes dated; a line under the
  title (_Your second reading · first read March 2026_) toggles **Show earlier marks** (on by
  default, remembered per device). **Still matters** stamps an earlier highlight into this reading.
- **At the end:** _Then and now_: how many highlights each time, how many marked both times.
- **Elsewhere:** a Reading facet on the Highlights page, the reading on review-deck cards, and
  `reading` / `readAt` on exported highlights (a change to `ExportSource`, so to the Obsidian
  plugin's `SyncSource` too).
- **Out for now:** reading rooms (being reworked).
- **As built:** the faded fill is a separate pre-mixed ink state (about a third of the tint), so
  text contrast is unchanged and hover still lights a mark to full ink. The title line shows only
  when there are earlier marks. The original-pages view of a PDF draws every mark the same; the
  layers are in the text view. Exported highlights carry `reading`/`readAt`, and the Obsidian
  plugin groups a reread page's highlights under a heading per reading.
