# standard.site documents: off the Fly proxy, into D1

Documents were the last content type where Fly held authoritative state and sat on the
read path. This is the same move feeds already made (`D1_FEED_TIMELINE.md`), applied to
`site.standard.document`: the Jetstream consumer comes back to the `JetstreamPoller`
Durable Object, records land in D1, and reads become plain queries.

## Why the DO and not the proxy

There were two Jetstream consumers in two runtimes — a persistent Bun socket on Fly for
documents, and the DO's poll-drain-disconnect loop for subscriptions — with two cursor
stores, two reconnect implementations and two observability surfaces. The proxy's copy
also derived its `wantedDids` from **read traffic** (`document_cache.last_requested_at`)
while the real subscription set sat in D1, which is exactly the circularity the crawl-set
pull fixed for feeds.

The filter is what makes the DO the better host, not a worse one. A long-lived socket has
to _mutate_ its filter in place as subscriptions change — the ~550 lines of
`options_update` + reconcile machinery on the proxy. The DO reconnects fresh every 60s, so
the filter is just connect-time state read from D1: at most one alarm interval stale, by
construction, with no live-update protocol.

The trade is freshness: ~60s worst case on top of the client's own poll interval. Clients
poll `/api/v2/documents/batch` anyway, and for a calm reading product that is well inside
tolerance.

## Spike handling (five layers)

Big platforms occasionally dump large volumes of standard.site documents. An unfiltered
collection stream would eat all of it, so:

1. **Server-side DID filter, refreshed per cycle** — `wantedDids` as URL params up to
   `DID_URL_PARAM_LIMIT` (150) authors, one `options_update` frame on `open` beyond that
   (a several-kilobyte query string risks a rejected upgrade). Every DID is validated with
   `isValidDid` first: Jetstream rejects the whole frame on one malformed entry and closes
   the socket.
2. **Per-event membership re-check** — every applied event's author is checked against the
   same D1 set before any write. This covers the brief unfiltered window in the frame
   path, and means a filter that is broken or whose semantics change (Jetstream v2)
   degrades to "more parse traffic", never to wrong rows.
3. **Per-cycle apply cap with cursor carry** — `createDocumentDrain` applies at most
   `documents_apply_cap` (500) events per cycle and only ever advances its cursor past an
   event it finished. A burst drains over successive cycles instead of starving the
   subscriptions stream or overrunning the alarm, and slow draining costs latency, not
   data. The cap has a harder twin: the drain also counts the D1 queries it spends and
   stops at `DOCUMENT_DRAIN_QUERY_BUDGET`, because D1 refuses everything past
   `D1_QUERIES_PER_INVOCATION` (1000, counting each statement in a `batch` separately) and
   the drain would meet that ceiling the worst possible way — a throw per event, counted as
   an error, cursor walked over the burst the cap exists to protect. Applying an event is
   one statement for exactly this reason: the cap eviction (layer 4) and the ingest
   bookkeeping are settled once per author at the end of the cycle rather than riding every
   write.
4. **Per-author row cap** — 100 rows, oldest evicted by `published_at`. This is the only
   layer that helps against the dangerous case: an author we _subscribe to_ dumping
   thousands of documents passes the DID filter by design.
5. **Observability + kill switch** — the document stream has its own `streamLagMs`, its own
   Sentry alert, a cap-saturation streak counter surfaced on the admin ops panel, and
   `documents_ingest_enabled` to pause writes without touching reads or the subscriptions
   stream. "Writes" means every background one: the drain, the back catalogues the poller
   pulls for mirrored subscriptions, and the cron's reconcile. Otherwise the switch would
   leave the poller writing up to a hundred rows an author a minute, because the
   subscriptions stream keeps enqueuing DIDs while it is off. The operator backfill
   endpoint is the deliberate exception.

## What's in D1

| Table                   | Holds                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| `documents_v2`          | One row per record: raw `record_json` + queried scalars. PK `record_uri`. |
| `collections_v2`        | Reader-collection sidecars, paired by rkey, with persisted item previews. |
| `publications_cache_v2` | Publication base URL / icon / name / theme / fonts. 24h TTL, 5m negative. |
| `document_authors`      | Per-author last-listed stamp, completeness, last backfill error.          |

The raw record is stored rather than a flattened projection (what 0030 did), so a lexicon
that grows a field needs no migration — the mapper reads it back out.

## Wire compatibility

`/api/v2/documents/batch` keeps the proxy's contract exactly: `ready` / `unchanged` /
`error`, the same `complete` semantics (recomputed per serve from the author's stored row
count, as the proxy did from the set it was about to return — the stored flag alone would
still claim completeness after cap eviction), and a digest computed over the same sorted
`(recordUri, recordCid)` pairs with the same algorithm (parity pinned in
`test/standard-site.spec.ts`). **The frontend does not change.** The one thing that cannot
be reproduced is the proxy's per-author fetch backoff (`errorCount` / `nextRetryAt`); an
author we have never successfully listed reports `error` without them, which keeps a
client holding what it has rather than clearing the scope.

## Self-heal

The proxy self-healed drift by full-replacing its blob on every refresh. Here that's two
things: deletes applied live from the firehose, and a low-frequency reconcile — the hourly
cron re-lists the three stalest authors (`AUTHOR_RECONCILE_INTERVAL_MS`, 7 days), which is
also what closes a hole left by a cursor gap or a paused ingest. A re-list prunes both
documents and reader-collection sidecars the repo no longer has, but only against a
listing that succeeded _and_ was exhaustive — a failed fetch and an author with no
editions produce the same empty result, and pruning on the first would delete everything.

Because the reconcile is the only self-heal, it must never be monopolised: a failed list
holds that author out of the queue for `authorRetryBackoffMs` (1h, doubling per
consecutive failure, capped at the reconcile interval) and sorts them by that failure
rather than by their still-NULL `last_listed_at`. Without both halves, three deleted
accounts at the front of the queue would starve every other author forever, silently.

Cold start is the reconcile's other job, and it is not supposed to have to do it: every
path that creates an `atproto.documents` subscription — the API, the Atmosphere subscribe
button, the Atmosphere graph import, the PDS→local subscription pull, and a subscription
mirrored in by the poller — calls `ensureAuthorDocuments`, which lists the author unless we
hold a fresh listing or are inside their backoff. A subscription whose author has never
been listed serves `status:'error'` on every poll, so leaving that to the reconcile means a
visibly broken linkblog in the meantime.

The two sync paths are the ones that can create many subscriptions at once, and every walk
they schedule runs in the same invocation via `waitUntil` — a dozen of them would exhaust
`D1_QUERIES_PER_INVOCATION` and take down the mirrors scheduled alongside. So each warms
`MAX_SYNC_BACKFILLS` (2) authors and leaves the rest to the reconcile, where an author with
no `document_authors` row already sorts to the front of the queue. That queue is drained by
the every-minute cron at one author a tick as well as by the hourly three, so the tail of a
large restore is minutes rather than an afternoon.

## Rollout

Both switches are `sync_state` rows; flipping either is a D1 write, not a deploy. Operator
steps, the backfill loop, the shadow-compare and the flood response are in
[`RUNBOOK.md` §4e](../RUNBOOK.md). In short: ingest is on by default and fills D1;
`documents_v2_enabled` stays off until a shadow-compare against the proxy is clean and has
soaked; rollback is the same flag set back to `'0'`.

## Still to do

- **Phase 0 measurement.** The apply cap (500) is a strawman sized by reasoning, not by a
  measured burst shape. `documents_apply_cap` exists so it can be tuned from the observed
  `documents_apply_cap_hit` rate without a deploy — clamped at `MAX_DOCUMENT_APPLY_CAP`,
  which is the query budget rather than the burst shape talking: an applied event costs one
  D1 statement (plus, on a publication this cycle has not seen, its metadata resolve), so
  the budget is also the most events any cap could buy. A `cappedBy: 'query-budget'` line
  in `documents_apply_cap_hit` means the cycle's events were costlier than that common
  case — many distinct authors, or cold publications — not that the cap is set too low.
- **`linkblog-site`** still fetches documents from the proxy's `/documents`. It moves to
  the Worker after the prod flag flip, so both apps cut over from the same store.
- **Decommission.** Once the soak passes: remove `DocumentFirehose`, `document_cache`, its
  warm loop and `/documents` serve path, and `standard-site.ts` from the proxy; drop the
  orphaned 0030/0031 tables; retire the admin's proxy-side Document Sync tile.
- **Jetstream v2.** Move the DO to the v2 endpoint and use network replay for gap recovery
  (a cursor older than the buffer becomes a `planSnapshot` instead of a hole). Re-verify
  `wantedDids` semantics there first; if v2 drops them, layer 2 keeps collection-only
  operation correct.
