# Semble connections on your saves

## Why

Semble's notification feed shows the connections other people draw off the cards you have. That's
news about something you already keep, so in Skyreader it belongs on the item, not in a feed of its
own. A save shows a quiet **new** mark when someone connects something to it, the Shelf gathers
those saves under **New connections**, and opening the save clears the mark.

## Data

Semble's notifications are behind its own login, but connections are public
`network.cosmik.connection` records (`source` and `target` are URLs or AT URIs). The
JetstreamPoller's subscriptions stream also asks for that collection, network-wide, and
`services/semble-connections.ts` keeps an edge only when one of its ends is a URL someone has
saved (`EXISTS` on `saved_articles.url_key`). So the table
is the slice of Semble's graph that touches a Library, and any save gets connection news whether
or not it's on Semble. Ends that are AT URIs (a card, not a URL) are skipped.

`url_key` is its own column, not `url_normalized`: that one is the backing join key, unique per
reader and deliberately NULL on native saves. `url_key` is set on every save insert (`''` for an
upload with no web URL), may repeat, and is backfilled for older saves a batch at a time when the
reader asks for their connections. Edges drawn to a save before its key exists are missed.

Connection writes from the firehose are applied one at a time, in stream order, and settled before
the subscriptions cursor is saved, so a create and a delete in one burst can't land reversed. An
edit that moves an edge off every saved URL deletes the row.

- `semble_connections`: one row per kept edge, both ends normalized. An update keeps its first
  `indexed_at`; a delete removes the row.
- `semble_connection_seen`: per reader and `url_key`, when they last looked.

A connection is **new** when it was indexed after the reader's last look, or after the save itself
before any look. The reader's own connections never count. There's no backfill: edges drawn before
a save, or before this shipped, aren't news.

## API

- `GET /api/saved/connections` → `{ items: [{ rkey, unseen, latestAt, seenAt, newest }] }`, only
  saves with a connection by someone else. `newest` describes up to three of the unseen edges per
  save (`curatorDid`, `direction`, `otherUrl`, `type`, `note`, `indexedAt`), newest first.
- `POST /api/saved/connections/seen` `{ rkey }`: the reader looked.

## Frontend

`stores/savedConnections.svelte.ts` loads the list (online, account-only, at most once a minute)
from the Queue and the Shelf. `library/ConnectionsBadge` marks Queue cards and Shelf items. The
Shelf adds a **New connections** section over the whole Library (`library/NewConnections`), which
says who linked each save to what, with their note: curator names come from the public appview
(`profileService`), and the other end is labelled from its URL (`utils/connectionLabels.ts`), since
the poller keeps no title. It also adds a **Recently connected** sort.
Opening a save in the fullscreen reader clears its mark and hands `AtmospherePanel` the time "new" is
measured from, so the discussion opens on **Connections** with the new edges first and marked.

## Known gaps

- Matching is on `saved_articles` rows, so a backed save with no enrichment row yet gets no badge.
- Only the fullscreen reader clears a mark; a save read in the daily magazine keeps it.
- "New" in the panel compares the record's `createdAt` with the last look, while the badge counts
  by `indexed_at`; the two agree except for records published late.
- Later: a connections section in the periodic reading brief (atplan, "A periodic reading brief,
  by email").
