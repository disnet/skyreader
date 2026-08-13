-- Optional existing standard.site publication used for new linkblog posts.
-- NULL means Skyreader's managed skyreader-links publication.
ALTER TABLE user_settings ADD COLUMN linkblog_publication TEXT;
ALTER TABLE user_settings ADD COLUMN linkblog_content_format TEXT;
