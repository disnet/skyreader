-- Whether a stored document's body is still offloaded to a blob (a Leaflet
-- `blobPages` or Offprint `blob` stub the ingest hasn't inflated yet).
--
-- Inflating a stub rewrites `record_json` but not `record_cid`, so a scope digest
-- over (uri, cid) alone never moved and a reader who cached the stub kept it. The
-- digest folds this flag in; it lives in a column so the steady-state digest
-- pre-check can read it without parsing every row's `record_json`.
ALTER TABLE documents_v2 ADD COLUMN body_offloaded INTEGER NOT NULL DEFAULT 0;

-- The LIKE skips parsing rows that can't be stubs. `json_valid` first, because
-- `json_extract` throws on a record nested past SQLite's depth limit, which
-- ingest stores as-is, and one such row would fail the migration and the deploy.
-- `!= ''` matches `needsBlobInflation`'s truthy-cid test.
UPDATE documents_v2 SET body_offloaded = 1
 WHERE record_json LIKE '%"blob%'
   AND json_valid(record_json)
   AND ((json_extract(record_json, '$.content.$type') = 'pub.leaflet.content'
         AND json_extract(record_json, '$.content.blobPages.ref.$link') != '')
     OR (json_extract(record_json, '$.content.$type') = 'app.offprint.content'
         AND json_extract(record_json, '$.content.blob.ref.$link') != ''));
