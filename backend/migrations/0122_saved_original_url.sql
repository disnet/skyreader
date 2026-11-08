-- The link a save had before Skyreader replaced it: a newsletter's click-tracking
-- address, swapped for the article it led to once the text was fetched
-- (services/saved-content.ts). An import of the same export still has the old
-- link, so the importer looks here too and doesn't save the article twice.
-- NULL for every save whose link was never replaced.
ALTER TABLE saved_articles ADD COLUMN original_url TEXT;
