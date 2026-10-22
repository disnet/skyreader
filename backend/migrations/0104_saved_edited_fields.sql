-- The metadata fields a reader has edited by hand on a save (PATCH
-- /api/saved/:rkey), so a later automated write — an extension re-save
-- upgrading the body, a backed-save upsert, a background extraction filling a
-- stub — doesn't put the extracted value back over theirs. Space-delimited
-- column names with a space at each end (' title author '), matched by
-- services/saved-metadata.ts. NULL = nothing edited.
ALTER TABLE saved_articles ADD COLUMN edited_fields TEXT;
