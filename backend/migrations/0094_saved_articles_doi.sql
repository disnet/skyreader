-- The DOI a saved page names for itself in its <head> (citation_doi,
-- dc.identifier, prism.doi), read off the live page when it's saved. Exports
-- cite a save by it (services/export/identifiers.ts); a publisher page whose
-- URL doesn't carry the DOI has no other place it shows up once extracted.
-- NULL for every save from before this column, and for pages that name none.
ALTER TABLE saved_articles ADD COLUMN doi TEXT;
