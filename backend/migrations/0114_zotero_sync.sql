-- Zotero sync (services/zotero.ts): a reader's Zotero library, connected with an
-- API key they made at zotero.org, and the items Skyreader made in it.

CREATE TABLE IF NOT EXISTS zotero_connections (
  user_did TEXT PRIMARY KEY,
  -- The API key, sealed under the ZOTERO_KEY_SECRET Worker secret
  -- (utils/secret-box.ts), so reading D1 doesn't hand it out.
  api_key_sealed TEXT NOT NULL,
  zotero_user_id TEXT NOT NULL,
  zotero_username TEXT,
  -- 'everything' (every save and highlighted page) or 'collections' (the
  -- saves in the Shelf collections listed in `collections`, a JSON array).
  scope TEXT NOT NULL DEFAULT 'everything',
  collections TEXT NOT NULL DEFAULT '[]',
  -- The "Skyreader" collection made in the reader's Zotero library.
  zotero_collection_key TEXT,
  -- Highlight-label seconds: what's changed since is sent on the next sync.
  cursor INTEGER NOT NULL DEFAULT 0,
  -- A lease, so the cron and "Sync now" never run one reader's sync at once.
  sync_started_at INTEGER,
  -- Bumped when the scope or library changes: a sync begun before can't then
  -- move the cursor past pages the new scope still has to send.
  generation INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zotero_connections_due ON zotero_connections(last_sync_at);

-- One row per key a page goes by (ExportSource.keys), each naming the same
-- Zotero item, so a page highlighted and then saved stays one item.
CREATE TABLE IF NOT EXISTS zotero_items (
  user_did TEXT NOT NULL,
  source_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  -- Skyreader's child note of highlights, and what it last said.
  note_key TEXT,
  note_version INTEGER,
  note_hash TEXT,
  -- The reader deleted the item in Zotero: it isn't made again.
  dropped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_did, source_key),
  FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zotero_items_item ON zotero_items(user_did, item_key);
