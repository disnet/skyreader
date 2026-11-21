-- Where a save came from: the article the reader was in when they saved a link
-- out of it (the reader's link menu). Private, like the rest of a save: it never
-- reaches the PDS or a Semble/Margin backing collection. Lets a save say "From
-- <article>", an article list the links saved from it, and the Library filter
-- to one reading session. NULL for every save made any other way, and for every
-- save made before this column.
--
-- Matched to an article on the client, over the saves it already holds, by
-- normalized URL (urlKey), so no index or key column is needed here.
ALTER TABLE saved_articles ADD COLUMN saved_from_url TEXT;
ALTER TABLE saved_articles ADD COLUMN saved_from_title TEXT;
