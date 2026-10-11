# Spike: per-user FTS5 search index in a Durable Object

This spike tests the storage design for the atplan goal _Full-text search over everything read_
(skyreader-power-readers plan). The design is one SQLite-backed Durable Object per user, holding an
FTS5 index of the items that user has read, saved or highlighted, plus their notes.

This is not production code and it is never deployed. `worker.ts` generates a synthetic corpus
inside the DO so that seeding doesn't send hundreds of MB over HTTP. `bench.mjs` seeds the corpus
and times queries. To reproduce, run `./run.sh 50000` or `./run.sh 100000` from this directory
after `npm ci` in `backend/`.

## Corpus

The corpus follows the tiered index plan:

| Share | Kind        | What's indexed                                       |
| ----- | ----------- | ---------------------------------------------------- |
| 85%   | read only   | title, author, feed, about 2 KB of body              |
| 12%   | saved       | the same, with full body (8–30 KB)                   |
| 3%    | highlighted | the same, plus 0.3–1.2 KB of highlight and note text |

The words are pseudo-words drawn from a Zipf(1.07) distribution over a 40k vocabulary. Query
terms are picked by frequency rank: rank 5 appears in nearly every doc, 200 is common, 3000 is
mid-frequency and 20000 is rare.

Each query ranks every match with bm25, using column weights title 10, author 3, feed 2, body 1
and notes 5, plus a boost for saved and highlighted items. It returns the top 20 and counts total
matches up to 1,001, which the UI would show as "1,000+".

## Variants

- **`ext`**: external-content FTS5 over a `docs_text` table. `snippet()` and highlighting work.
- **`less`**: contentless FTS5 (`contentless_delete=1`). The text isn't stored, so there's no
  `snippet()`; snippets would have to be built from the source text at query time.
- **`ext_col`**: `ext` with `detail=column`. Dropped after the 50k run because it was slower and
  phrase queries are an error with this setting.

## Results

Timings are measured inside the DO with `performance.now()` around the SQL, on local workerd
(wrangler 4.125). "rtt" is the full HTTP round trip from the driver.

### Size

| Docs | Indexed text | `ext` DB   | `less` DB  | `ext_col` DB |
| ---- | ------------ | ---------- | ---------- | ------------ |
| 50k  | 222 MB       | 429 MB     | 125 MB     | 363 MB       |
| 100k | 445 MB       | **860 MB** | **250 MB** | —            |

Seeding ran at about 1,600 docs/s in 1,000-doc batches for every variant.

### Query p95 at 100k docs, in ms (inside DO, then rtt)

| Query                 | `ext`     | `less`    |
| --------------------- | --------- | --------- |
| very common term      | 127 / 135 | 128 / 136 |
| common term           | 37 / 44   | 34 / 43   |
| mid term              | 8 / 15    | 6 / 14    |
| rare term             | 3 / 10    | 1 / 9     |
| two terms AND         | 7 / 16    | 6 / 14    |
| three terms AND       | 12 / 18   | 7 / 13    |
| phrase                | 13 / 23   | 11 / 19   |
| prefix (`abc*`)       | 280 / 288 | 96 / 104  |
| title column          | 2 / 8     | 1 / 12    |
| notes column          | 8 / 15    | 4 / 17    |
| OR of two rare terms  | 5 / 11    | 3 / 9     |
| common + saved only   | 29 / 36   | 17 / 24   |
| common + last 90 days | 19 / 27   | 12 / 21   |

Deletes leave no FTS rows behind in either variant. That covers the write paths the real index
needs for an unsave (re-tier) and a label tombstone (remove).

## Findings

1. **FTS5 works in DO SQLite**, including `contentless_delete=1`, which needs SQLite 3.43 or
   later. `sqlite_version()` isn't on the DO function allowlist, so it can't be called.
2. **Latency is not the constraint.** At 100k items, the worst case (a 3-letter prefix that
   matches 1,000+ docs) is under 300 ms p95. Typical queries take 5–40 ms. The goal's "under a
   second" leaves a lot of headroom, which a slower production disk and cold starts have to fit
   in (see open items).
3. **Never put `snippet()` in the ranked SELECT.** SQLite evaluates it for every matching row
   before sorting. The first 50k `ext` run did this and was up to 5× slower on common terms (for
   example, a common term at 70 ms p95 versus 23 ms). Rank first, then call `snippet()` for only
   the page's rowids, as `query()` does now. Use column `-1` so the snippet comes from whichever
   column matched.
4. **Also cap the match count.** A plain `count(*)` over a term found in nearly every doc costs
   about as much as the ranking. `LIMIT 1001` inside the count keeps it cheap.
5. **The main tradeoff is size versus snippets.**
   - External content costs about 3.4× more storage: 860 MB versus 250 MB per 100k items.
   - In return, it gives snippets and highlighting with no extra work.
   - With contentless, each result page would re-fetch the bodies of 20 results from D1, R2 or
     `saved_articles`.
   - Both are well under the 10 GB per-DO limit.
   - At DO SQLite storage pricing (about $0.20/GB-month at the time of writing), the difference
     is roughly $0.12/month for a 100k-item reader.
6. **`detail=column` is a worse option on every measure here.** It saved only 15% of size, was
   about 10× slower on common terms (bm25 and the kind filter need positions it no longer keeps),
   and can't run phrase queries.
7. **Confirmed: D1 can't export a database that contains FTS5.** `wrangler d1 export --local`
   fails with `D1 Export error: cannot export databases with Virtual Tables (fts5)`. Putting the
   index in the main `skyreader` D1 would break whole-database exports, so that option is ruled
   out regardless of size.

## Recommendation

- Build the index as a per-user SQLite DO with **external-content FTS5**.
- Rank first, then snippet only the page, and cap the match count.
- Move a user's index to contentless (keeping text only for saved and highlighted items) only if
  storage cost per Pro user becomes a real line item. The schema change is internal to the DO and
  the index can be rebuilt.

## Open items for the build, not this spike

- Production numbers are still needed, since the DO's disk and its cold start differ from local
  workerd. Measure p95 on staging with a seeded 100k-item DO before calling the goal done.
- Backfill throughput was about 1,600 docs/s of DO CPU. A 100k-item history is about a minute of
  work, so run the backfill as alarm-driven batches of about 1–2k docs, not one invocation.
- Real text compresses and stems differently from pseudo-words. The porter tokenizer's effect on
  recall should be checked against a real corpus, such as the dev archive.
