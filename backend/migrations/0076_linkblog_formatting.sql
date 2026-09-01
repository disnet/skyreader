-- Per-user linkblog post formatting.
--
-- How a link post reads on someone else's site is a matter of taste, so the two
-- answers to the "external linkblog formatting" feedback land as preferences
-- rather than hardcoded changes:
--   linkblog_title_style   'link' (🔗 <title>, default) | 'quoted' (“<title>”) | 'plain'
--   linkblog_card_position 'context' (after the quote, default) | 'top' | 'bottom'
--
-- Both are nullable and NULL means "the default", so a deploy that lands ahead of
-- this migration keeps working: getLinkblogFormatting wraps the read in a catch
-- and falls back to the same defaults.
ALTER TABLE user_settings ADD COLUMN linkblog_title_style TEXT;
ALTER TABLE user_settings ADD COLUMN linkblog_card_position TEXT;
