-- Uploaded files behind a save (routes/saved-pdf.ts). A PDF a reader uploads is
-- an ordinary saved_articles row (source 'upload', content_type 'pdf', no URL)
-- carrying the reflowed text; this table holds the original file, which lives in
-- R2 (SAVED_FILES) under r2_key and is served only to its owner.
--
-- rkey:       the save's rkey (saved_articles.rkey); deleting the save deletes this
-- size:       bytes, summed for the plan's storage allowance
-- sha256:     hex digest, so uploading the same file twice opens the first save
-- created_at: ms; counted for the plan's monthly upload allowance
CREATE TABLE IF NOT EXISTS saved_files (
    user_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    filename TEXT,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_did, rkey)
);

CREATE INDEX IF NOT EXISTS idx_saved_files_user_sha ON saved_files(user_did, sha256);
CREATE INDEX IF NOT EXISTS idx_saved_files_user_created ON saved_files(user_did, created_at);
