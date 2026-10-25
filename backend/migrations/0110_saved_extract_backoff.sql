-- Backoff for background extraction of imported saves
-- (services/backing/sync.ts extractMissingBackedContent). A save whose page
-- keeps failing to extract (the site refuses us, it isn't an article) was
-- retried on every saves load forever; now each failure pushes the next try
-- further out, and after the last one it stops. A failure that was ours (the
-- proxy busy or unreachable) doesn't count.
--
-- Its own table, not saved_articles columns: this is the server's bookkeeping,
-- not part of the save, so it stays out of the save's archive record. Keyed by
-- the page, so a save of the same dead page again doesn't start over.

CREATE TABLE IF NOT EXISTS saved_extract_backoff (
  user_did TEXT NOT NULL,
  url_normalized TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  retry_at INTEGER NOT NULL, -- ms; not tried again in the background before this
  PRIMARY KEY (user_did, url_normalized)
);
