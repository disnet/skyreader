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

The schema is `backend/migrations/0098_saved_searches.sql`:

- **`saved_queries`**, one row per query channel. It holds:
  - the query as typed, and its `fts_query` (the `parseSearchQuery` output);
  - `source_mode` and `source_keys`, copied from the channel;
  - `digest`;
  - the backfill state and cursors (below).

  `updated_at` doubles as the row's version.

- **`channel_matches`**, one row per story per channel, keyed `(user_did, channel_uuid, dedup_key)`.
  - `dedup_key` is the normalized URL, else `item:<item_key>`.
  - The row also carries `item_key` (what read state is filed under), `source_kind` (`feed` or
    `document`) and `source_ref` (feed URL or author DID).
  - It stores `feed_seq` for joining back to the item.
  - The **snippet** is stored at match time, taken from the scratch index, which already has the
    body tokenized.
  - `published_at` (falling back to match time) and `matched_at`.

Notes on the schema:

- **Keys stay as keys.** `source_keys` keeps the channel's own keys (`rss~{rkey}`,
  `{rkey}~documents`, `bsky~follows`). The matcher resolves them against `subscriptions_cache` at
  match time. A renamed or recategorised subscription, or an `autoRule` recompute, needs no rewrite
  beyond the channel PUT the client already sends.
- **Deleting a channel** (soft delete) deletes its `saved_queries` row and its matches.
- **Sync reads back from D1.** `syncSavedQueries` reconciles from the `channels` rows after the
  write, not from the request body. A PUT that loses to a tombstone therefore never resurrects a
  query.
- **What an edit resets.** A change to the query or the source selection clears the channel's
  matches and restarts its backfill. A change to the digest alone keeps them.

### Every source kind, from v1

Each source kind has a different place it keeps text. The matcher reads the **full body** for each:

| Source                         | New items appear in                  | Full text comes from                                                                                            |
| ------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| RSS and Atom                   | `feed_items`, by `seq`               | `item_json` content (≤ 8 KB inline), else the R2 body in `ITEM_BODIES` when `bodyStored` (≤ the stored ceiling) |
| Newsletters                    | `feed_items`, by `seq`               | the same, since intake goes through `ingestBatch`                                                               |
| standard.site documents        | `documents_v2`, by `indexed_at`      | `textContent` in `record_json` (what search indexes), falling back to `description`                             |
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

### The matcher: a Percolator Durable Object

The matcher is one Durable Object class (`backend/src/durable-objects/percolator.ts`).

- **One instance today** (`percolator-0`). Each body is read once however many readers watch it, so
  one instance carries Pro-scale load.
- **Sharding**, if its CPU stops keeping up, splits the streams by `seq` modulo. Nothing else
  changes.
- **Cursors.** The instance keeps a cursor per stream. A fresh instance, or one with no live
  queries, starts at the streams' heads rather than replaying the archive.

Each pass does this:

1. **Pull a page of new items** from each stream past its cursor.
   - `feed_items.seq` is a commit-ordered autoincrement.
   - The `documents_v2` cursor `(indexed_at, record_uri)` stays 2 s behind now. That way a row
     written in the same millisecond with a smaller URI is never passed.
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
  the matcher, which pulls in pages, like `SearchIndex` does. A burst drains over several
  passes, costing latency rather than errors. Target: a match is visible within 5 minutes of
  ingest.
- **D1 budget.** A pass spends at most 600 of an alarm's 1,000 subrequests, counting D1
  statements and R2 reads, and then stops. This follows the documents drain (`DOCUMENTS_TO_D1.md`,
  "Spike handling"). R2 body reads are capped at 50 a pass; past that, an item matches on its 8 KB
  inline text.
- **Edits mid-pass.** Every match insert is guarded on the query's `updated_at` still being the
  version the pass loaded. An edit made during a pass clears the channel's matches, and hits for
  the old predicate can't be written back over it. Backfill progress is guarded the same way.

### Story dedup inside a channel

With every source in v1, one story often arrives several ways: the publication's feed, a newsletter
that quotes it, and three follows sharing it. `channel_matches` keys on
`(channel, url_normalized)`, so a story matches **once per channel**.

- **Order of arrival.** The first source that matches creates the row, and later matches of the same
  URL never add a row. Recording them as extra sources, in a small `channel_match_sources` side
  table, lands with follows links (rollout step 2), where it first matters.
- **Display.** The channel shows one card per story: "from _Feed name_ · shared by Maya and 2
  others".

This is deliberately exact-URL dedup. Near-duplicate stories (wire copy on many sites) belong to
the later goal _Mute rules and story deduplication_.

### Reading a query channel

- **API.** `GET /api/channels/:uuid/items?before=&limit=` (`backend/src/routes/channel-items.ts`)
  returns the channel's matches, newest first, joined to their items.
  - A feed match carries the item in the timeline's shape. A document match carries its URI, URL,
    title and description.
  - Every match carries its stored snippet, as `/api/search`'s `{ text, match }` runs.
  - The response also carries:
    - the unread count, capped at 1,000;
    - `backfilling`;
    - `status`: `over_limit` past the plan's count;
    - `nextCursor` (`<publishedAt>:<dedupKey>`).
  - Status codes: 404 while the switch is off; 403 `upgrade_required` without the plan; 404
    `not_saved_search` for a channel with no query.
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

- **Same pipeline, reader-scoped.** It covers the last 30 days of each covered stream:
  - the most recent 50 items of each of the query's feeds, through
    `idx_feed_items_feed_published_seq`;
  - the same for each of its document authors;
  - later, their stored follows shares (7 days).
- **Pacing.** Each pass moves up to 4 pending queries forward by 10 sources each. Progress is two
  cursors on the row (`backfill_feed_after`, `backfill_doc_after`). The channel shows "Still looking
  back through the last 30 days" while `backfilling` is true.
- **No seeding from `SearchIndex` yet.** Anything read in the last 30 days is in the backfill
  already. Seeding older read and saved items from search is a small follow-up if the empty-start
  case shows up.

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

- **The limit.** `maxSavedSearches` in `TierLimits` (`backend/src/config/tier-limits.ts`): 0 on
  free, 25 on Supporter. The repricing goal will move it to Pro.
- **The switch.** The feature sits behind an operator switch, `sync_state.saved_search_enabled`,
  following `search_enabled`. `GET /api/auth/me` reports it as `savedSearchEnabled`.
- **Downgrade.**
  - **Losing the plan.** The reader's queries stay in `saved_queries` but stop matching, since the
    matcher only loads queries on entitled tiers. Re-subscribing resumes matching.
  - **Over the count.** Past the plan's count, the oldest queries keep matching and the newer ones
    wait.
  - **The gap.** No match fills in the time a query wasn't matching; an edit re-runs the 30-day
    backfill.

## Rollout

1. **Matcher and storage behind the switch.** _Built:_
   - `saved_queries`, `channel_matches` and the Percolator;
   - the RSS/newsletter and documents streams, and backfill;
   - the items endpoint, the tier limit and the `/api/auth/me` flag.

   _Next:_ verify on staging. Seed queries, then compare their matches against `/api/search` over
   the same items.

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
