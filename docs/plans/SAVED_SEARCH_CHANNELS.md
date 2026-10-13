# Saved searches as channels, with calm digests

Goal: a reader saves a query ("anything mentioning PFAS") and gets a channel that fills on its own
as matching items arrive from **any** of their sources, plus an optional daily digest of what
matched. It is a Pro feature and is tracked as the atplan goal _Saved searches as feeds and calm
alerts_. Keyword monitoring is what paid tiers of other readers really sell. For journalists and
analysts it is the reason to pipe everything into Skyreader.

**Done when:** a reader can save a query as a channel. The channel fills from the full text of new
items across every source kind a channel can hold: RSS, newsletters, standard.site documents, and
links shared by the reader's Bluesky follows. The reader can opt into a daily digest of matches.

## Where channels are today

A channel (`FilteredView`, `frontend/src/lib/types/index.ts`) is a **client-side filter that picks
sources**.

- **Source of truth.** The Dexie `filteredViews` table. `channels` in D1 (migration 0049) syncs it
  across devices as a `config` JSON blob. The backend validates the blob as JSON and never reads it
  (`backend/src/routes/channels.ts`).
- **The server is channel-blind.** `/api/v2/timeline` returns everything from the reader's
  subscriptions. `feedView.svelte.ts` then applies `sourceMode`/`sourceKeys`, read, tag and type
  filters in the browser.
- **Rules pick sources, never items.** `autoRule` (category, subscription tag, domain, people…)
  only recomputes `sourceKeys` (`channelLogic.ts`, `channelAutoUpdate.svelte.ts`). Nothing anywhere
  filters an item by its text.

A saved search is a new kind of rule: **a predicate on the item, not the source.** It also needs
the server, for three reasons:

- it must catch items the reader hasn't loaded and never opened;
- the full body often lives in R2, not in the timeline payload;
- the digest has to run with no client open.

## Why the search index can't serve this

`SearchIndex` (`docs/plans/FULL_TEXT_SEARCH.md`) indexes only what the reader has **read, saved or
highlighted**, and read items keep only their first 2 KB. A saved search exists to surface **new,
unread** items, so a query over that index misses exactly the items it is for. Growing the index to
every ingested item for every reader would multiply its storage, which is the dominant cost,
several times over.

What this feature reuses from search is the **query language and the tokenizer**, not the index:

- `parseSearchQuery` (`backend/src/services/search-query.ts`) parses the query;
- matching runs through FTS5 with the same tokenizer (`porter unicode61 remove_diacritics 2`).

A query that finds an item in `/` search therefore matches the same item as a saved search.

## Design: match new items against saved queries (percolation)

Searching an index of items with a query is backwards for alerts. Instead, run every new item past
the saved queries that could see it, once.

### The query lives on the channel

The channel config gains one field, `query: string`, in the same syntax as `/api/search`.

- **The channel's sources still apply.** A query channel is _sources ∩ query_. "PFAS" over all
  sources and "PFAS in my policy feeds" are the same feature.
- **The server reads one field.** When `PUT /api/channels` writes a config that carries `query`, the
  backend parses it and upserts a `saved_queries` row. The rest of the blob stays opaque.

```sql
CREATE TABLE saved_queries (
  user_did TEXT NOT NULL,
  channel_uuid TEXT NOT NULL,
  query TEXT NOT NULL,           -- as typed
  fts_query TEXT NOT NULL,       -- parseSearchQuery output, ready for MATCH
  source_mode TEXT NOT NULL,     -- 'all' | 'include' | 'exclude'
  source_keys TEXT NOT NULL,     -- JSON array, same keys as the channel
  digest TEXT NOT NULL DEFAULT 'off',  -- 'off' | 'daily'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_did, channel_uuid)
);

CREATE TABLE channel_matches (
  user_did TEXT NOT NULL,
  channel_uuid TEXT NOT NULL,
  url_normalized TEXT NOT NULL,  -- one match per story per channel (see dedup)
  item_key TEXT NOT NULL,        -- the key read state already uses
  source_kind TEXT NOT NULL,     -- 'rss' | 'newsletter' | 'document' | 'follows'
  source_ref TEXT NOT NULL,      -- feed_url, document URI or post URI
  matched_at INTEGER NOT NULL,
  published_at INTEGER,
  PRIMARY KEY (user_did, channel_uuid, url_normalized)
);
```

Notes on the schema:

- **Keys stay as keys.** `source_keys` keeps the channel's own keys (`rss~{rkey}`,
  `{rkey}~documents`, `bsky~follows`). The matcher resolves them against `subscriptions_cache` at
  match time. A renamed or recategorised subscription, or an `autoRule` recompute, needs no rewrite
  beyond the channel PUT the client already sends.
- **Deleting a channel** (soft delete) deletes its `saved_queries` row. Its matches age out with
  retention.

### Every source kind, from v1

Each source kind has a different place it keeps text. The matcher reads the **full body** for each:

| Source                         | New items appear in                  | Full text comes from                                                                                            |
| ------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| RSS and Atom                   | `feed_items`, by `seq`               | `item_json` content (≤ 8 KB inline), else the R2 body in `ITEM_BODIES` when `bodyStored` (≤ the stored ceiling) |
| Newsletters                    | `feed_items`, by `seq`               | the same, since intake goes through `ingestBatch`                                                               |
| standard.site documents        | `documents_v2`, by `indexed_at`      | the inflated `content` in `record_json`, falling back to `textContent`                                          |
| Follows links (`bsky~follows`) | `follow_link_shares`, by `shared_at` | the linked article, extracted once per URL (below), plus the post text and card                                 |

**Follows links are the expensive one.** A share row holds only the sharer's words and the link
card. Body matching means extracting the article, which today happens only when a reader opens it.

- **Extract once per URL, not once per reader.** Use the feed-proxy extraction path (the rooms /
  `extractArticle` path). Store the text in R2 keyed by a hash of `url_normalized`, in a new
  `link_bodies` prefix, for 7 days to match share retention. One popular link shared into many
  timelines costs one extraction.
- **Extract only links someone needs.** Only links in the timeline of a reader with a live query
  that covers `bsky~follows` qualify.
- **Cap the work.** A per-reader daily budget (start at 300 extractions) bounds a heavy timeline.
  Past the budget, a link matches on post text and card only, and the match records that it did.
- **Don't wait on extraction.** A link that fails to extract, or isn't extracted yet, matches on
  post text and card immediately. It is re-checked once against the body when the body lands.

Follows links are refreshed on read today (`FOLLOWS_LINKS_PLAN.md`: "no cron"). A reader with a
query covering `bsky~follows` needs a background refresh, or nothing arrives while they're away.
Extend the minute cron to refresh those readers' follows on the existing gate, about every 30 min.
That is a deliberate change to the follows design, limited to Pro readers who opted in by saving
such a query.

**Excerpt-only feeds.** Some RSS feeds ship only a summary. "Full body" means the full text the
source delivers. Skyreader doesn't fetch the page behind every feed item, and v1 doesn't start.
Matching on a page fetched per item is a larger, separate decision (crawl cost, politeness). The
channel UI should say plainly when a feed only sends excerpts. See open questions.

Sources added later (Bluesky lists, feeds and searches; watched pages) plug in as another row in
this table: somewhere new items appear, plus somewhere their text lives.

### The matcher: a sharded Percolator Durable Object

The matcher is one Durable Object class, sharded by a stable hash of the source (`feed_url`,
author DID, or `url_normalized`), starting with 4 shards. Each shard keeps its own cursors over the
four streams and does this per pass:

1. **Pull a page of new items** from each stream past its cursor. The cursors use the same
   lag-behind-now rule as `SearchIndex`, so second-resolution timestamps never skip a row.
2. **Find candidate queries.** Join the page's sources to readers with a `saved_queries` row that
   covers them:

   - RSS and newsletters via `subscriptions_cache`;
   - documents via the documents subscription scope (`resolveDocScopes` logic, ported server-side);
   - follows via the share row's `user_did`.

   **An item with no candidate query is skipped before its body is loaded.** This keeps R2 reads
   and extractions proportional to what Pro readers watch, not to total ingest.

3. **Load bodies** for the remaining items.
4. **Index the batch** into a scratch FTS5 table (`title, author, source, body`) in the DO's own
   SQLite, with the search tokenizer.
5. **Run each candidate query** once against the batch, restricted to the rowids from that reader's
   sources, and write the hits to `channel_matches`.
6. **Clear the scratch table and advance the cursors.** Advancing only after the writes land makes
   a crashed pass replay rather than skip. Match writes are upserts, so a replay is harmless.

Why this shape:

- **Each body is read and tokenized once**, however many readers watch it. A per-reader matcher
  (for example inside each reader's `SearchIndex`) would read a popular feed's R2 body once per
  subscriber.
- **The scratch table is FTS5 itself**, so matching semantics equal `/` search exactly: stemming,
  phrases, prefixes, exclusions. There is no JS port of the tokenizer to drift.
- **The work stays off the ingest hot path.** `ingestBatch` is unchanged. The minute cron nudges
  each shard, and the shard pulls in pages, like `SearchIndex` does. A burst drains over several
  passes, costing latency rather than errors. Target: a match is visible within 5 minutes of
  ingest.
- **D1 budget.** A pass spends at most a fixed share of `D1_QUERIES_PER_INVOCATION` and stops,
  following the documents drain (`DOCUMENTS_TO_D1.md`, "Spike handling").

### Story dedup inside a channel

With every source in v1, one story often arrives several ways: the publication's feed, a newsletter
that quotes it, and three follows sharing it. `channel_matches` keys on
`(channel, url_normalized)`, so a story matches **once per channel**.

- **Order of arrival.** The first source that matches creates the row. Later matches of the same URL
  are recorded as extra sources on it, in a small `channel_match_sources` side table, and never as
  new rows.
- **Display.** The channel shows one card per story: "from _Feed name_ · shared by Maya and 2
  others".

This is deliberately exact-URL dedup. Near-duplicate stories (wire copy on many sites) belong to
the later goal _Mute rules and story deduplication_.

### Reading a query channel

- **API.** `GET /api/channels/:uuid/items?cursor=&limit=` returns the channel's matches, newest
  first, joined to their items (`feed_items`, `documents_v2`, `follow_link_shares`).
  - Each result carries the item in the same shape the timeline and the follows surface already
    serve, plus a snippet: the matched passage, built from the body in the same control-character
    run format as `/api/search`.
  - The response also carries the unread count.
- **Read state** is the existing labels. A match is unread until its `item_key` carries `read`.
- **Frontend.**
  - `feedView` routes a channel whose config has `query` to this endpoint instead of filtering the
    timeline client-side.
  - The channel editor (`FilteredViewModal.svelte`) gains a query field with a live preview: run the
    query through `/api/search` to show "this would have matched these items you've read".
  - A query channel shows in the sidebar like any channel. Unread counts come from the endpoint.
  - Offline: the last fetched page is cached in Dexie like the timeline.

### Backfill: never start empty

A new query channel with nothing in it looks broken. On create, and on any edit of `query` or the
channel's sources:

1. **Seed from search.** Run the query through the reader's `SearchIndex` for items they've already
   read or saved. This is instant and cheap.
2. **Run a per-reader backfill pass.** Same pipeline, reader-scoped, over the last 30 days of each
   covered stream: `feed_items` for their feeds, `documents_v2` for their authors, and their stored
   follows shares (7 days). It runs on the shard alarms with its own cursor, and the channel shows
   "Still looking back through the last 30 days" until it finishes.

An edit replaces the channel's matches. Clearing and re-running is simpler than diffing old and new
predicates, and the backfill bounds the cost.

### Digest: calm, opt-in, in-app first

Never push by default (PRODUCT.md, plan principle "Calm stays true").

1. **v1: in-app.**

   - A query channel can be marked "Include in my daily digest" (`saved_queries.digest = 'daily'`).
   - `/daily` gains a "Your searches" section: matches since the last digest, grouped by channel, top
     5 each with a count of the rest.
   - No notification and no badge beyond the channel's own unread count.

   This meets the done-when on its own.

2. **Email.** Skyreader has no outbound email today: the Worker receives newsletters, and
   `users.marketing_email` is captured but never sent to. The emailed digest therefore waits on a
   shared _Outbound email_ goal, which the _Linkblog as an email digest_ goal needs too.
   - It is one email a day at a reader-chosen local hour, sent only on days with matches.
   - It carries a one-click unsubscribe per channel.

### Gating

- **The flag.** Add `savedSearches: boolean` and `maxSavedSearches: number` (start at 25) to
  `TierLimits` (`backend/src/config/tier-limits.ts`), checked through `getUserTierLimits`.
- **The switch.** The feature sits behind an operator switch, `sync_state.saved_search_enabled`,
  following `search_enabled`.
- **Downgrade.** A reader who loses the tier keeps their channels as ordinary source channels. The
  `saved_queries` rows are disabled, not deleted, so re-subscribing resumes matching. The backfill
  makes up any gap of up to 30 days.

## Rollout

1. **Matcher and storage behind the switch.** Ship `saved_queries`, `channel_matches`, the
   Percolator shards, RSS/newsletter and documents streams, and backfill. Verify on staging with
   seeded queries, comparing every match against `/api/search` over the same items.
2. **Follows links.** Background refresh for opted-in readers, shared extraction cache in R2, the
   per-reader budget, then the follows stream.
3. **Frontend.** The query field in the channel editor with its live preview, the query-channel
   view and unread counts, and the `/daily` section. Add a docs-site page
   (`docs-site/src/content/docs/guide/saved-searches.md`) and its sidebar entry.
4. **Admin.** Per-shard cursor lag, items skipped vs matched, extraction budget use, and a
   per-reader "re-run backfill" action.
5. **Email digest**, after the _Outbound email_ goal lands.

## Cost to measure in step 1

- **R2 reads.** These are only for items that some live query covers. Measure the candidate rate:
  items with at least one candidate query, divided by items ingested.
- **Extractions.** One per distinct followed-shared URL among opted-in readers, capped per reader.
  Needs a baseline from current `follow_link_shares` volume.
- **DO CPU.** Scratch-index plus N queries per batch. The spike should time a 500-item batch with 200
  candidate queries.
- **D1 rows written.** Proportional to matches, not to ingest.

## Open questions

- **Excerpt-only feeds.** Should a query channel offer to fetch full pages for the feeds it covers,
  as a Pro capability with its own budget? This is the one place "full body" isn't met by what
  sources deliver.
- **Field filters.** `title:` and `from:` in the query language would cut noise a lot. Add them to
  `parseSearchQuery` so `/` search gets them too.
- **Retention of matches.** Proposal: keep 90 days, and keep anything read, saved or highlighted for
  good, since those are in `SearchIndex` anyway.
- **Should matches feed the search index?** A matched-but-unread item is arguably "something I
  follow", but indexing it blurs "search what I read". Lean no for v1.
- **Atmospheric sync.** Should a saved query sync to the PDS with the channel? Channels don't today.
  Revisit with the spaces work, since queries can be sensitive (a journalist's beat).
