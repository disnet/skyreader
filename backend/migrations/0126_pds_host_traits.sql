-- What each PDS host readers are on has been seen doing, where implementations
-- differ (services/pds-census.ts). Counts only, accumulated from PDSClient's own
-- responses: whether successful writes carry RateLimit-* headers, what a 429
-- carries, how the host asks for a DPoP nonce, and how it words RecordNotFound.
-- The admin's PDS page reads it alongside the readers on each host, to tell
-- which behaviors the fake PDS's profiles (backend/test/helpers/fake-pds.ts)
-- need to cover.
CREATE TABLE IF NOT EXISTS pds_host_traits (
  host TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  writes_ok INTEGER NOT NULL DEFAULT 0,
  writes_ok_rate_limit_headers INTEGER NOT NULL DEFAULT 0,
  writes_refused INTEGER NOT NULL DEFAULT 0,
  writes_refused_rate_limit_headers INTEGER NOT NULL DEFAULT 0,
  writes_refused_retry_after INTEGER NOT NULL DEFAULT 0,
  nonce_in_body INTEGER NOT NULL DEFAULT 0,
  nonce_header_only INTEGER NOT NULL DEFAULT 0,
  not_found_reference_message INTEGER NOT NULL DEFAULT 0,
  not_found_other_message INTEGER NOT NULL DEFAULT 0,
  -- The last Server header seen (often the reverse proxy's, not the PDS's).
  server TEXT
);
