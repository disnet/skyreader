-- The pictures a snapshot's body showed, kept with it
-- (services/archive/snapshot-images.ts), so a save keeps its images after the
-- site that hosted them changes or goes away. One row per picture per snapshot;
-- the bytes live in the save's file store (services/saved-file-store.ts), one
-- object per distinct picture in a save, so captures that share a picture share
-- its object.
--
-- snapshot_rkey: the capture it belongs to (saved_snapshots.rkey)
-- save_rkey:     that capture's save; deleting the save deletes these
-- url:           the picture's address as the body gives it, made absolute
--                against the page (the reader asks for it by this)
-- content_type:  the picture's media type
-- sha256, size:  of the bytes kept
-- storage, r2_key, blob_cid, record_uri: where they are kept (as saved_files)
CREATE TABLE IF NOT EXISTS saved_snapshot_images (
    user_did TEXT NOT NULL,
    snapshot_rkey TEXT NOT NULL,
    save_rkey TEXT NOT NULL,
    url TEXT NOT NULL,
    content_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage TEXT NOT NULL DEFAULT 'r2',
    r2_key TEXT NOT NULL,
    blob_cid TEXT,
    record_uri TEXT,
    PRIMARY KEY (user_did, snapshot_rkey, url)
);

CREATE INDEX IF NOT EXISTS idx_saved_snapshot_images_save
    ON saved_snapshot_images(user_did, save_rkey, url);
