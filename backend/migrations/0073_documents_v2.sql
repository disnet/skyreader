-- standard.site documents move from the Fly proxy's SQLite blob cache into D1.
--
-- The 0030 `documents` table predates `content`, `links`, `skyreaderLinkblog` and
-- reader collections, and stored a flattened projection of the record. These
-- tables keep the raw record instead (`record_json`) plus the scalars we query on,
-- so a lexicon that grows a field needs no migration — the mapper reads it out of
-- the stored record. 0030/0031 stay orphaned until the proxy path is decommissioned.

-- One row per `site.standard.document` record. `record_uri` is the natural key:
-- Jetstream gives us create/update/delete keyed by (did, collection, rkey), which
-- is exactly the URI, so an upsert is a single statement with no read first.
CREATE TABLE IF NOT EXISTS documents_v2 (
    record_uri TEXT PRIMARY KEY,
    author_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    record_cid TEXT NOT NULL,
    -- The `site` field verbatim: an at:// publication URI, a loose https:// site,
    -- or '' for a freestanding document. Publication scoping filters on it.
    site_uri TEXT NOT NULL DEFAULT '',
    -- ms epoch, resolved from the record's publishedAt (falling back to ingest
    -- time). Drives both the serve order and the per-author cap eviction.
    published_at INTEGER NOT NULL,
    -- Resolved at write time from the publication's base URL. Re-derived at read
    -- time when publication meta is fresher, so a repaired publication cache fixes
    -- served URLs without rewriting rows; this column is the durable fallback and
    -- the lookup key for URL-keyed joins.
    canonical_url TEXT,
    record_json TEXT NOT NULL,
    indexed_at INTEGER NOT NULL,
    updated_at INTEGER
);

-- The serve path is always "this author, newest first" (then scoped by site).
CREATE INDEX IF NOT EXISTS idx_documents_v2_author_published
    ON documents_v2(author_did, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_v2_canonical ON documents_v2(canonical_url);

-- `app.standard-reader.collection` sidecars: a curated magazine edition, paired to
-- its `site.standard.document` by shared rkey. Item previews (cross-PDS getRecord
-- fan-out) are resolved lazily in a request context and persisted here, so the
-- fan-out happens once per edition rather than inside the poller's alarm.
CREATE TABLE IF NOT EXISTS collections_v2 (
    author_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    record_json TEXT NOT NULL,
    preview_json TEXT,
    preview_at INTEGER,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (author_did, rkey)
);

-- Publication metadata (base URL / icon / name / theme / fonts) resolved from
-- `site.standard.publication` + its `app.standard-reader.publicationTheme` sidecar.
-- Replaces the 0031 table, which cannot hold a negative cache entry (its base_url
-- is NOT NULL) and has no theme/fonts columns.
CREATE TABLE IF NOT EXISTS publications_cache_v2 (
    publication_uri TEXT PRIMARY KEY,
    base_url TEXT,
    icon TEXT,
    name TEXT,
    theme TEXT,
    fonts TEXT,
    cached_at INTEGER NOT NULL
);

-- Per-author ingest bookkeeping: when we last listed the author's repo (the
-- self-heal reconcile picks the stalest), and the last backfill error so the serve
-- path can report `status:'error'` for an author we have never successfully read
-- instead of silently serving an empty list.
CREATE TABLE IF NOT EXISTS document_authors (
    author_did TEXT PRIMARY KEY,
    last_listed_at INTEGER,
    last_event_at INTEGER,
    -- 1 when the last successful list returned fewer than the per-author cap, i.e.
    -- the stored set is the author's complete repo (what the batch response's
    -- `complete` flag reports).
    complete INTEGER NOT NULL DEFAULT 0,
    -- Curated editions the last walk could not afford to write. Non-zero keeps the
    -- author in the reconcile queue despite a fresh `last_listed_at`, so a back
    -- catalogue's sidecars land over the next passes rather than one walk's worth
    -- per reconcile interval.
    collections_pending INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_document_authors_listed ON document_authors(last_listed_at);
