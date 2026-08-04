-- Persist a subscription's siteUrl (the human-facing home page of the source).
--
-- It was only ever mirrored to the PDS record, so it existed on the device that
-- created the subscription and nowhere else. Linkblogs made that load-bearing: a
-- linkblog connected to an existing publication has an arbitrary rkey, so the
-- publication URI alone can't say "this is a linkblog" — the author's public
-- linkblog page, stored here, is the tell. Without it a followed linkblog reads
-- as a generic "Blog" on any device that didn't create the follow.
ALTER TABLE subscriptions_cache ADD COLUMN site_url TEXT DEFAULT NULL;
