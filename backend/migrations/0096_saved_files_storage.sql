-- Which store holds each kept original (services/saved-file-store.ts), so a file
-- can live somewhere other than R2 without a rewrite of the routes that use it.
--
-- storage:    the store: 'r2' (the only one today; r2_key locates the object)
-- blob_cid:   the blob's CID, for a file kept as a blob in the reader's atproto space
-- record_uri: the space record that references that blob
ALTER TABLE saved_files ADD COLUMN storage TEXT NOT NULL DEFAULT 'r2';
ALTER TABLE saved_files ADD COLUMN blob_cid TEXT;
ALTER TABLE saved_files ADD COLUMN record_uri TEXT;
