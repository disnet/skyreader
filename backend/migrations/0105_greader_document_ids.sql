-- Item ids for standard.site documents in the Google Reader API (routes/greader.ts).
--
-- Those clients cache an item by its numeric id forever, so an id must never be
-- handed to a second document. documents_v2's rowid can be: it has a TEXT primary
-- key, so deleting the newest row frees its rowid for the next insert.
-- AUTOINCREMENT here never reuses one. A row outlives its document, so a record
-- that comes back keeps its id. Rows are added as the API first lists a document.
CREATE TABLE IF NOT EXISTS greader_document_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_uri TEXT NOT NULL UNIQUE
);
