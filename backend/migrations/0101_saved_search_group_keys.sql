-- Saved searches that pick their sources by group (`group~newsletters`,
-- `group~category~…`) covered nothing until the matcher learned group keys:
-- their look back ran over no sources and stopped. Run it again. Leaving
-- updated_at alone keeps any in-flight pass's guard intact.
UPDATE saved_queries
   SET backfill_state = 'pending', backfill_feed_after = '', backfill_doc_after = '',
       backfill_follows_after = ''
 WHERE source_mode <> 'all' AND source_keys LIKE '%group~%';
