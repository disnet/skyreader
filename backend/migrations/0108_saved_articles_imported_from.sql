-- Saves brought in from another read-later app (routes/saved-import.ts).
--
-- `imported_from` names the app ('pocket', 'omnivore', 'instapaper', 'readwise',
-- 'matter'); NULL for every save made in Skyreader. It does two jobs:
--   - an imported save doesn't count against the monthly URL-save limit, which
--     is about what a reader saves now, not the library they arrive with;
--   - an imported save arrives without its text, and this is how the extract
--     passes find the ones still waiting for it (content IS NULL).
ALTER TABLE saved_articles ADD COLUMN imported_from TEXT;
