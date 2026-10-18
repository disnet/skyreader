-- What a save looked like when it was captured (services/archive/snapshots.ts).
-- saved_articles.content is the body the reader reads, and a later capture can
-- replace it (the extension's live-DOM upgrade). A snapshot is immutable: the body
-- as captured, kept in R2 (SAVED_FILES) under r2_key, with its hash and where it
-- came from. Shaped as the future app.skyreader.archive.snapshot record
-- (docs/plans/ARCHIVE_RECORDS.md): one row per capture, keyed by its own TID.
--
-- rkey:         the capture's TID (the record key)
-- save_rkey:    the save it belongs to (saved_articles.rkey); deleting the save
--               deletes its snapshots
-- captured_at:  ms
-- url:          the page captured, '' for an upload
-- content_type: the body's media type ('text/html')
-- sha256:       hex digest of the body; a capture identical to the save's latest
--               one is not stored again
-- size:         bytes
-- method:       how the body was captured: 'live-dom' (the browser extension,
--               from the open tab), 'server' (Skyreader fetched the page),
--               'feed' (the feed's own body), 'record' (an atproto document),
--               'upload' (text read from an uploaded file). NULL when unknown.
CREATE TABLE IF NOT EXISTS saved_snapshots (
    user_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    save_rkey TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    url TEXT NOT NULL,
    content_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    method TEXT,
    PRIMARY KEY (user_did, rkey)
);

CREATE INDEX IF NOT EXISTS idx_saved_snapshots_save
    ON saved_snapshots(user_did, save_rkey, captured_at);
