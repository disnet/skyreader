-- The works citing a paper, as OpenAlex lists them, for the Cited by tab under
-- a paper (services/paper-citations.ts). One row per DOI (lowercased) however
-- many readers open it: a list call counts against the OpenAlex key's daily
-- budget, so it's asked at most once a week per paper (a day for one OpenAlex
-- doesn't know). Rows a month past their fetch are swept hourly.
--
-- `total` is OpenAlex's cited_by_count; `works` (JSON) the most-cited few;
-- `openalex_id` NULL when OpenAlex has no work under the DOI.
CREATE TABLE paper_citations (
  doi         TEXT PRIMARY KEY,
  openalex_id TEXT,
  total       INTEGER NOT NULL,
  works       TEXT,
  fetched_at  INTEGER NOT NULL
);
CREATE INDEX idx_paper_citations_fetched_at ON paper_citations (fetched_at);
