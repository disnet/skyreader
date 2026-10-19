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
saved (`EXISTS` on `saved_articles.url_normalized`, which has its own index for this). So the table
is the slice of Semble's graph that touches a Library, and any save gets connection news whether
or not it's on Semble. Ends that are AT URIs (a card, not a URL) are skipped.

- `semble_connections`: one row per kept edge, both ends normalized. An update keeps its first
  `indexed_at`; a delete removes the row.
- `semble_connection_seen`: per reader and normalized URL, when they last looked.

A connection is **new** when it was indexed after the reader's last look, or after the save itself
before any look. The reader's own connections never count. There's no backfill: edges drawn before
a save, or before this shipped, aren't news.

## API

- `GET /api/saved/connections` → `{ items: [{ rkey, unseen, latestAt, seenAt }] }`, only saves
  with a connection by someone else.
- `POST /api/saved/connections/seen` `{ rkey }`: the reader looked.

## Frontend

`stores/savedConnections.svelte.ts` loads the list (online, account-only, at most once a minute)
from the Queue and the Shelf. `library/ConnectionsBadge` marks Queue cards and Shelf items. The
Shelf adds a **New connections** lane over the whole Library and a **Recently connected** sort.
Opening a save in the reader clears its mark and hands `AtmospherePanel` the time "new" is
measured from, so the discussion opens on **Connections** with the new edges first and marked.

## Known gaps

- Matching is on `saved_articles` rows. A backed save with no enrichment row yet, or a legacy row
  whose `url_normalized` is still NULL, gets no badge.
- "New" in the panel compares the record's `createdAt` with the last look, while the badge counts
  by `indexed_at`; the two agree except for records published late.
- Later: a connections section in the periodic reading brief (atplan, "A periodic reading brief,
  by email").
