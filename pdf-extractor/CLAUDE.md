# PDF Extractor

**Important:** Run `npm run check` and `npm test` before finishing work.

A Cloudflare Worker that turns a PDF into reader HTML. It has two callers. The feed proxy's
`/extract`, for a PDF saved by link: the proxy fetches the URL (crawler identity, robots, size
limit, caching, request coalescing all stay there), recognises a PDF
(`feed-proxy/src/pdf-extract.ts`), and posts the bytes here. And the backend's
`POST /api/saved/pdf`, for a PDF a reader uploads (`backend/src/services/pdf-extractor.ts`), which
posts the uploaded bytes with the same secret (the backend's `PDF_EXTRACTOR_SECRET`).

The parse lives in its own Worker, not on the proxy, because pdf.js is CPU-bound and the proxy's
shared Fly vCPUs are not: an ordinary paper ran past the parse timeout once burst credit was spent,
and starved the crawler while it did. It is a separate Worker rather than a route on the API Worker
so a large PDF can't exhaust the API isolate's memory.

## Contract

- `POST /extract` — body is the PDF's bytes (≤ 10 MB), `Authorization: Bearer <EXTRACT_SECRET>`.
  `200` with a `PdfExtraction`; `422 { name, message }` for `PdfPasswordError` /
  `PdfUnreadableError` (the proxy rebuilds those, and falls back to the article extractor on
  unreadable when the PDF was only sniffed); `401`, `413`, `500 { message }` otherwise.
- `GET /health` — `{ status, version }`, used by the deploy smoke check.

`PdfExtraction` is duplicated in `feed-proxy/src/pdf-extract.ts` and
`backend/src/services/pdf-extractor.ts`; change all three together.

## Cost controls

Parses are billed per CPU-ms, so three things bound them:

- **Per plan:** PDFs are a Supporter feature (`TierLimits.pdfSaves`); a free reader's PDF is never
  parsed (the backend sends `allowPdf: false` and rewrites the refusal as an upsell). Uploads also
  have a size cap, a monthly count and a storage allowance (`backend/src/config/tier-limits.ts`).
- **Per reader:** 100 parses a day (`backend/src/services/pdf-quota.ts`), shared by every path into
  the proxy's `/extract` and by uploads. The proxy reports a parse with `X-Pdf-Parsed: 1` and the backend charges
  it; once the day is spent the backend sends `allowPdf: false` and the proxy refuses PDFs without
  calling here. Cache hits are free.
- **Per URL:** the proxy caches a success for 7 days and a failure for 10 minutes.
- **Per parse:** `[limits] cpu_ms = 10000`. Globally, the proxy's `EXTRACT_CONCURRENCY` (4) caps
  parses in flight.

## Layout

- `src/index.ts` — the fetch handler. An entry module may export only handlers (workerd refuses to
  start otherwise), so constants live in `extract.ts`.
- `src/extract.ts` — PDF → `<section data-pdf-page="N">` HTML, with structure inferred from text
  geometry. The page cap (300) and byte cap (1 MB, the save's D1 row) end a parse early and keep
  what was read. There is deliberately no time budget: a Worker's clock doesn't move while it
  computes. Time is bounded by `[limits] cpu_ms` and the proxy's `PDF_EXTRACT_TIMEOUT_MS`.
- `src/pdf-fixture.ts` — builds small PDFs in memory for tests.

Tests run inside workerd (`@cloudflare/vitest-pool-workers`), so they also prove pdf.js works on
Workers.

## Configuration

| Name             | Where                           | Purpose                                                                                                                                               |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXTRACT_SECRET` | `wrangler secret put` (per env) | Same value as the proxy's `PDF_EXTRACTOR_SECRET` Fly secret and the backend's `PDF_EXTRACTOR_SECRET` Worker secret. Unset ⇒ every request is refused. |
| `GIT_COMMIT_SHA` | `--var` from CI                 | Reported on `/health`.                                                                                                                                |

Deployed by `.github/workflows/pdf-extractor-deploy.yml`: staging
(`pdf-extractor-staging.skyreader.app`) on push to main, production
(`pdf-extractor.skyreader.app`) on release. Locally, `scripts/dev-local.sh` runs it on port 8788.
