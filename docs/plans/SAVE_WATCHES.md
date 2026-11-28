# Watch for updates on saves

## Why

Semble connections already reach every save off the firehose
([SEMBLE_CONNECTIONS.md](SEMBLE_CONNECTIONS.md)). The rest of what happens to a page after it's
saved (people posting it, a paper being cited) costs a request to find out, so it's asked only for
saves the reader switches **Watch for updates** on. Free plans watch 5, Supporters 1,000
(`TierLimits.maxWatchedSaves`).

## Data

- `save_watches`: one row per watched save (reader, rkey, `url_key`), with `seen_at` for the last
  clear. Rows of deleted saves are swept hourly (`pruneSaveWatches`), since saves are deleted down
  several paths.
- `watch_targets`: one row per watched normalized URL, however many readers watch it. Holds the
  baselines a check compares with: `mention_counts` (lane → distinct people) and `citations`, plus
  the DOI (`idsFromUrl(url).doi ?? exactDoi(saved.doi)`, so an arXiv save has its DataCite DOI).
  NULL baselines mean "not settled yet": the first settled check only records, so turning Watch on
  never reports what was already there.
- `watch_events`: what a check found. `kind` `mentions` (with `lane`) or `citations`, `count` more
  people or works, `detail` naming up to three, and `baseline_at`, when the counts it grew from
  were taken. Kept 90 days.

An update is **new** to a reader when it arrived after their watch's `seen_at` (or its start) and
its `baseline_at` is after their watch began, so joining a URL someone else already watches never
reports what was there before. Clearing sends the newest update shown (`until`), so one that landed
since stays new. The cap is checked again inside the insert, so racing requests can't pass it.

## Checks

The minute cron queues due targets (`enqueueDueWatchChecks`, 50 a minute per kind) as
`watch.check` jobs on the `JOBS` queue:

- **Mentions, ~daily** (`MENTION_CHECK_MS`, 25 targets a job). One `POST /mentions` to the feed
  proxy with `maxAgeMs` 6 h (`MENTION_MAX_AGE_MS`, the proxy's floor), instead of the read-gated
  weekly recheck. The proxy answers from its cache and refreshes in the background (`pending`,
  with `checkedAt`); counts older than 6 h are read again after `REQUEUE_MS` rather than compared,
  and a cold URL is never settled empty. Lanes reported: `bluesky`, `leaflet`, `linkblog`,
  `margin`; Semble has its own lane. A lane that grew gets one `/mention-lane` call for the newest
  people since the baseline.
- **Citations, ~weekly** (`CITATION_CHECK_MS`, 10 targets a job), for targets with a DOI.
  OpenAlex `GET /works/doi:<doi>` (`cited_by_count`; single lookups are free), and only on a rise
  `GET /works?filter=cites:<id>&sort=publication_date:desc` for the newest three. The key is the
  `OPENALEX_API_KEY` secret; without it the keyless allowance applies, which is much smaller.

## API

- `GET /api/saved/watches` → `{ items: SaveWatch[], limit }`: every watched save, with `unseen`,
  `latestAt` and up to six `events`.
- `POST /api/saved/watches` `{ rkeys, watch }` → `{ watched, refused: [{ rkey, reason }], limit }`,
  `reason` one of `not_found`, `no_url` (an upload), `limit`.
- `POST /api/saved/watches/seen` `{ rkeys }` or `{ all: true }`.

## Frontend

`stores/savedWatches.svelte.ts` holds the list (online, account-only, at most once a minute).
The switch is in `SaveToLibraryPanel` under Shelf, in Queue and Shelf item menus, and as **Watch**
in the selection bar. `library/WatchedUpdates` is the **Updates on what you're watching** lane on
the Shelf and on Home (`HOME_SECTION.watching`), one line per event (`utils/watchEvents.ts`).
`library/WatchBadge` marks cards. The bell shows one entry per UTC day with news
(`watch:<date>`), linking to the Shelf.

## Cited by

A paper's discussion also lists the works already citing it, watched or not, saved or not
(`GET /api/papers/citations?doi=`, `services/paper-citations.ts`, signed-in only). The free
`/works/doi:` lookup gives the id and `cited_by_count`; only a paper with citations costs a list
call (`filter=cites:<id>`, `sort=cited_by_count:desc`, ten works with authors and venue). Answers
are cached per lowercased DOI in `paper_citations`, shared by every reader: a week for a paper
OpenAlex knows, a day for one it doesn't, never a failure (a stale row is served instead). The
route allows 20 lookups a minute per reader, and rows a month past their fetch are swept hourly.

The frontend asks when the discussion opens (`stores/paperCitations.svelte.ts`, once per DOI a
session); `AtmospherePanel` shows a **Cited by** tab beside Conversation when OpenAlex listed any.
A citing work the reader saved, in any version (`paperKey`), opens in the reader.

## Later

- New paper versions (arXiv versions list, Crossref `has-preprint` / `is-version-of`), on top of
  DOI joining.
- A weekly "news on your saves" section in the reading brief, by email.
- Watching a whole collection.
